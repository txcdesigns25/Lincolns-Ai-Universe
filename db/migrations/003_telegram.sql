-- Small key/value store for process state (e.g. Telegram update offset).
CREATE TABLE kv_store (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
