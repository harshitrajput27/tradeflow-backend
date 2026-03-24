-- Enable TimescaleDB extension
CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── USERS ────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email         VARCHAR(255) UNIQUE NOT NULL,
  phone         VARCHAR(20) UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  full_name     VARCHAR(255) NOT NULL,
  pan_number    VARCHAR(10),
  kyc_status    VARCHAR(20) DEFAULT 'pending' CHECK (kyc_status IN ('pending','verified','rejected')),
  is_active     BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─── REFRESH TOKENS ───────────────────────────────────────────────────────
CREATE TABLE refresh_tokens (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── INSTRUMENTS ──────────────────────────────────────────────────────────
CREATE TABLE instruments (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  symbol        VARCHAR(50) NOT NULL,
  exchange      VARCHAR(20) NOT NULL CHECK (exchange IN ('NSE','BSE','MCX','NFO','BFO')),
  instrument_key VARCHAR(100) UNIQUE NOT NULL,
  name          VARCHAR(255),
  isin          VARCHAR(12),
  type          VARCHAR(20) CHECK (type IN ('EQ','FUT','OPT','ETF','MF')),
  lot_size      INTEGER DEFAULT 1,
  tick_size     DECIMAL(10,4) DEFAULT 0.05,
  UNIQUE(symbol, exchange)
);

-- ─── ORDERS ───────────────────────────────────────────────────────────────
CREATE TABLE orders (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id          UUID NOT NULL REFERENCES users(id),
  instrument_id    UUID NOT NULL REFERENCES instruments(id),
  broker_order_id  VARCHAR(100),
  order_type       VARCHAR(20) NOT NULL CHECK (order_type IN ('MARKET','LIMIT','SL','SL-M')),
  transaction_type VARCHAR(10) NOT NULL CHECK (transaction_type IN ('BUY','SELL')),
  product_type     VARCHAR(20) NOT NULL CHECK (product_type IN ('CNC','MIS','NRML')),
  quantity         INTEGER NOT NULL,
  price            DECIMAL(12,2),
  trigger_price    DECIMAL(12,2),
  filled_quantity  INTEGER DEFAULT 0,
  average_price    DECIMAL(12,2),
  status           VARCHAR(20) DEFAULT 'PENDING' CHECK (status IN ('PENDING','OPEN','COMPLETE','CANCELLED','REJECTED')),
  validity         VARCHAR(10) DEFAULT 'DAY' CHECK (validity IN ('DAY','IOC','GTC')),
  tag              VARCHAR(100),
  rejection_reason TEXT,
  placed_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_orders_user_id ON orders(user_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_placed_at ON orders(placed_at DESC);

-- ─── TRADES (executions) ──────────────────────────────────────────────────
CREATE TABLE trades (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id         UUID NOT NULL REFERENCES orders(id),
  user_id          UUID NOT NULL REFERENCES users(id),
  instrument_id    UUID NOT NULL REFERENCES instruments(id),
  transaction_type VARCHAR(10) NOT NULL,
  quantity         INTEGER NOT NULL,
  price            DECIMAL(12,2) NOT NULL,
  brokerage        DECIMAL(10,4) DEFAULT 0,
  stt              DECIMAL(10,4) DEFAULT 0,
  exchange_charges DECIMAL(10,4) DEFAULT 0,
  gst              DECIMAL(10,4) DEFAULT 0,
  sebi_charges     DECIMAL(10,4) DEFAULT 0,
  net_amount       DECIMAL(12,4),
  trade_id         VARCHAR(100),
  traded_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_trades_user_id ON trades(user_id);
CREATE INDEX idx_trades_traded_at ON trades(traded_at DESC);

-- ─── HOLDINGS ─────────────────────────────────────────────────────────────
CREATE TABLE holdings (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID NOT NULL REFERENCES users(id),
  instrument_id     UUID NOT NULL REFERENCES instruments(id),
  quantity          INTEGER NOT NULL DEFAULT 0,
  average_buy_price DECIMAL(12,4) NOT NULL,
  last_price        DECIMAL(12,2),
  pnl               DECIMAL(12,4),
  day_change        DECIMAL(12,4),
  day_change_pct    DECIMAL(8,4),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, instrument_id)
);
CREATE INDEX idx_holdings_user_id ON holdings(user_id);

-- ─── POSITIONS (intraday) ─────────────────────────────────────────────────
CREATE TABLE positions (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id          UUID NOT NULL REFERENCES users(id),
  instrument_id    UUID NOT NULL REFERENCES instruments(id),
  product_type     VARCHAR(20) NOT NULL,
  quantity         INTEGER NOT NULL DEFAULT 0,
  overnight_qty    INTEGER DEFAULT 0,
  buy_quantity     INTEGER DEFAULT 0,
  sell_quantity    INTEGER DEFAULT 0,
  average_price    DECIMAL(12,4),
  last_price       DECIMAL(12,2),
  pnl              DECIMAL(12,4),
  m2m              DECIMAL(12,4),
  realised_pnl     DECIMAL(12,4) DEFAULT 0,
  unrealised_pnl   DECIMAL(12,4) DEFAULT 0,
  value            DECIMAL(12,4),
  multiplier       INTEGER DEFAULT 1,
  trade_date       DATE NOT NULL DEFAULT CURRENT_DATE,
  updated_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, instrument_id, product_type, trade_date)
);

-- ─── FUNDS / MARGIN ───────────────────────────────────────────────────────
CREATE TABLE funds (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id          UUID NOT NULL REFERENCES users(id) UNIQUE,
  available_cash   DECIMAL(14,4) DEFAULT 0,
  used_margin      DECIMAL(14,4) DEFAULT 0,
  total_funds      DECIMAL(14,4) DEFAULT 0,
  withdrawable     DECIMAL(14,4) DEFAULT 0,
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ─── MUTUAL FUNDS ─────────────────────────────────────────────────────────
CREATE TABLE mf_holdings (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id      UUID NOT NULL REFERENCES users(id),
  scheme_code  VARCHAR(20) NOT NULL,
  scheme_name  VARCHAR(255),
  folio_no     VARCHAR(50),
  units        DECIMAL(14,4) NOT NULL,
  avg_nav      DECIMAL(12,4) NOT NULL,
  current_nav  DECIMAL(12,4),
  invested_amt DECIMAL(14,4),
  current_val  DECIMAL(14,4),
  pnl          DECIMAL(14,4),
  pnl_pct      DECIMAL(8,4),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, scheme_code, folio_no)
);

-- ─── TICK DATA (TimescaleDB hypertable) ────────────────────────────────────
CREATE TABLE market_ticks (
  time          TIMESTAMPTZ NOT NULL,
  instrument_key VARCHAR(100) NOT NULL,
  ltp           DECIMAL(12,2),
  volume        BIGINT,
  oi            BIGINT,
  bid           DECIMAL(12,2),
  ask           DECIMAL(12,2),
  open          DECIMAL(12,2),
  high          DECIMAL(12,2),
  low           DECIMAL(12,2),
  close         DECIMAL(12,2),
  change        DECIMAL(10,4),
  change_pct    DECIMAL(8,4)
);
SELECT create_hypertable('market_ticks', 'time', if_not_exists => TRUE);
CREATE INDEX idx_market_ticks_key ON market_ticks(instrument_key, time DESC);

-- ─── AUDIT LOG ─────────────────────────────────────────────────────────────
CREATE TABLE audit_logs (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID REFERENCES users(id),
  action     VARCHAR(100) NOT NULL,
  entity     VARCHAR(50),
  entity_id  VARCHAR(100),
  ip_address INET,
  user_agent TEXT,
  metadata   JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_audit_logs_user_id ON audit_logs(user_id, created_at DESC);

-- ─── SEED INSTRUMENTS ─────────────────────────────────────────────────────
INSERT INTO instruments (symbol, exchange, instrument_key, name, isin, type, lot_size, tick_size) VALUES
('RELIANCE','NSE','NSE_EQ|INE002A01018','Reliance Industries Ltd','INE002A01018','EQ',1,0.05),
('TCS','NSE','NSE_EQ|INE467B01029','Tata Consultancy Services','INE467B01029','EQ',1,0.05),
('INFY','NSE','NSE_EQ|INE009A01021','Infosys Ltd','INE009A01021','EQ',1,0.05),
('HDFCBANK','NSE','NSE_EQ|INE040A01034','HDFC Bank Ltd','INE040A01034','EQ',1,0.05),
('ICICIBANK','NSE','NSE_EQ|INE090A01021','ICICI Bank Ltd','INE090A01021','EQ',1,0.05),
('NIFTY24DEC23500CE','NFO','NFO_OPT|NIFTY24DEC23500CE','NIFTY 23500 CE Dec 2024','','OPT',50,0.05);

-- ─── ROLE column on users ──────────────────────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'user';

-- ─── KYC DOCUMENTS ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kyc_documents (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id),
  doc_type    VARCHAR(30) NOT NULL,
  file_path   TEXT NOT NULL,
  status      VARCHAR(20) DEFAULT 'pending',
  uploaded_by UUID REFERENCES users(id),
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── NOTIFICATION LOGS ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notification_logs (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID REFERENCES users(id),
  type       VARCHAR(50) NOT NULL,
  channel    VARCHAR(20) NOT NULL,
  status     VARCHAR(20) NOT NULL,
  metadata   JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notification_logs_user ON notification_logs(user_id, created_at DESC);

-- ─── PRICE ALERTS ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS price_alerts (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id        UUID NOT NULL REFERENCES users(id),
  instrument_key VARCHAR(100) NOT NULL,
  symbol         VARCHAR(50),
  condition      VARCHAR(10) NOT NULL CHECK (condition IN ('above','below')),
  target_price   DECIMAL(12,2) NOT NULL,
  is_active      BOOLEAN DEFAULT true,
  triggered_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_price_alerts_active ON price_alerts(instrument_key) WHERE is_active = true;
