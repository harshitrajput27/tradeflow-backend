/**
 * Upstox OAuth2 Flow
 * Add these routes to the auth-service (services/auth-service/src/index.js)
 *
 * Flow:
 * 1. Frontend → GET /api/auth/upstox/login         → redirects to Upstox consent page
 * 2. Upstox   → GET /api/auth/upstox/callback?code → exchanges code for tokens
 * 3. Backend  → returns JWT + stores upstox_token in Redis for this user session
 */

const express = require('express');
const axios   = require('axios');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const { query }          = require('../../../shared/db/pool');
const { cacheSet, cacheGet, setSession } = require('../../../shared/redis/client');
const { createProducer, publishMessage, TOPICS } = require('../../../shared/kafka/client');

const router = express.Router();
let kafkaProducer;
(async () => { kafkaProducer = await createProducer('auth-upstox-producer'); })();

const UPSTOX_BASE      = 'https://api.upstox.com/v2';
const UPSTOX_AUTH_URL  = 'https://api.upstox.com/v2/login/authorization/dialog';
const UPSTOX_TOKEN_URL = `${UPSTOX_BASE}/login/authorization/token`;

// ─── Helpers ──────────────────────────────────────────────────────────────
function generateTokens(user) {
  const payload = { id: user.id, email: user.email, role: 'user' };
  return {
    accessToken:  jwt.sign(payload, process.env.JWT_SECRET,         { expiresIn: process.env.JWT_EXPIRES_IN || '15m' }),
    refreshToken: jwt.sign(payload, process.env.JWT_REFRESH_SECRET, { expiresIn: '7d' }),
  };
}

// ─── GET /api/auth/upstox/login ───────────────────────────────────────────
// Generates a state token, stores it in Redis, redirects to Upstox consent
router.get('/upstox/login', async (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  // Store state for 10 min to prevent CSRF
  await cacheSet(`oauth-state:${state}`, { origin: req.query.origin || '/' }, 600);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     process.env.UPSTOX_API_KEY,
    redirect_uri:  process.env.UPSTOX_REDIRECT_URI,
    state,
  });

  res.redirect(`${UPSTOX_AUTH_URL}?${params.toString()}`);
});

// ─── GET /api/auth/upstox/callback?code=...&state=... ────────────────────
router.get('/upstox/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const FRONTEND = process.env.FRONTEND_URL || 'http://localhost:5173';

  if (error) {
    return res.redirect(`${FRONTEND}/auth/error?reason=${encodeURIComponent(error)}`);
  }

  // ── Validate state (CSRF check) ─────────────────────────────────────────
  const stateData = await cacheGet(`oauth-state:${state}`);
  if (!stateData) {
    return res.redirect(`${FRONTEND}/auth/error?reason=invalid_state`);
  }
  // Consume state (one-time use)
  const { cacheDel } = require('../../../shared/redis/client');
  await cacheDel(`oauth-state:${state}`);

  try {
    // ── Exchange code for Upstox tokens ─────────────────────────────────
    const tokenRes = await axios.post(UPSTOX_TOKEN_URL,
      new URLSearchParams({
        code,
        client_id:     process.env.UPSTOX_API_KEY,
        client_secret: process.env.UPSTOX_API_SECRET,
        redirect_uri:  process.env.UPSTOX_REDIRECT_URI,
        grant_type:    'authorization_code',
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' } }
    );

    const { access_token, refresh_token: upstoxRefresh, expires_in } = tokenRes.data;

    // ── Fetch Upstox user profile ────────────────────────────────────────
    const profileRes = await axios.get(`${UPSTOX_BASE}/user/profile`, {
      headers: { Authorization: `Bearer ${access_token}`, Accept: 'application/json' },
    });
    const upstoxUser = profileRes.data?.data;

    // ── Upsert user in our DB ────────────────────────────────────────────
    const email     = upstoxUser.email;
    const full_name = upstoxUser.user_name || upstoxUser.email.split('@')[0];

    let dbUser;
    const existing = await query('SELECT * FROM users WHERE email = $1', [email]);

    if (existing.rows.length) {
      dbUser = existing.rows[0];
    } else {
      // Auto-register user via Upstox SSO (no password needed)
      const bcrypt = require('bcryptjs');
      const tempHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
      const inserted = await query(
        `INSERT INTO users (email, full_name, password_hash, kyc_status)
         VALUES ($1, $2, $3, 'verified') RETURNING *`,
        [email, full_name, tempHash]
      );
      dbUser = inserted.rows[0];

      // Create empty funds record
      await query('INSERT INTO funds (user_id) VALUES ($1)', [dbUser.id]);

      await publishMessage(kafkaProducer, TOPICS.NOTIFICATIONS, dbUser.id, {
        type: 'USER_REGISTERED', userId: dbUser.id, email,
      });
    }

    // ── Store Upstox tokens in Redis (keyed by our user ID) ──────────────
    const upstoxTokenTTL = expires_in || 86400;
    await cacheSet(`upstox-token:${dbUser.id}`, {
      access_token,
      refresh_token: upstoxRefresh,
      expires_at:    Date.now() + upstoxTokenTTL * 1000,
      user_id:       dbUser.id,
    }, upstoxTokenTTL);

    // ── Generate our own JWT pair ────────────────────────────────────────
    const { accessToken, refreshToken } = generateTokens(dbUser);

    // Store refresh token in DB
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await query(
      'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1,$2,$3)',
      [dbUser.id, refreshToken, expiresAt]
    );
    await setSession(dbUser.id, { id: dbUser.id, email: dbUser.email, full_name: dbUser.full_name });

    await publishMessage(kafkaProducer, TOPICS.NOTIFICATIONS, dbUser.id, {
      type: 'USER_LOGIN', userId: dbUser.id, ip: req.ip, method: 'upstox_oauth',
    });

    // ── Redirect to frontend with tokens in URL fragment ─────────────────
    // (frontend reads them out of the hash and stores in memory / secure cookie)
    const params = new URLSearchParams({
      access_token:   accessToken,
      refresh_token:  refreshToken,
      user_id:        dbUser.id,
    });
    res.redirect(`${FRONTEND}/auth/callback#${params.toString()}`);

  } catch (err) {
    console.error('[Auth] Upstox OAuth callback error:', err.response?.data || err.message);
    res.redirect(`${FRONTEND}/auth/error?reason=oauth_failed`);
  }
});

// ─── GET /api/auth/upstox/token ───────────────────────────────────────────
// Frontend calls this to get a fresh Upstox access_token for API calls
router.get('/upstox/token', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const stored = await cacheGet(`upstox-token:${userId}`);
    if (!stored) return res.status(404).json({ error: 'No Upstox session. Please reconnect via /api/auth/upstox/login' });

    // Auto-refresh if token expires in < 5 min
    if (stored.expires_at - Date.now() < 300_000 && stored.refresh_token) {
      const refreshRes = await axios.post(UPSTOX_TOKEN_URL,
        new URLSearchParams({
          grant_type:    'refresh_token',
          refresh_token: stored.refresh_token,
          client_id:     process.env.UPSTOX_API_KEY,
          client_secret: process.env.UPSTOX_API_SECRET,
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      const { access_token, refresh_token: newRefresh, expires_in } = refreshRes.data;
      await cacheSet(`upstox-token:${userId}`, {
        access_token,
        refresh_token: newRefresh || stored.refresh_token,
        expires_at:    Date.now() + (expires_in || 86400) * 1000,
        user_id:       userId,
      }, expires_in || 86400);
      return res.json({ access_token });
    }

    res.json({ access_token: stored.access_token });
  } catch (err) {
    console.error('[Auth] Upstox token refresh error:', err.message);
    res.status(500).json({ error: 'Failed to refresh Upstox token' });
  }
});

module.exports = router;
