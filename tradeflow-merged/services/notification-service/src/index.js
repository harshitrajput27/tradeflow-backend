const express  = require('express');
const nodemailer = require('nodemailer');
const twilio   = require('twilio');
const { createConsumer, createProducer, publishMessage, TOPICS } = require('../../../shared/kafka/client');
const { cacheGet, cacheSet } = require('../../../shared/redis/client');
const { query } = require('../../../shared/db/pool');
const { renderOrderFillEmail, renderOrderPlacedEmail, renderWelcomeEmail } = require('./templates/email');

const app = express();
app.use(express.json());

// ─── Mailer setup (Nodemailer + SMTP / SendGrid) ──────────────────────────
const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST   || 'smtp.sendgrid.net',
  port:   Number(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER || 'apikey',
    pass: process.env.SMTP_PASS,
  },
});

// ─── Twilio SMS setup ─────────────────────────────────────────────────────
const twilioClient = process.env.TWILIO_ACCOUNT_SID
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

// ─── Helpers ─────────────────────────────────────────────────────────────
async function getUserContact(userId) {
  const cacheKey = `user-contact:${userId}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;

  const res = await query(
    'SELECT email, phone, full_name FROM users WHERE id = $1',
    [userId]
  );
  if (!res.rows.length) return null;
  await cacheSet(cacheKey, res.rows[0], 3600);
  return res.rows[0];
}

async function sendEmail(to, subject, html) {
  if (!process.env.SMTP_PASS) {
    console.log(`[Notify] Email (dry-run) → ${to}: ${subject}`);
    return;
  }
  await transporter.sendMail({
    from: `"${process.env.FROM_NAME || 'TradeFlow'}" <${process.env.FROM_EMAIL || 'noreply@tradeflow.in'}>`,
    to, subject, html,
  });
  console.log(`[Notify] Email sent → ${to}`);
}

async function sendSMS(to, body) {
  if (!twilioClient) {
    console.log(`[Notify] SMS (dry-run) → ${to}: ${body}`);
    return;
  }
  await twilioClient.messages.create({
    body,
    from: process.env.TWILIO_FROM_NUMBER,
    to,
  });
  console.log(`[Notify] SMS sent → ${to}`);
}

// ─── Deduplicate notifications (avoid double-send on retry) ──────────────
async function isAlreadySent(eventKey) {
  const key = `notif-sent:${eventKey}`;
  const exists = await cacheGet(key);
  if (exists) return true;
  await cacheSet(key, 1, 86400); // 24h dedup window
  return false;
}

// ─── Notification log to DB ───────────────────────────────────────────────
async function logNotification(userId, type, channel, status, metadata = {}) {
  await query(
    `INSERT INTO notification_logs (user_id, type, channel, status, metadata)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, type, channel, status, JSON.stringify(metadata)]
  ).catch(() => {}); // non-critical
}

// ─── Event handlers ───────────────────────────────────────────────────────
const handlers = {

  async ORDER_PLACED(event) {
    const key = `ORDER_PLACED:${event.orderId}`;
    if (await isAlreadySent(key)) return;

    const user = await getUserContact(event.userId);
    if (!user) return;

    const subject = `Order placed — ${event.instrument} ${event.transactionType}`;
    const html = renderOrderPlacedEmail(user.full_name, event);

    await Promise.allSettled([
      sendEmail(user.email, subject, html),
      user.phone && sendSMS(user.phone,
        `TradeFlow: ${event.transactionType} order placed for ${event.quantity} ${event.instrument} @ ₹${event.price || 'MARKET'}. Order ID: ${event.orderId.slice(0, 8)}`
      ),
    ]);

    await logNotification(event.userId, 'ORDER_PLACED', 'email+sms', 'sent', event);
  },

  async TRADE_EXECUTED(event) {
    const key = `TRADE_EXECUTED:${event.orderId}:${event.quantity}`;
    if (await isAlreadySent(key)) return;

    const user = await getUserContact(event.userId);
    if (!user) return;

    const pnl = event.transactionType === 'SELL'
      ? (event.price - (event.avgBuyPrice || event.price)) * event.quantity
      : null;

    const subject = `✅ Order filled — ${event.instrument} ${event.transactionType} @ ₹${event.price}`;
    const html = renderOrderFillEmail(user.full_name, event, pnl);

    await Promise.allSettled([
      sendEmail(user.email, subject, html),
      user.phone && sendSMS(user.phone,
        `TradeFlow: ${event.transactionType} EXECUTED — ${event.quantity} ${event.instrument} @ ₹${event.price}.${pnl != null ? ` P&L: ₹${pnl.toFixed(2)}` : ''}`
      ),
    ]);

    await logNotification(event.userId, 'TRADE_EXECUTED', 'email+sms', 'sent', event);
  },

  async ORDER_CANCELLED(event) {
    const key = `ORDER_CANCELLED:${event.orderId}`;
    if (await isAlreadySent(key)) return;

    const user = await getUserContact(event.userId);
    if (!user) return;

    await Promise.allSettled([
      sendEmail(user.email,
        `Order cancelled — ${event.orderId.slice(0, 8)}`,
        `<p>Hi ${user.full_name},</p><p>Your order <b>${event.orderId.slice(0, 8)}</b> has been cancelled.</p>`
      ),
      user.phone && sendSMS(user.phone,
        `TradeFlow: Order ${event.orderId.slice(0, 8)} cancelled.`
      ),
    ]);

    await logNotification(event.userId, 'ORDER_CANCELLED', 'email+sms', 'sent', event);
  },

  async USER_REGISTERED(event) {
    const key = `USER_REGISTERED:${event.userId}`;
    if (await isAlreadySent(key)) return;

    const html = renderWelcomeEmail(event.email);
    await sendEmail(event.email, 'Welcome to TradeFlow!', html);
    await logNotification(event.userId, 'USER_REGISTERED', 'email', 'sent', event);
  },

  async USER_LOGIN(event) {
    // Only alert if suspicious (different IP than usual)
    const lastIpKey = `last-login-ip:${event.userId}`;
    const lastIp = await cacheGet(lastIpKey);
    await cacheSet(lastIpKey, event.ip, 86400);
    if (lastIp && lastIp !== event.ip) {
      const user = await getUserContact(event.userId);
      if (user) {
        await sendEmail(user.email,
          'New login detected — TradeFlow',
          `<p>A new login was detected from IP <b>${event.ip}</b>. If this wasn't you, please change your password immediately.</p>`
        );
      }
    }
  },

  async KYC_STATUS_CHANGED(event) {
    const user = await getUserContact(event.userId);
    if (!user) return;
    const status = event.status === 'verified' ? '✅ Verified' : '❌ Rejected';
    await sendEmail(user.email,
      `KYC ${status} — TradeFlow`,
      `<p>Hi ${user.full_name},</p><p>Your KYC status has been updated to: <b>${status}</b>.</p>${event.reason ? `<p>Reason: ${event.reason}</p>` : ''}`
    );
  },

  async PRICE_ALERT(event) {
    const user = await getUserContact(event.userId);
    if (!user) return;
    const key = `PRICE_ALERT:${event.userId}:${event.instrumentKey}:${event.targetPrice}`;
    if (await isAlreadySent(key)) return;
    await Promise.allSettled([
      sendEmail(user.email,
        `Price alert: ${event.symbol} hit ₹${event.currentPrice}`,
        `<p>${event.symbol} has reached your target price of ₹${event.targetPrice}. Current price: ₹${event.currentPrice}.</p>`
      ),
      user.phone && sendSMS(user.phone,
        `TradeFlow Alert: ${event.symbol} @ ₹${event.currentPrice} (target: ₹${event.targetPrice})`
      ),
    ]);
  },
};

// ─── Kafka consumer ────────────────────────────────────────────────────────
async function startConsumer() {
  const allTopics = [
    TOPICS.ORDER_EVENTS,
    TOPICS.NOTIFICATIONS,
    TOPICS.PORTFOLIO_UPDATES,
  ];

  await createConsumer(
    'notification-service-consumer',
    'notification-service-group',
    allTopics,
    async (topic, event) => {
      const handler = handlers[event.type];
      if (!handler) return;
      try {
        await handler(event);
      } catch (err) {
        console.error(`[Notify] Handler error for ${event.type}:`, err.message);
      }
    }
  );

  console.log('[Notify] Kafka consumer started');
}

// ─── REST — send custom notification (admin use) ──────────────────────────
app.post('/api/notifications/send', async (req, res) => {
  const { userId, channel, subject, message } = req.body;
  try {
    const user = await getUserContact(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (channel === 'email' || channel === 'both') await sendEmail(user.email, subject, `<p>${message}</p>`);
    if ((channel === 'sms' || channel === 'both') && user.phone) await sendSMS(user.phone, message);

    await logNotification(userId, 'MANUAL', channel, 'sent', { subject, message });
    res.json({ message: 'Notification sent' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── REST — get notification history ──────────────────────────────────────
app.get('/api/notifications/:userId', async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM notification_logs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
      [req.params.userId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'notification-service' }));

const PORT = process.env.PORT || 3005;
app.listen(PORT, async () => {
  console.log(`[Notification Service] Running on port ${PORT}`);
  // Wait for Kafka topics to be ready
  const startWithRetry = async (retries = 10) => {
    for (let i = 0; i < retries; i++) {
      try {
        await startConsumer();
        console.log('[Notify] Kafka consumer started successfully');
        return;
      } catch (err) {
        console.log(`[Notify] Kafka not ready, retrying in 5s... (${i+1}/${retries})`);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  };
  await startWithRetry();
});
