const express = require('express');
const { query, transaction } = require('../../../shared/db/pool');
const { cacheGet, cacheSet, cacheDel } = require('../../../shared/redis/client');
const { createProducer, publishMessage, TOPICS } = require('../../../shared/kafka/client');

const app = express();
app.use(express.json());

let kafkaProducer;
(async () => { kafkaProducer = await createProducer('payment-service-producer'); })();

// ─── JWT middleware ───────────────────────────────────────────────────────
app.use((req, res, next) => {
  const tok = (req.headers.authorization || '').replace('Bearer ', '').trim();
  let userId = req.headers['x-user-id'];
  if (!userId && tok) {
    try {
      const jwt = require('jsonwebtoken');
      const p = jwt.verify(tok, process.env.JWT_SECRET);
      userId = p.id;
    } catch(e) {
      return res.status(401).json({ error: 'Invalid token' });
    }
  }
  if (!userId && req.path !== '/health') return res.status(401).json({ error: 'Unauthorized' });
  req.userId = userId;
  next();
});

// ─── GET /api/payments/balance ─────────────────────────────────────────────
app.get('/api/payments/balance', async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM funds WHERE user_id = $1',
      [req.userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Account not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/payments/transactions ───────────────────────────────────────
app.get('/api/payments/transactions', async (req, res) => {
  const { page = 1, limit = 20, type } = req.query;
  const offset = (page - 1) * limit;
  const conditions = ['user_id = $1'];
  const params = [req.userId];

  if (type) { params.push(type); conditions.push(`type = $${params.length}`); }

  try {
    const result = await query(
      `SELECT * FROM payment_transactions
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    const total = await query(
      `SELECT COUNT(*) FROM payment_transactions WHERE ${conditions.join(' AND ')}`,
      params
    );
    res.json({ transactions: result.rows, total: Number(total.rows[0].count) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/payments/deposit ───────────────────────────────────────────
app.post('/api/payments/deposit', async (req, res) => {
  const { amount, payment_method, utr_number, bank_name, remarks } = req.body;

  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
  if (amount < 100) return res.status(400).json({ error: 'Minimum deposit is ₹100' });
  if (amount > 1000000) return res.status(400).json({ error: 'Maximum deposit is ₹10,00,000 per transaction' });
  if (!payment_method) return res.status(400).json({ error: 'Payment method is required' });

  try {
    const result = await transaction(async (client) => {
      // Create pending transaction
      const txRes = await client.query(
        `INSERT INTO payment_transactions
           (user_id, type, amount, payment_method, utr_number, bank_name, remarks, status)
         VALUES ($1, 'DEPOSIT', $2, $3, $4, $5, $6, 'PENDING')
         RETURNING *`,
        [req.userId, amount, payment_method, utr_number || null, bank_name || null, remarks || null]
      );
      const tx = txRes.rows[0];

      // For UPI/NEFT/IMPS — auto-approve after UTR verification (in production, verify with payment gateway)
      // For demo purposes, auto-approve if UTR provided
      if (utr_number) {
        await client.query(
          `UPDATE payment_transactions SET status = 'COMPLETED', processed_at = NOW() WHERE id = $1`,
          [tx.id]
        );

        // Credit funds
        await client.query(
          `UPDATE funds
           SET available_cash = available_cash + $1,
               total_funds    = total_funds    + $1,
               withdrawable   = withdrawable   + $1,
               updated_at     = NOW()
           WHERE user_id = $2`,
          [amount, req.userId]
        );

        tx.status = 'COMPLETED';
      }

      return tx;
    });

    // Notify user
    await publishMessage(kafkaProducer, TOPICS.NOTIFICATIONS, req.userId, {
      type: 'PAYMENT_DEPOSIT',
      userId: req.userId,
      amount,
      status: result.status,
      transactionId: result.id,
    });

    // Invalidate funds cache
    await cacheDel(`funds:${req.userId}`);

    res.status(201).json({
      transaction: result,
      message: result.status === 'COMPLETED'
        ? `₹${Number(amount).toLocaleString('en-IN')} deposited successfully!`
        : 'Deposit request submitted. Pending verification.',
    });
  } catch (err) {
    console.error('[Payment] Deposit error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/payments/withdraw ──────────────────────────────────────────
app.post('/api/payments/withdraw', async (req, res) => {
  const { amount, bank_account, ifsc_code, account_name, remarks } = req.body;

  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
  if (amount < 100) return res.status(400).json({ error: 'Minimum withdrawal is ₹100' });
  if (!bank_account || !ifsc_code || !account_name) {
    return res.status(400).json({ error: 'Bank account, IFSC code and account name are required' });
  }

  try {
    const result = await transaction(async (client) => {
      // Check available balance
      const fundsRes = await client.query(
        'SELECT * FROM funds WHERE user_id = $1 FOR UPDATE',
        [req.userId]
      );
      if (!fundsRes.rows.length) throw new Error('Account not found');
      const funds = fundsRes.rows[0];

      if (Number(funds.withdrawable) < amount) {
        throw new Error(`Insufficient withdrawable balance. Available: ₹${Number(funds.withdrawable).toLocaleString('en-IN')}`);
      }

      // Deduct from withdrawable immediately (hold the amount)
      await client.query(
        `UPDATE funds
         SET withdrawable   = withdrawable   - $1,
             available_cash = available_cash - $1,
             updated_at     = NOW()
         WHERE user_id = $2`,
        [amount, req.userId]
      );

      // Create withdrawal transaction
      const txRes = await client.query(
        `INSERT INTO payment_transactions
           (user_id, type, amount, bank_account, ifsc_code, account_name, remarks, status)
         VALUES ($1, 'WITHDRAWAL', $2, $3, $4, $5, $6, 'PROCESSING')
         RETURNING *`,
        [req.userId, amount, bank_account, ifsc_code, account_name, remarks || null]
      );

      return txRes.rows[0];
    });

    // Notify user
    await publishMessage(kafkaProducer, TOPICS.NOTIFICATIONS, req.userId, {
      type: 'PAYMENT_WITHDRAWAL',
      userId: req.userId,
      amount,
      status: 'PROCESSING',
      transactionId: result.id,
    });

    await cacheDel(`funds:${req.userId}`);

    res.status(201).json({
      transaction: result,
      message: `Withdrawal of ₹${Number(amount).toLocaleString('en-IN')} initiated. Will be credited within 1 working day.`,
    });
  } catch (err) {
    console.error('[Payment] Withdrawal error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// ─── GET /api/payments/transactions/:id ───────────────────────────────────
app.get('/api/payments/transactions/:id', async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM payment_transactions WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Transaction not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/payments/summary ────────────────────────────────────────────
app.get('/api/payments/summary', async (req, res) => {
  try {
    const [funds, stats] = await Promise.all([
      query('SELECT * FROM funds WHERE user_id = $1', [req.userId]),
      query(
        `SELECT
           COUNT(*) FILTER (WHERE type = 'DEPOSIT' AND status = 'COMPLETED')   AS total_deposits,
           COUNT(*) FILTER (WHERE type = 'WITHDRAWAL' AND status != 'FAILED')  AS total_withdrawals,
           COALESCE(SUM(amount) FILTER (WHERE type = 'DEPOSIT' AND status = 'COMPLETED'), 0)  AS total_deposited,
           COALESCE(SUM(amount) FILTER (WHERE type = 'WITHDRAWAL' AND status != 'FAILED'), 0) AS total_withdrawn
         FROM payment_transactions WHERE user_id = $1`,
        [req.userId]
      ),
    ]);
    res.json({
      balance:  funds.rows[0] || {},
      stats:    stats.rows[0],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'payment-service' }));

const PORT = process.env.PORT || 3007;
app.listen(PORT, async () => {
  console.log(`[Payment Service] Running on port ${PORT}`);
});
