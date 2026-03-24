# TradeFlow — Complete Trading Platform Backend

Full microservices backend for a trading platform (NSE · BSE · F&O).
Node.js · Kafka · Redis · PostgreSQL (TimescaleDB)

## Services

| Service | Port | Description |
|---------|------|-------------|
| API Gateway | 3000 | JWT auth, rate limiting, WebSocket, proxy |
| Auth Service | 3001 | Register, login, JWT, Upstox OAuth2 |
| Market Data | 3002 | Upstox/AngelOne WS feed, quotes, OHLC |
| Order Service | 3003 | Place / modify / cancel orders |
| Portfolio | 3004 | Holdings, positions, P&L, MF |
| Notifications | 3005 | Email (SendGrid) + SMS (Twilio) on trades |
| Admin | 3006 | KYC queue, user management, stats |

## Infrastructure

| Service | Port | Description |
|---------|------|-------------|
| PostgreSQL/TimescaleDB | 5432 | Primary database |
| Redis | 6379 | Cache, sessions, pub/sub |
| Kafka | 9092 | Event streaming |
| Kafka UI | 8080 | Topic browser |

## Quick Start

```bash
# 1. Configure environment
cp .env.example .env
# Edit .env — fill in Upstox/AngelOne API keys at minimum

# 2. Start everything
docker compose up -d

# 3. Verify all services
curl http://localhost:3000/health   # Gateway
curl http://localhost:3001/health   # Auth
curl http://localhost:3002/health   # Market Data
curl http://localhost:3003/health   # Orders
curl http://localhost:3004/health   # Portfolio
curl http://localhost:3005/health   # Notifications
curl http://localhost:3006/health   # Admin
```

Kafka UI: http://localhost:8080

## Project Structure

```
tradeflow/
├── docker-compose.yml
├── .env.example
├── docker/
│   └── init.sql                    ← Full DB schema (15 tables)
├── shared/
│   ├── db/pool.js                  ← PostgreSQL pool + transactions
│   ├── kafka/client.js             ← Producer/consumer helpers
│   └── redis/client.js             ← Cache, pub/sub, sessions
├── api-gateway/
│   └── src/index.js                ← Gateway + WebSocket server
├── services/
│   ├── auth-service/               ← Login, register, JWT, Upstox OAuth
│   ├── market-data-service/        ← Live feed, quotes, OHLC
│   ├── order-service/              ← Order lifecycle
│   ├── portfolio-service/          ← Holdings, positions, MF
│   ├── notification-service/       ← Email + SMS notifications
│   └── admin-service/              ← KYC, user mgmt, audit logs
└── frontend/
    └── src/
        ├── context/AuthContext.jsx ← JWT + Upstox OAuth state
        ├── hooks/
        │   ├── useMarketSocket.js  ← Live tick subscriptions
        │   └── useTrading.js       ← Orders, portfolio, search hooks
        └── components/
            ├── auth/LoginPage.jsx  ← Login + Upstox OAuth button
            └── admin/KYCDashboard.jsx
```

## API Reference

### Auth
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/auth/register` | — | Register with email/password |
| POST | `/api/auth/login` | — | Login → JWT tokens |
| POST | `/api/auth/refresh` | — | Rotate refresh token |
| POST | `/api/auth/logout` | JWT | Revoke tokens |
| GET | `/api/auth/me` | JWT | Current user profile |
| GET | `/api/auth/upstox/login` | — | Start Upstox OAuth flow |
| GET | `/api/auth/upstox/callback` | — | OAuth callback (set as redirect URI) |
| GET | `/api/auth/upstox/token` | JWT | Get fresh Upstox access token |

### Market Data
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/market/quote/:instrumentKey` | Live LTP |
| GET | `/api/market/ohlc/:instrumentKey?interval=1day&from=&to=` | Candles |
| GET | `/api/market/indices` | NIFTY 50, SENSEX, BANK NIFTY |
| GET | `/api/market/search?q=reliance` | Instrument search |
| POST | `/api/market/subscribe` | Add to live feed |

### Orders
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/orders/place` | Place order |
| GET | `/api/orders` | List orders |
| GET | `/api/orders/:id` | Order detail |
| PUT | `/api/orders/:id` | Modify order |
| DELETE | `/api/orders/:id` | Cancel order |

### Portfolio
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/portfolio/holdings` | Equity holdings + P&L |
| GET | `/api/portfolio/positions` | Intraday positions |
| GET | `/api/portfolio/funds` | Available margin |
| GET | `/api/portfolio/mutual-funds` | MF holdings |
| GET | `/api/portfolio/pnl?period=today` | P&L by period |

### Admin (requires role: admin)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/admin/stats` | Platform stats |
| GET | `/api/admin/users` | User list with search/filter |
| PATCH | `/api/admin/users/:id` | Activate/deactivate user |
| GET | `/api/admin/kyc?status=pending` | KYC queue |
| POST | `/api/admin/kyc/:id/review` | Approve or reject KYC |
| GET | `/api/admin/audit-logs` | Full audit trail |

## WebSocket (Live Ticks)

```js
import { io } from 'socket.io-client';
const socket = io('http://localhost:3000', {
  auth: { token: 'YOUR_JWT_ACCESS_TOKEN' }
});
socket.emit('subscribe', ['NSE_EQ|INE002A01018', 'NSE_INDEX|Nifty 50']);
socket.on('tick', (tick) => {
  console.log(tick); // { instrument_key, ltp, volume, bid, ask, ... }
});
```

## Frontend Usage

```jsx
// main.jsx
import { AuthProvider } from './context/AuthContext';
<AuthProvider><App /></AuthProvider>

// Live ticks
import { useIndexTicks, useSingleTick } from './hooks/useMarketSocket';
const { nifty50, sensex, bankNifty } = useIndexTicks();
const { tick } = useSingleTick('NSE_EQ|INE002A01018');

// Orders
import { useOrders } from './hooks/useTrading';
const { orders, placeOrder, cancelOrder } = useOrders();
await placeOrder({ instrument_key: 'NSE_EQ|INE002A01018', order_type: 'MARKET', transaction_type: 'BUY', product_type: 'CNC', quantity: 1 });
```

## Kafka Topics

| Topic | Events |
|-------|--------|
| `market-data` | tick, OHLCV |
| `order-events` | ORDER_PLACED, ORDER_CANCELLED, TRADE_EXECUTED |
| `portfolio-updates` | HOLDING_UPDATE |
| `notifications` | USER_REGISTERED, USER_LOGIN, KYC_STATUS_CHANGED, PRICE_ALERT |

## Upstox OAuth Setup

1. Go to https://developer.upstox.com → create an app
2. Set redirect URI to `http://localhost:3000/api/auth/upstox/callback`
3. Copy API Key + Secret into `.env`
4. Users click "Continue with Upstox" → auto-registered + JWT issued

## Make a user admin

```sql
UPDATE users SET role = 'admin' WHERE email = 'your@email.com';
```

## Development (without Docker)

```bash
# Start infra only
docker compose up -d postgres redis kafka zookeeper

# Run all services locally in separate terminals
cd services/auth-service && npm install && npm run dev          # :3001
cd services/market-data-service && npm install && npm run dev  # :3002
cd services/order-service && npm install && npm run dev        # :3003
cd services/portfolio-service && npm install && npm run dev    # :3004
cd services/notification-service && npm install && npm run dev # :3005
cd services/admin-service && npm install && npm run dev        # :3006
cd api-gateway && npm install && npm run dev                   # :3000
```
