const { createClient } = require('redis');

let client = null;

async function getRedisClient() {
  if (client && client.isOpen) return client;

  client = createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    socket: { reconnectStrategy: (retries) => Math.min(retries * 100, 3000) },
  });

  client.on('error', (err) => console.error('[Redis] Error:', err.message));
  client.on('reconnecting', () => console.log('[Redis] Reconnecting...'));

  await client.connect();
  console.log('[Redis] Connected');
  return client;
}

// ─── Cache helpers ──────────────────────────────────────────────────────────
async function cacheGet(key) {
  const r = await getRedisClient();
  const val = await r.get(key);
  return val ? JSON.parse(val) : null;
}

async function cacheSet(key, value, ttlSeconds = 300) {
  const r = await getRedisClient();
  await r.setEx(key, ttlSeconds, JSON.stringify(value));
}

async function cacheDel(key) {
  const r = await getRedisClient();
  await r.del(key);
}

// ─── Pub/Sub for live tick forwarding to WebSocket ──────────────────────────
async function publishTick(instrumentKey, tickData) {
  const r = await getRedisClient();
  await r.publish(`tick:${instrumentKey}`, JSON.stringify(tickData));
  // Also cache last tick
  await r.setEx(`ltp:${instrumentKey}`, 60, JSON.stringify(tickData));
}

async function getLastTick(instrumentKey) {
  return cacheGet(`ltp:${instrumentKey}`);
}

// ─── Rate limiter helper ─────────────────────────────────────────────────────
async function checkRateLimit(key, limit, windowSeconds) {
  const r = await getRedisClient();
  const current = await r.incr(key);
  if (current === 1) await r.expire(key, windowSeconds);
  return current <= limit;
}

// ─── Session helpers ─────────────────────────────────────────────────────────
async function setSession(userId, sessionData, ttlSeconds = 3600) {
  return cacheSet(`session:${userId}`, sessionData, ttlSeconds);
}

async function getSession(userId) {
  return cacheGet(`session:${userId}`);
}

async function deleteSession(userId) {
  return cacheDel(`session:${userId}`);
}

module.exports = {
  getRedisClient,
  cacheGet, cacheSet, cacheDel,
  publishTick, getLastTick,
  checkRateLimit,
  setSession, getSession, deleteSession,
};
