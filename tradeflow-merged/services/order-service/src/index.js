const express = require('express');
const axios   = require('axios');
const { query, transaction } = require('../../../shared/db/pool');
const { cacheGet } = require('../../../shared/redis/client');
const { createProducer, createConsumer, publishMessage, TOPICS } = require('../../../shared/kafka/client');

const app = express();
app.use(express.json());

let kafkaProducer;

// ─── Upstox order helpers ─────────────────────────────────────────────────
function upstoxHeaders(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' };
}

function mapToUpstoxOrder(body) {
  return {
    quantity:         body.quantity,
    product:          body.product_type,       // CNC | MIS | NRML
    validity:         body.validity || 'DAY',
    price:            body.price || 0,
    tag:              body.tag || 'tradeflow',
    instrument_token: body.instrument_key,
    order_type:       body.order_type,         // MARKET | LIMIT | SL | SL-M
    transaction_type: body.transaction_type,   // BUY | SELL
    disclosed_quantity: 0,
    trigger_price:    body.trigger_price || 0,
    is_amo:           false,
  };
}

// ─── POST /api/orders/place ───────────────────────────────────────────────
app.post('/api/orders/place', async (req, res) => {
  const userId = req.headers['x-user-id'];
  const upstoxToken = req.headers['x-upstox-token'];

  try {
    const { instrument_key, order_type, transaction_type, product_type, quantity, price, trigger_price, validity, tag } = req.body;
    if (!instrument_key || !order_type || !transaction_type || !product_type || !quantity) {
      return res.status(400).json({ error: 'Missing required order fields' });
    }

    // Fetch instrument from DB
    const instrRes = await query(
      'SELECT id, symbol, exchange FROM instruments WHERE instrument_key = $1',
      [instrument_key]
    );
    if (!instrRes.rows.length) return res.status(404).json({ error: 'Instrument not found' });
    const instrument = instrRes.rows[0];

    // Place order via Upstox
    let brokerOrderId = null;
    if (upstoxToken) {
      const upstoxRes = await axios.post(
        `${process.env.UPSTOX_BASE_URL}/order/place`,
        mapToUpstoxOrder(req.body),
        { headers: upstoxHeaders(upstoxToken) }
      );
      brokerOrderId = upstoxRes.data?.data?.order_id;
    }

    // Save to DB
    const orderRes = await query(
      `INSERT INTO orders
         (user_id, instrument_id, broker_order_id, order_type, transaction_type, product_type,
          quantity, price, trigger_price, validity, tag, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'OPEN')
       RETURNING *`,
      [userId, instrument.id, brokerOrderId, order_type, transaction_type, product_type,
       quantity, price || null, trigger_price || null, validity || 'DAY', tag || null]
    );
    const order = orderRes.rows[0];

    // Publish order-events
    await publishMessage(kafkaProducer, TOPICS.ORDER_EVENTS, userId, {
      type: 'ORDER_PLACED',
      orderId: order.id,
      userId,
      instrument: instrument.symbol,
      transactionType: transaction_type,
      quantity,
      price,
      productType: product_type,
    });

    res.status(201).json({ order, message: 'Order placed successfully' });
  } catch (err) {
    console.error('[Orders] Place error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.errors?.[0]?.message || 'Order placement failed' });
  }
});

// ─── GET /api/orders ──────────────────────────────────────────────────────
app.get('/api/orders', async (req, res) => {
  const userId = req.headers['x-user-id'];
  const { status, limit = 50, offset = 0 } = req.query;
  try {
    const conditions = ['o.user_id = $1'];
    const params = [userId];
    if (status) { conditions.push(`o.status = $${params.length + 1}`); params.push(status); }

    const result = await query(
      `SELECT o.*, i.symbol, i.exchange, i.name as instrument_name
       FROM orders o JOIN instruments i ON o.instrument_id = i.id
       WHERE ${conditions.join(' AND ')}
       ORDER BY o.placed_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    res.json({ orders: result.rows, total: result.rowCount });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// ─── GET /api/orders/:orderId ─────────────────────────────────────────────
app.get('/api/orders/:orderId', async (req, res) => {
  const userId = req.headers['x-user-id'];
  try {
    const result = await query(
      `SELECT o.*, i.symbol, i.exchange FROM orders o
       JOIN instruments i ON o.instrument_id = i.id
       WHERE o.id = $1 AND o.user_id = $2`,
      [req.params.orderId, userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Order not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch order' });
  }
});

// ─── PUT /api/orders/:orderId — modify ────────────────────────────────────
app.put('/api/orders/:orderId', async (req, res) => {
  const userId = req.headers['x-user-id'];
  const upstoxToken = req.headers['x-upstox-token'];
  const { quantity, price, trigger_price, validity } = req.body;

  try {
    const existing = await query(
      'SELECT * FROM orders WHERE id = $1 AND user_id = $2',
      [req.params.orderId, userId]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Order not found' });
    const order = existing.rows[0];
    if (!['OPEN','PENDING'].includes(order.status)) {
      return res.status(400).json({ error: 'Can only modify open/pending orders' });
    }

    // Modify via Upstox
    if (upstoxToken && order.broker_order_id) {
      await axios.put(
        `${process.env.UPSTOX_BASE_URL}/order/modify`,
        { order_id: order.broker_order_id, quantity, price, trigger_price, validity },
        { headers: upstoxHeaders(upstoxToken) }
      );
    }

    const updated = await query(
      `UPDATE orders SET quantity=$1, price=$2, trigger_price=$3, validity=$4, updated_at=NOW()
       WHERE id=$5 RETURNING *`,
      [quantity || order.quantity, price || order.price, trigger_price || order.trigger_price,
       validity || order.validity, req.params.orderId]
    );
    res.json(updated.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Order modification failed' });
  }
});

// ─── DELETE /api/orders/:orderId — cancel ─────────────────────────────────
app.delete('/api/orders/:orderId', async (req, res) => {
  const userId = req.headers['x-user-id'];
  const upstoxToken = req.headers['x-upstox-token'];

  try {
    const existing = await query(
      'SELECT * FROM orders WHERE id = $1 AND user_id = $2',
      [req.params.orderId, userId]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Order not found' });
    const order = existing.rows[0];

    if (upstoxToken && order.broker_order_id) {
      await axios.delete(
        `${process.env.UPSTOX_BASE_URL}/order/cancel?order_id=${order.broker_order_id}`,
        { headers: upstoxHeaders(upstoxToken) }
      );
    }

    await query(
      `UPDATE orders SET status='CANCELLED', updated_at=NOW() WHERE id = $1`,
      [req.params.orderId]
    );

    await publishMessage(kafkaProducer, TOPICS.ORDER_EVENTS, userId, {
      type: 'ORDER_CANCELLED', orderId: order.id, userId,
    });

    res.json({ message: 'Order cancelled successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Order cancellation failed' });
  }
});

// ─── Kafka consumer — trade executed events from broker ──────────────────
async function startKafkaConsumer() {
  await createConsumer('order-service-consumer', 'order-service-group',
    [TOPICS.ORDER_EVENTS],
    async (topic, event) => {
      if (event.type !== 'TRADE_EXECUTED') return;
      await query(
        `UPDATE orders SET status='COMPLETE', filled_quantity=$1, average_price=$2, updated_at=NOW()
         WHERE broker_order_id=$3`,
        [event.filledQty, event.avgPrice, event.brokerOrderId]
      );
      await publishMessage(kafkaProducer, TOPICS.PORTFOLIO_UPDATES, event.userId, {
        type: 'HOLDING_UPDATE', userId: event.userId,
        instrumentKey: event.instrumentKey,
        transactionType: event.transactionType,
        quantity: event.filledQty,
        price: event.avgPrice,
      });
    }
  );
}

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'order-service' }));

const PORT = process.env.PORT || 3003;
app.listen(PORT, async () => {
  console.log(`[Order Service] Running on port ${PORT}`);
  kafkaProducer = await createProducer('order-service-producer');
  await startKafkaConsumer();
});
