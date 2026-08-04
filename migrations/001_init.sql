-- The channels that this service can select.
--
-- The cost is a relative weight, not money. A smaller number is cheaper.
-- NUMERIC, never FLOAT: a repeated sum of a float drifts.
CREATE TABLE IF NOT EXISTS channels (
  id         TEXT          PRIMARY KEY,
  name       TEXT          NOT NULL,
  cost       NUMERIC(10,4) NOT NULL CHECK (cost >= 0),
  corridor   TEXT          NOT NULL DEFAULT 'NGN_BANK',
  enabled    BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_channels_corridor_enabled
  ON channels (corridor, enabled);

-- Every decision, with the full candidate list.
--
-- The record is the product. A routing system that cannot explain a choice is
-- not operable, and an operator will not trust it.
CREATE TABLE IF NOT EXISTS routing_decisions (
  id             TEXT        PRIMARY KEY,
  transaction_id TEXT        NOT NULL,
  channel_id     TEXT        NOT NULL,
  strategy       TEXT        NOT NULL,
  window_ms      INTEGER     NOT NULL,
  candidates     JSONB       NOT NULL,
  evaluated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_routing_decisions_evaluated_at
  ON routing_decisions (evaluated_at DESC);

CREATE INDEX IF NOT EXISTS ix_routing_decisions_transaction
  ON routing_decisions (transaction_id);
