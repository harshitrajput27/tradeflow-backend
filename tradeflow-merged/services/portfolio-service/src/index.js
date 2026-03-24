const express = require('express');
const { query, transaction } = require('../../../shared/db/pool');
const { cacheGet, cacheSet } = require('../../../shared/redis/client');
const { createConsumer, createProducer, publishMessage, TOPICS } = require('../../../shared/kafka/client');

const app = express();
app.use(express.json());

let kafkaProducer;

// ─── GET /api/portfolio/holdings ──────────────────────────────────────────
app.get('/api/portfolio/holdings', async (req, res) => {
  const userId = req.headers['x-user-id'];
  const cacheKey = `holdings:${userId}`;
  try {
    const cached = await cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const result = await query(
      `SELECT h.*, i.symbol, i.name as instrument_name, i.exchange, i.isin
       FROM holdings h JOIN instruments i ON h.instrument_id = i.id
       WHERE h.user_id = $1 AND h.quantity > 0
       ORDER BY (h.quantity * h.last_price) DESC NULLS LAST`,
      [userId]
    );

    const holdings = result.rows.map(h => ({
      ...h,
      current_value:  +(h.quantity * (h.last_price || h.average_buy_price)).toFixed(2),
      invested_value: +(h.quantity * h.average_buy_price).toFixed(4),
      pnl:            +(h.quantity * ((h.last_price || h.average_buy_price) - h.average_buy_price)).toFixed(4),
      pnl_pct:        h.last_price
                        ? +(((h.last_price - h.average_buy_price) / h.average_buy_price) * 100).toFixed(2)
                        : 0,
    }));

    const summary = {
      total_investment: holdings.reduce((s, h) => s + h.invested_value, 0),
      current_value:    holdings.reduce((s, h) => s + h.current_value, 0),
      total_pnl:        holdings.reduce((s, h) => s + h.pnl, 0),
      holdings,
    };
    summary.total_pnl_pct = summary.total_investment > 0
      ? +((summary.total_pnl / summary.total_investment) * 100).toFixed(2) : 0;

    await cacheSet(cacheKey, summary, 30);
    res.json(summary);
  } catch (err) {
    console.error('[Portfolio] Holdings error:', err.message);
    res.status(500).json({ error: 'Failed to fetch holdings' });
  }
});

// ─── GET /api/portfolio/positions ─────────────────────────────────────────
app.get('/api/portfolio/positions', async (req, res) => {
  const userId = req.headers['x-user-id'];
  try {
    const result = await query(
      `SELECT p.*, i.symbol, i.name as instrument_name, i.exchange
       FROM positions p JOIN instruments i ON p.instrument_id = i.id
       WHERE p.user_id = $1 AND p.trade_date = CURRENT_DATE AND p.quantity != 0
       ORDER BY ABS(p.pnl) DESC NULLS LAST`,
      [userId]
    );
    const positions = result.rows;
    const summary = {
      total_pnl:  positions.reduce((s, p) => s + (p.pnl || 0), 0),
      realised:   positions.reduce((s, p) => s + (p.realised_pnl || 0), 0),
      unrealised: positions.reduce((s, p) => s + (p.unrealised_pnl || 0), 0),
      positions,
    };
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch positions' });
  }
});

// ─── GET /api/portfolio/funds ─────────────────────────────────────────────
app.get('/api/portfolio/funds', async (req, res) => {
  const userId = req.headers['x-user-id'];
  try {
    const result = await query('SELECT * FROM funds WHERE user_id = $1', [userId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Funds not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch funds' });
  }
});

// ─── GET /api/portfolio/mutual-funds ──────────────────────────────────────
app.get('/api/portfolio/mutual-funds', async (req, res) => {
  const userId = req.headers['x-user-id'];
  try {
    const result = await query(
      `SELECT * FROM mf_holdings WHERE user_id = $1 ORDER BY current_val DESC NULLS LAST`,
      [userId]
    );
    const mfHoldings = result.rows;
    const summary = {
      total_invested: mfHoldings.reduce((s, m) => s + (m.invested_amt || 0), 0),
      current_value:  mfHoldings.reduce((s, m) => s + (m.current_val || 0), 0),
      total_pnl:      mfHoldings.reduce((s, m) => s + (m.pnl || 0), 0),
      holdings:       mfHoldings,
    };
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch MF holdings' });
  }
});

// ─── GET /api/portfolio/pnl?period=today|week|month|year ─────────────────
app.get('/api/portfolio/pnl', async (req, res) => {
  const userId = req.headers['x-user-id'];
  const { period = 'today' } = req.query;
  const intervals = { today: '1 day', week: '7 days', month: '30 days', year: '365 days' };
  const interval = intervals[period] || '1 day';
  try {
    const result = await query(
      `SELECT DATE_TRUNC('day', traded_at) as date,
              SUM(CASE WHEN transaction_type='BUY' THEN -net_amount ELSE net_amount END) as pnl,
              COUNT(*) as trade_count
       FROM trades WHERE user_id = $1 AND traded_at >= NOW() - INTERVAL '${interval}'
       GROUP BY 1 ORDER BY 1`,
      [userId]
    );
    res.json({ period, data: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch P&L' });
  }
});

// ─── Kafka consumer — update holdings when trade executes ─────────────────
async function startKafkaConsumer() {
  await createConsumer(
    'portfolio-service-consumer', 'portfolio-service-group',
    [TOPICS.PORTFOLIO_UPDATES],
    async (topic, event) => {
      if (event.type !== 'HOLDING_UPDATE') return;
      const { userId, instrumentKey, transactionType, quantity, price } = event;

      await transaction(async (client) => {
        // Get instrument
        const instrRes = await client.query(
          'SELECT id FROM instruments WHERE instrument_key = $1', [instrumentKey]
        );
        if (!instrRes.rows.length) return;
        const instrumentId = instrRes.rows[0].id;

        // Upsert holding
        const existingRes = await client.query(
          'SELECT * FROM holdings WHERE user_id=$1 AND instrument_id=$2 FOR UPDATE',
          [userId, instrumentId]
        );
        const existing = existingRes.rows[0];

        if (transactionType === 'BUY') {
          const newQty  = (existing?.quantity || 0) + quantity;
          const newAvg  = existing
            ? ((existing.average_buy_price * existing.quantity) + (price * quantity)) / newQty
            : price;

          await client.query(
            `INSERT INTO holdings (user_id, instrument_id, quantity, average_buy_price, last_price)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (user_id, instrument_id) DO UPDATE
             SET quantity=$3, average_buy_price=$4, last_price=$5, updated_at=NOW()`,
            [userId, instrumentId, newQty, newAvg, price]
          );
        } else if (transactionType === 'SELL' && existing) {
          const newQty = existing.quantity - quantity;
          if (newQty <= 0) {
            await client.query(
              'DELETE FROM holdings WHERE user_id=$1 AND instrument_id=$2',
              [userId, instrumentId]
            );
          } else {
            await client.query(
              'UPDATE holdings SET quantity=$1, last_price=$2, updated_at=NOW() WHERE user_id=$3 AND instrument_id=$4',
              [newQty, price, userId, instrumentId]
            );
          }
        }

        // Record trade
        await client.query(
          `INSERT INTO trades (order_id, user_id, instrument_id, transaction_type, quantity, price, net_amount, traded_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
          [event.orderId || uuidv4(), userId, instrumentId, transactionType, quantity, price, price * quantity]
        );
      });

      // Invalidate holdings cache
      const { cacheDel } = require('../../../shared/redis/client');
      await cacheDel(`holdings:${userId}`);

      // Notify user
      await publishMessage(kafkaProducer, TOPICS.NOTIFICATIONS, userId, {
        type: 'TRADE_EXECUTED',
        userId,
        instrumentKey,
        transactionType,
        quantity,
        price,
      });
    }
  );
}

function uuidv4() { return require('crypto').randomUUID(); }

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'portfolio-service' }));

const PORT = process.env.PORT || 3004;
app.listen(PORT, async () => {
  console.log(`[Portfolio Service] Running on port ${PORT}`);
  kafkaProducer = await createProducer('portfolio-service-producer');
  await startKafkaConsumer();
});
