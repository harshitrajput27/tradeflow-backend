-- Add to docker/init.sql or run as a migration

CREATE TABLE IF NOT EXISTS notification_logs (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID REFERENCES users(id),
  type       VARCHAR(50) NOT NULL,
  channel    VARCHAR(20) NOT NULL,    -- email | sms | both
  status     VARCHAR(20) NOT NULL,    -- sent | failed | dry-run
  metadata   JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_notification_logs_user ON notification_logs(user_id, created_at DESC);

-- Price alerts table
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
CREATE INDEX idx_price_alerts_active ON price_alerts(instrument_key) WHERE is_active = true;
