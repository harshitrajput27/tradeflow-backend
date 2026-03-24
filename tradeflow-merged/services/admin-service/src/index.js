const express = require('express');
const jwt     = require('jsonwebtoken');
const multer  = require('multer');
const path    = require('path');
const { query, transaction } = require('../../../shared/db/pool');
const { cacheGet, cacheSet, cacheDel } = require('../../../shared/redis/client');
const { createProducer, publishMessage, TOPICS } = require('../../../shared/kafka/client');

const app = express();
app.use(express.json());

let kafkaProducer;
(async () => { kafkaProducer = await createProducer('admin-service-producer'); })();

// ─── Admin auth middleware ────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    req.admin = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}
app.use('/api/admin', adminAuth);

// ─── File upload (KYC documents) ─────────────────────────────────────────
const upload = multer({
  dest: '/tmp/kyc-uploads/',
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.pdf'];
    cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
  },
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// DASHBOARD STATS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// GET /api/admin/stats
app.get('/api/admin/stats', async (req, res) => {
  const cacheKey = 'admin:stats';
  const cached = await cacheGet(cacheKey);
  if (cached) return res.json(cached);

  try {
    const [users, orders, trades, kyc] = await Promise.all([
      query(`SELECT
               COUNT(*)                                        AS total_users,
               COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '1 day') AS new_today,
               COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') AS new_this_week,
               COUNT(*) FILTER (WHERE is_active = false) AS inactive
             FROM users`),
      query(`SELECT
               COUNT(*) AS total_orders,
               COUNT(*) FILTER (WHERE status = 'COMPLETE')   AS completed,
               COUNT(*) FILTER (WHERE status = 'OPEN')       AS open,
               COUNT(*) FILTER (WHERE status = 'CANCELLED')  AS cancelled,
               COUNT(*) FILTER (WHERE placed_at >= NOW() - INTERVAL '1 day') AS today
             FROM orders`),
      query(`SELECT
               COUNT(*)         AS total_trades,
               SUM(net_amount)  AS total_volume,
               SUM(brokerage)   AS total_brokerage
             FROM trades WHERE traded_at >= NOW() - INTERVAL '30 days'`),
      query(`SELECT
               COUNT(*) FILTER (WHERE kyc_status = 'pending')  AS pending,
               COUNT(*) FILTER (WHERE kyc_status = 'verified') AS verified,
               COUNT(*) FILTER (WHERE kyc_status = 'rejected') AS rejected
             FROM users`),
    ]);

    const stats = {
      users:  users.rows[0],
      orders: orders.rows[0],
      trades: trades.rows[0],
      kyc:    kyc.rows[0],
      generated_at: new Date().toISOString(),
    };
    await cacheSet(cacheKey, stats, 60); // cache for 1 min
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// GET /api/admin/stats/daily — last 30 days volume & trades
app.get('/api/admin/stats/daily', async (req, res) => {
  try {
    const result = await query(
      `SELECT DATE_TRUNC('day', traded_at) AS date,
              COUNT(*)         AS trade_count,
              SUM(net_amount)  AS volume,
              SUM(brokerage)   AS brokerage
       FROM trades
       WHERE traded_at >= NOW() - INTERVAL '30 days'
       GROUP BY 1 ORDER BY 1`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch daily stats' });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// USER MANAGEMENT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// GET /api/admin/users?search=&kyc_status=&page=1&limit=20
app.get('/api/admin/users', async (req, res) => {
  const { search, kyc_status, is_active, page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;
  const conditions = [];
  const params = [];

  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(email ILIKE $${params.length} OR full_name ILIKE $${params.length} OR phone ILIKE $${params.length})`);
  }
  if (kyc_status) { params.push(kyc_status); conditions.push(`kyc_status = $${params.length}`); }
  if (is_active !== undefined) { params.push(is_active === 'true'); conditions.push(`is_active = $${params.length}`); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const [rows, total] = await Promise.all([
      query(
        `SELECT u.id, u.email, u.full_name, u.phone, u.kyc_status, u.is_active, u.created_at,
                f.available_cash, f.used_margin,
                (SELECT COUNT(*) FROM orders WHERE user_id = u.id) AS order_count
         FROM users u LEFT JOIN funds f ON u.id = f.user_id
         ${where} ORDER BY u.created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,
        [...params, limit, offset]
      ),
      query(`SELECT COUNT(*) FROM users ${where}`, params),
    ]);
    res.json({ users: rows.rows, total: Number(total.rows[0].count), page: Number(page), limit: Number(limit) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// GET /api/admin/users/:userId
app.get('/api/admin/users/:userId', async (req, res) => {
  try {
    const [user, orders, trades, kyc] = await Promise.all([
      query(`SELECT u.*, f.available_cash, f.used_margin, f.total_funds
             FROM users u LEFT JOIN funds f ON u.id = f.user_id
             WHERE u.id = $1`, [req.params.userId]),
      query('SELECT COUNT(*), status FROM orders WHERE user_id=$1 GROUP BY status', [req.params.userId]),
      query('SELECT COUNT(*), SUM(net_amount) as volume FROM trades WHERE user_id=$1', [req.params.userId]),
      query('SELECT * FROM kyc_documents WHERE user_id=$1 ORDER BY created_at DESC', [req.params.userId]),
    ]);
    if (!user.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({
      user: user.rows[0],
      order_summary: orders.rows,
      trade_summary: trades.rows[0],
      kyc_documents: kyc.rows,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// PATCH /api/admin/users/:userId — activate/deactivate user
app.patch('/api/admin/users/:userId', async (req, res) => {
  const { is_active, notes } = req.body;
  try {
    await query(
      'UPDATE users SET is_active=$1, updated_at=NOW() WHERE id=$2',
      [is_active, req.params.userId]
    );
    await query(
      `INSERT INTO audit_logs (user_id, action, entity, entity_id, metadata)
       VALUES ($1, $2, 'user', $3, $4)`,
      [req.admin.id, is_active ? 'USER_ACTIVATED' : 'USER_DEACTIVATED', req.params.userId,
       JSON.stringify({ admin: req.admin.email, notes })]
    );
    res.json({ message: `User ${is_active ? 'activated' : 'deactivated'}` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// KYC MANAGEMENT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// GET /api/admin/kyc?status=pending&page=1
app.get('/api/admin/kyc', async (req, res) => {
  const { status = 'pending', page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;
  try {
    const result = await query(
      `SELECT u.id, u.email, u.full_name, u.phone, u.kyc_status, u.created_at,
              (SELECT COUNT(*) FROM kyc_documents WHERE user_id = u.id) AS doc_count,
              (SELECT MAX(created_at) FROM kyc_documents WHERE user_id = u.id) AS last_doc_at
       FROM users u
       WHERE u.kyc_status = $1
       ORDER BY u.created_at ASC
       LIMIT $2 OFFSET $3`,
      [status, limit, offset]
    );
    const total = await query('SELECT COUNT(*) FROM users WHERE kyc_status=$1', [status]);
    res.json({ users: result.rows, total: Number(total.rows[0].count) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch KYC queue' });
  }
});

// GET /api/admin/kyc/:userId/documents
app.get('/api/admin/kyc/:userId/documents', async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM kyc_documents WHERE user_id=$1 ORDER BY created_at DESC',
      [req.params.userId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch documents' });
  }
});

// POST /api/admin/kyc/:userId/review — approve or reject KYC
app.post('/api/admin/kyc/:userId/review', async (req, res) => {
  const { action, reason } = req.body; // action: 'approved' | 'rejected'
  if (!['approved', 'rejected'].includes(action)) {
    return res.status(400).json({ error: 'action must be approved or rejected' });
  }
  const newStatus = action === 'approved' ? 'verified' : 'rejected';

  try {
    await transaction(async (client) => {
      await client.query(
        'UPDATE users SET kyc_status=$1, updated_at=NOW() WHERE id=$2',
        [newStatus, req.params.userId]
      );
      await client.query(
        `INSERT INTO audit_logs (user_id, action, entity, entity_id, metadata)
         VALUES ($1, 'KYC_REVIEW', 'user', $2, $3)`,
        [req.admin.id, req.params.userId, JSON.stringify({ action, reason, admin: req.admin.email })]
      );
    });

    // Notify user
    await publishMessage(kafkaProducer, TOPICS.NOTIFICATIONS, req.params.userId, {
      type: 'KYC_STATUS_CHANGED', userId: req.params.userId, status: newStatus, reason,
    });

    // Invalidate user cache
    await cacheDel(`user-contact:${req.params.userId}`);

    res.json({ message: `KYC ${action} for user ${req.params.userId}` });
  } catch (err) {
    res.status(500).json({ error: 'KYC review failed' });
  }
});

// POST /api/admin/kyc/:userId/documents — upload KYC doc on behalf (or via user portal)
app.post('/api/admin/kyc/:userId/documents', upload.single('document'), async (req, res) => {
  const { doc_type } = req.body; // pan | aadhaar | bank_statement | photo
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    // In production: upload to S3 / GCS and store the URL
    const filePath = req.file.path; // replace with cloud URL
    await query(
      `INSERT INTO kyc_documents (user_id, doc_type, file_path, status, uploaded_by)
       VALUES ($1,$2,$3,'pending',$4)`,
      [req.params.userId, doc_type, filePath, req.admin.id]
    );
    res.status(201).json({ message: 'Document uploaded', doc_type, path: filePath });
  } catch (err) {
    res.status(500).json({ error: 'Upload failed' });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ORDERS & TRADES OVERSIGHT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// GET /api/admin/orders?user_id=&status=&from=&to=
app.get('/api/admin/orders', async (req, res) => {
  const { user_id, status, from, to, page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;
  const conditions = [];
  const params = [];

  if (user_id)  { params.push(user_id); conditions.push(`o.user_id = $${params.length}`); }
  if (status)   { params.push(status);  conditions.push(`o.status = $${params.length}`); }
  if (from)     { params.push(from);    conditions.push(`o.placed_at >= $${params.length}`); }
  if (to)       { params.push(to);      conditions.push(`o.placed_at <= $${params.length}`); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  try {
    const result = await query(
      `SELECT o.*, u.email, u.full_name, i.symbol, i.exchange
       FROM orders o
       JOIN users u ON o.user_id = u.id
       JOIN instruments i ON o.instrument_id = i.id
       ${where}
       ORDER BY o.placed_at DESC
       LIMIT $${params.length+1} OFFSET $${params.length+2}`,
      [...params, limit, offset]
    );
    res.json({ orders: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AUDIT LOGS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.get('/api/admin/audit-logs', async (req, res) => {
  const { user_id, action, page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;
  const conditions = [];
  const params = [];

  if (user_id) { params.push(user_id); conditions.push(`user_id = $${params.length}`); }
  if (action)  { params.push(`%${action}%`); conditions.push(`action ILIKE $${params.length}`); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  try {
    const result = await query(
      `SELECT a.*, u.email FROM audit_logs a
       LEFT JOIN users u ON a.user_id = u.id
       ${where}
       ORDER BY a.created_at DESC
       LIMIT $${params.length+1} OFFSET $${params.length+2}`,
      [...params, limit, offset]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch audit logs' });
  }
});

// ─── Admin DB schema additions ────────────────────────────────────────────
// Run this migration:
// CREATE TABLE kyc_documents (
//   id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
//   user_id     UUID NOT NULL REFERENCES users(id),
//   doc_type    VARCHAR(30) NOT NULL,
//   file_path   TEXT NOT NULL,
//   status      VARCHAR(20) DEFAULT 'pending',
//   uploaded_by UUID REFERENCES users(id),
//   reviewed_by UUID REFERENCES users(id),
//   reviewed_at TIMESTAMPTZ,
//   notes       TEXT,
//   created_at  TIMESTAMPTZ DEFAULT NOW()
// );
// ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'user';

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'admin-service' }));

const PORT = process.env.PORT || 3006;
app.listen(PORT, async () => {
  console.log(`[Admin Service] Running on port ${PORT}`);
});
