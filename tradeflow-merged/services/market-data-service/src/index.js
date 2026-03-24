const express  = require('express');
const WebSocket = require('ws');
const axios     = require('axios');
const { getRedisClient, publishTick, cacheSet, cacheGet } = require('../../../shared/redis/client');
const { createProducer, publishMessage, TOPICS } = require('../../../shared/kafka/client');

const app = express();
app.use(express.json());

let kafkaProducer;
let upstoxWs = null;
const subscribedInstruments = new Set();

// ─── Upstox WebSocket market feed ──────────────────────────────────────────
async function connectUpstoxFeed(accessToken) {
  if (upstoxWs) upstoxWs.terminate();

  upstoxWs = new WebSocket('wss://api.upstox.com/v2/feed/market-data-streamer/generic/api_2.0', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  upstoxWs.on('open', () => {
    console.log('[MarketData] Upstox WebSocket connected');
    if (subscribedInstruments.size > 0) {
      subscribeToInstruments([...subscribedInstruments]);
    }
  });

  upstoxWs.on('message', async (data) => {
    try {
      // Upstox sends binary protobuf — simplified JSON handling here
      const tick = JSON.parse(data.toString());
      await processTick(tick);
    } catch {}
  });

  upstoxWs.on('error',   (err) => console.error('[MarketData] WS error:', err.message));
  upstoxWs.on('close',   ()    => {
    console.log('[MarketData] WS closed — reconnecting in 5s');
    setTimeout(() => connectUpstoxFeed(accessToken), 5000);
  });
}

function subscribeToInstruments(instrumentKeys) {
  if (!upstoxWs || upstoxWs.readyState !== WebSocket.OPEN) return;
  const payload = {
    guid: Date.now().toString(),
    method: 'sub',
    data: { mode: 'full', instrumentKeys },
  };
  upstoxWs.send(JSON.stringify(payload));
}

async function processTick(rawTick) {
  // Normalise Upstox feed format
  const tick = {
    instrument_key: rawTick.feeds?.key || rawTick.instrument_key,
    ltp:            rawTick.feeds?.ff?.marketFF?.ltpc?.ltp || rawTick.ltp,
    volume:         rawTick.feeds?.ff?.marketFF?.ltpc?.vol || 0,
    oi:             rawTick.feeds?.ff?.marketFF?.oi || 0,
    bid:            rawTick.feeds?.ff?.marketFF?.bp1 || 0,
    ask:            rawTick.feeds?.ff?.marketFF?.sp1 || 0,
    open:           rawTick.feeds?.ff?.marketFF?.ohlc?.open || 0,
    high:           rawTick.feeds?.ff?.marketFF?.ohlc?.high || 0,
    low:            rawTick.feeds?.ff?.marketFF?.ohlc?.low || 0,
    close:          rawTick.feeds?.ff?.marketFF?.ohlc?.close || 0,
    timestamp:      Date.now(),
  };

  if (!tick.instrument_key || !tick.ltp) return;

  // 1. Publish to Redis pub/sub → Gateway → WebSocket clients
  await publishTick(tick.instrument_key, tick);

  // 2. Publish to Kafka market-data topic for consumers
  await publishMessage(kafkaProducer, TOPICS.MARKET_DATA, tick.instrument_key, tick);
}

// ─── Angel One feed (fallback / alternative) ───────────────────────────────
async function connectAngelOneFeed() {
  try {
    const SmartAPIWebSocket = require('smartapi-javascript').WebSocket;
    const feed = new SmartAPIWebSocket(
      process.env.ANGEL_ONE_CLIENT_CODE,
      process.env.ANGEL_ONE_FEED_TOKEN,
      process.env.ANGEL_ONE_CLIENT_CODE
    );

    feed.connect();
    feed.on('tick', async (ticks) => {
      for (const raw of ticks) {
        const tick = {
          instrument_key: `NSE_EQ|${raw.token}`,
          ltp:       raw.last_traded_price / 100,
          volume:    raw.volume,
          open:      raw.open_price_of_the_day / 100,
          high:      raw.high_price_of_the_day / 100,
          low:       raw.low_price_of_the_day / 100,
          close:     raw.closed_price / 100,
          timestamp: Date.now(),
        };
        await processTick(tick);
      }
    });
  } catch (err) {
    console.error('[MarketData] Angel One feed error:', err.message);
  }
}

// ─── REST API routes ───────────────────────────────────────────────────────
// GET /api/market/quote/:instrumentKey
app.get('/api/market/quote/:instrumentKey', async (req, res) => {
  try {
    const { instrumentKey } = req.params;
    const cached = await cacheGet(`ltp:${instrumentKey}`);
    if (cached) return res.json(cached);

    // Fallback: fetch from Upstox REST
    const response = await axios.get(
      `${process.env.UPSTOX_BASE_URL}/market-quote/ltp?instrument_key=${encodeURIComponent(instrumentKey)}`,
      { headers: { Authorization: `Bearer ${req.headers['x-upstox-token']}` } }
    );
    const data = response.data?.data?.[instrumentKey.replace('|', '_')] || {};
    await cacheSet(`ltp:${instrumentKey}`, data, 5);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch quote' });
  }
});

// GET /api/market/ohlc/:instrumentKey?interval=1minute&from=2024-01-01&to=2024-01-31
app.get('/api/market/ohlc/:instrumentKey', async (req, res) => {
  try {
    const { instrumentKey } = req.params;
    const { interval = '1day', from, to } = req.query;
    const cacheKey = `ohlc:${instrumentKey}:${interval}:${from}:${to}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const response = await axios.get(
      `${process.env.UPSTOX_BASE_URL}/historical-candle/${encodeURIComponent(instrumentKey)}/${interval}/${to}/${from}`,
      { headers: { Authorization: `Bearer ${req.headers['x-upstox-token']}` } }
    );
    const data = response.data?.data?.candles || [];
    await cacheSet(cacheKey, data, 300);
    res.json({ candles: data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch OHLC data' });
  }
});

// POST /api/market/subscribe — add instruments to live feed
app.post('/api/market/subscribe', async (req, res) => {
  const { instrumentKeys } = req.body;
  if (!Array.isArray(instrumentKeys)) return res.status(400).json({ error: 'instrumentKeys must be array' });
  instrumentKeys.forEach(k => subscribedInstruments.add(k));
  subscribeToInstruments(instrumentKeys);
  res.json({ subscribed: instrumentKeys, total: subscribedInstruments.size });
});

// GET /api/market/indices — NIFTY 50, SENSEX, BANK NIFTY
app.get('/api/market/indices', async (req, res) => {
  const indices = ['NSE_INDEX|Nifty 50', 'BSE_INDEX|SENSEX', 'NSE_INDEX|Nifty Bank'];
  const results = {};
  for (const key of indices) {
    results[key] = await cacheGet(`ltp:${key}`) || { instrument_key: key, ltp: null };
  }
  res.json(results);
});

// GET /api/market/search?q=reliance
app.get('/api/market/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json([]);
    const { query: dbQuery } = require('../../../shared/db/pool');
    const result = await dbQuery(
      `SELECT id, symbol, name, exchange, instrument_key, type
       FROM instruments WHERE symbol ILIKE $1 OR name ILIKE $1 LIMIT 20`,
      [`${q}%`]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Search failed' });
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'market-data-service' }));

// ─── Bootstrap ───────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3002;
app.listen(PORT, async () => {
  console.log(`[MarketData Service] Running on port ${PORT}`);
  kafkaProducer = await createProducer('market-data-producer');
  // Default subscriptions — indices
  subscribeToInstruments(['NSE_INDEX|Nifty 50', 'BSE_INDEX|SENSEX', 'NSE_INDEX|Nifty Bank']);
});
