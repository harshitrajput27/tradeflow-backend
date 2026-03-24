const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { query, transaction } = require('../../../shared/db/pool');
const { setSession, deleteSession, checkRateLimit } = require('../../../shared/redis/client');
const { createProducer, publishMessage, TOPICS } = require('../../../shared/kafka/client');

const router = express.Router();
let kafkaProducer;

(async () => {
  kafkaProducer = await createProducer('auth-service-producer');
})();

// ─── Helpers ─────────────────────────────────────────────────────────────────
function generateTokens(user) {
  const payload = { id: user.id, email: user.email, role: 'user' };
  const accessToken = jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
  });
  const refreshToken = jwt.sign(payload, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  });
  return { accessToken, refreshToken };
}

// ─── POST /api/auth/register ──────────────────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { email, phone, password, full_name } = req.body;
    if (!email || !password || !full_name) {
      return res.status(400).json({ error: 'email, password, full_name are required' });
    }

    const exists = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (exists.rows.length) return res.status(409).json({ error: 'Email already registered' });

    const password_hash = await bcrypt.hash(password, 12);
    const result = await transaction(async (client) => {
      const userRes = await client.query(
        `INSERT INTO users (email, phone, password_hash, full_name)
         VALUES ($1, $2, $3, $4) RETURNING id, email, full_name, created_at`,
        [email, phone || null, password_hash, full_name]
      );
      const user = userRes.rows[0];

      // Create empty funds record
      await client.query(
        'INSERT INTO funds (user_id) VALUES ($1)',
        [user.id]
      );
      return user;
    });

    // Publish user-registered event
    await publishMessage(kafkaProducer, TOPICS.NOTIFICATIONS, result.id, {
      type: 'USER_REGISTERED', userId: result.id, email: result.email,
    });

    res.status(201).json({ message: 'Registration successful', user: result });
  } catch (err) {
    console.error('[Auth] Register error:', err.message);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ─── POST /api/auth/login ─────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });

    // Rate limit per email
    const allowed = await checkRateLimit(`login:${email}`, 5, 300);
    if (!allowed) return res.status(429).json({ error: 'Too many login attempts. Try in 5 minutes.' });

    const result = await query(
      'SELECT id, email, password_hash, full_name, is_active FROM users WHERE email = $1',
      [email]
    );
    console.log(result,"result")
    const user = result.rows[0];
    if (!user || !user.is_active) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const { accessToken, refreshToken } = generateTokens(user);

    // Store refresh token
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await query(
      'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [user.id, refreshToken, expiresAt]
    );

    // Cache session in Redis
    await setSession(user.id, { id: user.id, email: user.email, full_name: user.full_name });

    // Audit log
    await publishMessage(kafkaProducer, TOPICS.NOTIFICATIONS, user.id, {
      type: 'USER_LOGIN', userId: user.id, ip: req.ip,
    });

    res.json({
      accessToken,
      refreshToken,
      user: { id: user.id, email: user.email, full_name: user.full_name },
    });
  } catch (err) {
    console.error('[Auth] Login error:', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ─── POST /api/auth/refresh ───────────────────────────────────────────────
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'Refresh token required' });

    const payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);

    // Check DB
    const tokenRes = await query(
      'SELECT id FROM refresh_tokens WHERE token = $1 AND expires_at > NOW()',
      [refreshToken]
    );
    if (!tokenRes.rows.length) return res.status(401).json({ error: 'Invalid or expired refresh token' });

    const userRes = await query(
      'SELECT id, email, full_name FROM users WHERE id = $1',
      [payload.id]
    );
    if (!userRes.rows.length) return res.status(401).json({ error: 'User not found' });

    const { accessToken, refreshToken: newRefreshToken } = generateTokens(userRes.rows[0]);

    // Rotate refresh token
    await query('DELETE FROM refresh_tokens WHERE token = $1', [refreshToken]);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await query(
      'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [userRes.rows[0].id, newRefreshToken, expiresAt]
    );

    res.json({ accessToken, refreshToken: newRefreshToken });
  } catch {
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});

// ─── POST /api/auth/logout ────────────────────────────────────────────────
router.post('/logout', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) {
      await query('DELETE FROM refresh_tokens WHERE token = $1', [refreshToken]);
    }
    const token = req.headers.authorization?.split(' ')[1];
    if (token) {
      try {
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        await deleteSession(payload.id);
      } catch {}
    }
    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Logout failed' });
  }
});

// ─── GET /api/auth/me ─────────────────────────────────────────────────────
router.get('/me', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const result = await query(
      'SELECT id, email, phone, full_name, kyc_status, created_at FROM users WHERE id = $1',
      [userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// ─── App bootstrap ────────────────────────────────────────────────────────
const upstoxOAuth = require('./upstox-oauth');

const app = express();
app.use(express.json());
app.use('/api/auth', router);
app.use('/api/auth', upstoxOAuth);
app.get('/health', (_, res) => res.json({ status: 'ok', service: 'auth-service' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`[Auth Service] Running on port ${PORT}`));
