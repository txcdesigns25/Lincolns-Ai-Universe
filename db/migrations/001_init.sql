-- AI Universe core schema.
-- Money is stored as integer cents (BIGINT) everywhere. Never floats.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ───────────────────────── Global controls ─────────────────────────
-- Single-row table. The emergency stop lives here and is checked by the
-- backend before every spend authorization and every external action.
CREATE TABLE system_controls (
  id              BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  emergency_stop  BOOLEAN NOT NULL DEFAULT FALSE,
  stop_reason     TEXT,
  stopped_at      TIMESTAMPTZ,
  stopped_by      TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO system_controls (id) VALUES (TRUE);

-- ───────────────────────── Agents ─────────────────────────
CREATE TABLE agents (
  id            TEXT PRIMARY KEY,                -- e.g. 'ceo', 'digital_store'
  code          TEXT NOT NULL UNIQUE,            -- e.g. 'CEO', 'A01'
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('ceo','business')),
  mission       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'paused'
                CHECK (status IN ('active','paused','error','disabled')),
  -- Production activation is separate from status: an agent can be 'active'
  -- in sandbox mode only. External (real-world) actions require live = true.
  live_mode     BOOLEAN NOT NULL DEFAULT FALSE,
  current_task_id UUID,
  last_heartbeat  TIMESTAMPTZ,
  config        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Budgets are configured by the human owner only. Agents have no write path.
CREATE TABLE agent_budgets (
  agent_id            TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  starting_budget     BIGINT NOT NULL DEFAULT 0 CHECK (starting_budget >= 0),
  daily_limit         BIGINT NOT NULL DEFAULT 0 CHECK (daily_limit >= 0),
  weekly_limit        BIGINT NOT NULL DEFAULT 0 CHECK (weekly_limit >= 0),
  monthly_limit       BIGINT NOT NULL DEFAULT 0 CHECK (monthly_limit >= 0),
  per_transaction_limit BIGINT NOT NULL DEFAULT 0 CHECK (per_transaction_limit >= 0),
  ai_monthly_limit    BIGINT NOT NULL DEFAULT 0 CHECK (ai_monthly_limit >= 0),
  ads_monthly_limit   BIGINT NOT NULL DEFAULT 0 CHECK (ads_monthly_limit >= 0),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by          TEXT NOT NULL DEFAULT 'system'
);

-- Level-2 preauthorizations: the owner explicitly allows an agent to perform
-- a given action automatically, optionally with constraints.
CREATE TABLE agent_permissions (
  agent_id     TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  action       TEXT NOT NULL,
  constraints  JSONB NOT NULL DEFAULT '{}'::jsonb,
  granted_by   TEXT NOT NULL,
  granted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, action)
);

-- ───────────────────────── Spend reservations ─────────────────────────
-- Every outgoing cost (AI tokens, software, ads...) is first *authorized*
-- (reserved) under a row lock on agent_budgets, then *settled* with the
-- actual amount, or *released*. Reservations count against limits, so two
-- concurrent workers cannot both slip under a limit.
CREATE TABLE spend_authorizations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        TEXT NOT NULL REFERENCES agents(id),
  category        TEXT NOT NULL CHECK (category IN
                    ('ai_api','software','advertising','hosting','other')),
  amount_cents    BIGINT NOT NULL CHECK (amount_cents > 0),
  settled_cents   BIGINT,
  status          TEXT NOT NULL CHECK (status IN ('reserved','settled','released','denied')),
  reason          TEXT NOT NULL,
  denial_reason   TEXT,
  idempotency_key TEXT UNIQUE,
  task_id         UUID,
  approval_id     UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at      TIMESTAMPTZ
);
CREATE INDEX spend_auth_agent_time ON spend_authorizations(agent_id, created_at);

-- ───────────────────────── Ledger ─────────────────────────
-- Append-only financial ledger. Revenue is only counted as "verified" when it
-- comes from a payment provider record (source != 'manual_unverified').
CREATE TABLE ledger_entries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        TEXT NOT NULL REFERENCES agents(id),
  entry_type      TEXT NOT NULL CHECK (entry_type IN
                    ('revenue','refund','processing_fee','ai_api','software',
                     'advertising','hosting','other_expense')),
  -- Positive for revenue, negative for anything that reduces profit.
  amount_cents    BIGINT NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'USD',
  source          TEXT NOT NULL,      -- 'stripe','shopify','anthropic_usage','manual','sandbox'
  external_ref    TEXT,               -- provider id (charge id, order id...)
  verified        BOOLEAN NOT NULL DEFAULT FALSE,
  sandbox         BOOLEAN NOT NULL DEFAULT FALSE,
  customer_id     UUID,
  description     TEXT,
  idempotency_key TEXT UNIQUE,        -- dedupes webhook redeliveries
  spend_authorization_id UUID REFERENCES spend_authorizations(id),
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((entry_type = 'revenue' AND amount_cents >= 0)
      OR (entry_type <> 'revenue' AND amount_cents <= 0))
);
CREATE INDEX ledger_agent_time ON ledger_entries(agent_id, occurred_at);
CREATE UNIQUE INDEX ledger_source_ref ON ledger_entries(source, external_ref, entry_type)
  WHERE external_ref IS NOT NULL;

CREATE OR REPLACE FUNCTION append_only() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_no_update BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION append_only();

-- ───────────────────────── Customers ─────────────────────────
-- Customers belong to exactly one owning agent. Other agents can only see a
-- customer through an explicit, owner-approved data share.
CREATE TABLE customers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_agent_id TEXT NOT NULL REFERENCES agents(id),
  name          TEXT NOT NULL,
  email         TEXT,
  company       TEXT,
  status        TEXT NOT NULL DEFAULT 'lead' CHECK (status IN ('lead','prospect','active','churned')),
  source        TEXT,
  sandbox       BOOLEAN NOT NULL DEFAULT FALSE,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE customer_shares (
  customer_id   UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  agent_id      TEXT NOT NULL REFERENCES agents(id),
  approval_id   UUID,
  granted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, agent_id)
);

-- ───────────────────────── Tasks / durable queue ─────────────────────────
CREATE TABLE tasks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        TEXT NOT NULL REFERENCES agents(id),
  type            TEXT NOT NULL,
  title           TEXT NOT NULL,
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN
                    ('queued','running','waiting_approval','succeeded','failed','dead','cancelled')),
  priority        INT NOT NULL DEFAULT 5,            -- lower = sooner
  attempts        INT NOT NULL DEFAULT 0,
  max_attempts    INT NOT NULL DEFAULT 3,
  run_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_by       TEXT,
  locked_until    TIMESTAMPTZ,                       -- lease; expired = crashed worker
  idempotency_key TEXT UNIQUE,
  parent_task_id  UUID REFERENCES tasks(id),
  created_by      TEXT NOT NULL DEFAULT 'system',   -- 'owner','ceo','scheduler',agent id
  result          JSONB,
  last_error      TEXT,
  cost_cents      BIGINT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ
);
CREATE INDEX tasks_claim ON tasks(status, run_at, priority) WHERE status = 'queued';
CREATE INDEX tasks_agent ON tasks(agent_id, created_at DESC);

-- Recurring schedules. The worker's scheduler turns due schedules into tasks
-- (idempotently, keyed by schedule + slot) so restarts never double-enqueue.
CREATE TABLE schedules (
  id              TEXT PRIMARY KEY,
  agent_id        TEXT NOT NULL REFERENCES agents(id),
  task_type       TEXT NOT NULL,
  title           TEXT NOT NULL,
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  interval_minutes INT NOT NULL CHECK (interval_minutes >= 5),
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  next_run_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_enqueued_at TIMESTAMPTZ
);

-- ───────────────────────── Approvals ─────────────────────────
CREATE TABLE approvals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        TEXT NOT NULL REFERENCES agents(id),
  task_id         UUID REFERENCES tasks(id),
  action          TEXT NOT NULL,
  level           INT NOT NULL CHECK (level IN (2,3)),
  summary         TEXT NOT NULL,
  details         JSONB NOT NULL DEFAULT '{}'::jsonb,
  amount_cents    BIGINT,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected','expired','executed')),
  decided_by      TEXT,
  decision_note   TEXT,
  idempotency_key TEXT UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at      TIMESTAMPTZ,
  executed_at     TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT now() + interval '7 days'
);
CREATE INDEX approvals_pending ON approvals(status, created_at) WHERE status = 'pending';

-- ───────────────────────── Agent messages ─────────────────────────
CREATE TABLE agent_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_agent_id   TEXT NOT NULL REFERENCES agents(id),
  to_agent_id     TEXT NOT NULL REFERENCES agents(id),
  kind            TEXT NOT NULL CHECK (kind IN ('request','info','handoff','report')),
  subject         TEXT NOT NULL,
  body            JSONB NOT NULL DEFAULT '{}'::jsonb,
  customer_id     UUID REFERENCES customers(id),
  read_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ───────────────────────── Memory & learning ─────────────────────────
-- kind separates what an agent *saw*, what it *thinks*, and what is *proven*.
-- A 'verified_result' must reference evidence (ledger rows / experiment).
CREATE TABLE memories (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        TEXT NOT NULL REFERENCES agents(id),
  kind            TEXT NOT NULL CHECK (kind IN
                    ('observation','hypothesis','verified_result','mistake','strategy','customer_feedback')),
  title           TEXT NOT NULL,
  content         TEXT NOT NULL,
  tags            TEXT[] NOT NULL DEFAULT '{}',
  confidence      NUMERIC(3,2) CHECK (confidence BETWEEN 0 AND 1),
  evidence        JSONB NOT NULL DEFAULT '[]'::jsonb,
  experiment_id   UUID,
  task_id         UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  search          TSVECTOR GENERATED ALWAYS AS
                    (to_tsvector('english', title || ' ' || content)) STORED,
  CHECK (kind <> 'verified_result' OR jsonb_array_length(evidence) > 0)
);
CREATE INDEX memories_search ON memories USING GIN(search);
CREATE INDEX memories_agent ON memories(agent_id, created_at DESC);

CREATE TABLE experiments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        TEXT NOT NULL REFERENCES agents(id),
  hypothesis      TEXT NOT NULL,
  strategy        TEXT NOT NULL,
  metric          TEXT NOT NULL,
  variants        JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{name, description}]
  results         JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {variant: {trials, conversions}}
  status          TEXT NOT NULL DEFAULT 'proposed'
                  CHECK (status IN ('proposed','running','concluded','abandoned')),
  conclusion      TEXT,
  winner          TEXT,
  min_sample_size INT NOT NULL DEFAULT 100,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  concluded_at    TIMESTAMPTZ
);

-- ───────────────────────── Audit log ─────────────────────────
CREATE TABLE audit_log (
  id          BIGSERIAL PRIMARY KEY,
  actor       TEXT NOT NULL,          -- 'owner', 'worker:xyz', agent id
  agent_id    TEXT,
  action      TEXT NOT NULL,
  outcome     TEXT NOT NULL CHECK (outcome IN ('allowed','denied','error','info')),
  details     JSONB NOT NULL DEFAULT '{}'::jsonb,
  task_id     UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_time ON audit_log(created_at DESC);
CREATE INDEX audit_agent ON audit_log(agent_id, created_at DESC);
CREATE TRIGGER audit_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION append_only();

-- ───────────────────────── Worker heartbeats ─────────────────────────
CREATE TABLE workers (
  id            TEXT PRIMARY KEY,
  hostname      TEXT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_heartbeat TIMESTAMPTZ NOT NULL DEFAULT now(),
  tasks_done    INT NOT NULL DEFAULT 0
);

CREATE TABLE schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
