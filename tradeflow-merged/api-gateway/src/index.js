const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { createProxyMiddleware } = require('http-proxy-middleware');
const rateLimit = require('express-rate-limit');
const { createServer } = require('http');
const { Server: SocketServer } = require('socket.io');
const { createClient: createRedisClient } = require('redis');
const jwt = require('jsonwebtoken');

const app = express();
const httpServer = createServer(app);

// ─── Socket.IO for live market data ────────────────────────────────────────
const io = new SocketServer(httpServer, {
  cors: { origin: process.env.FRONTEND_URL || 'http://localhost:5173', credentials: true },
});

// ─── Middleware ─────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));

// ─── Rate limiting ──────────────────────────────────────────────────────────
const globalLimiter = rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true });
const authLimiter   = rateLimit({ windowMs: 60_000, max: 10,  message: { error: 'Too many auth attempts' } });
const orderLimiter  = rateLimit({ windowMs: 1_000,  max: 5,   message: { error: 'Order rate limit exceeded' } });
app.use(globalLimiter);

// ─── JWT Auth middleware ─────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    req.headers['x-user-id']    = req.user.id;
    req.headers['x-user-email'] = req.user.email;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ─── Proxy configuration ────────────────────────────────────────────────────
const proxyOpts = (target) => ({
  target,
  changeOrigin: true,
  on: {
    error: (err, req, res) => {
      console.error(`[Gateway] Proxy error to ${target}:`, err.message);
      res.status(502).json({ error: 'Service unavailable' });
    },
  },
});

// Auth service — public routes (includes Upstox OAuth /api/auth/upstox/*)
app.use('/api/auth', authLimiter,
  createProxyMiddleware(proxyOpts(process.env.AUTH_SERVICE_URL || 'http://localhost:3001'))
);

// Market data — protected
app.use('/api/market',         authMiddleware, createProxyMiddleware(proxyOpts(process.env.MARKET_DATA_SERVICE_URL    || 'http://localhost:3002')));

// Orders — protected + rate limited
app.use('/api/orders',         authMiddleware, orderLimiter, createProxyMiddleware(proxyOpts(process.env.ORDER_SERVICE_URL         || 'http://localhost:3003')));

// Portfolio — protected
app.use('/api/portfolio',      authMiddleware, createProxyMiddleware(proxyOpts(process.env.PORTFOLIO_SERVICE_URL      || 'http://localhost:3004')));

// Notifications — protected
app.use('/api/notifications',  authMiddleware, createProxyMiddleware(proxyOpts(process.env.NOTIFICATION_SERVICE_URL   || 'http://localhost:3005')));

// Admin — protected (role check is inside admin-service)
app.use('/api/admin',          authMiddleware, createProxyMiddleware(proxyOpts(process.env.ADMIN_SERVICE_URL           || 'http://localhost:3006')));

// ─── Health check ────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'api-gateway', timestamp: new Date().toISOString() });
});

// ─── WebSocket — live tick forwarding via Redis pub/sub ────────────────────
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication required'));
  try {
    socket.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});

async function startRedisSubscriber() {
  const subscriber = createRedisClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  });
  await subscriber.connect();

  // Subscribe to pattern for all ticks
  await subscriber.pSubscribe('tick:*', (message, channel) => {
    const instrumentKey = channel.replace('tick:', '');
    const tick = JSON.parse(message);
    // Broadcast to all clients subscribed to this instrument
    io.to(`instrument:${instrumentKey}`).emit('tick', tick);
  });

  console.log('[Gateway] Redis tick subscriber active');
}

io.on('connection', (socket) => {
  console.log(`[WS] Client connected: ${socket.user.id}`);

  socket.on('subscribe', (instruments) => {
    if (!Array.isArray(instruments)) return;
    instruments.forEach((key) => socket.join(`instrument:${key}`));
    console.log(`[WS] User ${socket.user.id} subscribed to: ${instruments.join(', ')}`);
  });

  socket.on('unsubscribe', (instruments) => {
    if (!Array.isArray(instruments)) return;
    instruments.forEach((key) => socket.leave(`instrument:${key}`));
  });

  socket.on('disconnect', () => {
    console.log(`[WS] Client disconnected: ${socket.user.id}`);
  });
});

// ─── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, async () => {
  console.log(`[Gateway] Running on port ${PORT}`);
  await startRedisSubscriber();
});
