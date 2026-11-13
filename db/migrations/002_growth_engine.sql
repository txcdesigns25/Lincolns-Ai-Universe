-- Autonomous growth & learning engine.

-- Experiments record the full lifecycle: hypothesis, actions taken, costs, results, lessons.
ALTER TABLE experiments
  ADD COLUMN actions   JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{at, description, task_id}]
  ADD COLUMN cost_cents BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN lessons   TEXT,
  ADD COLUMN expected_benefit NUMERIC,   -- agent's own estimate, used for ranking
  ADD COLUMN expected_cost_cents BIGINT,
  ADD COLUMN channel   TEXT;             -- 'seo','short_form','landing_page','email_followup',...

-- Versioned, reversible self-improvement. Agents may propose new versions of
-- their strategy prompt, playbook, and cadence. They can never touch tools,
-- permissions, or budgets: those fields do not exist here.
CREATE TABLE agent_config_versions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      TEXT NOT NULL REFERENCES agents(id),
  version       INT NOT NULL,
  strategy_prompt TEXT NOT NULL DEFAULT '',
  playbook      JSONB NOT NULL DEFAULT '{}'::jsonb,   -- content strategy, channels, posting cadence...
  cycle_interval_minutes INT NOT NULL DEFAULT 1440 CHECK (cycle_interval_minutes BETWEEN 60 AND 10080),
  rationale     TEXT NOT NULL,
  evidence      JSONB NOT NULL DEFAULT '[]'::jsonb,
  status        TEXT NOT NULL DEFAULT 'proposed'
                CHECK (status IN ('proposed','active','superseded','rejected','rolled_back')),
  proposed_by   TEXT NOT NULL,
  activated_by  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at  TIMESTAMPTZ,
  UNIQUE (agent_id, version)
);
CREATE UNIQUE INDEX one_active_config ON agent_config_versions(agent_id) WHERE status = 'active';

-- Inbound leads captured from landing pages / forms (event-driven entry point).
CREATE TABLE inbound_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source        TEXT NOT NULL,          -- 'landing_form','stripe_webhook','shopify_webhook'
  external_id   TEXT,
  agent_id      TEXT REFERENCES agents(id),
  payload       JSONB NOT NULL,
  processed     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, external_id)
);

-- Drafts: everything an agent creates for the outside world starts here.
-- Publishing a draft is a separate, gated action executed by deterministic code.
CREATE TABLE drafts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      TEXT NOT NULL REFERENCES agents(id),
  draft_type    TEXT NOT NULL CHECK (draft_type IN
                  ('product_listing','proposal','outreach','short_form_script','landing_page','seo_article','ad_copy','support_reply','report','other')),
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  customer_id   UUID REFERENCES customers(id),
  experiment_id UUID REFERENCES experiments(id),
  status        TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','pending_approval','approved','published','rejected')),
  approval_id   UUID REFERENCES approvals(id),
  published_ref TEXT,
  sandbox_publish BOOLEAN,
  task_id       UUID REFERENCES tasks(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX drafts_agent ON drafts(agent_id, created_at DESC);

-- Tool-call journal: makes every LLM tool call idempotent across task retries.
-- Same task + same tool + same input => cached result, no second side effect.
CREATE TABLE tool_calls (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     UUID NOT NULL REFERENCES tasks(id),
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  call_key    TEXT NOT NULL UNIQUE,
  tool        TEXT NOT NULL,
  input       JSONB NOT NULL,
  output      JSONB,
  is_error    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Problems that need a human. Optionally pushed to NOTIFY_WEBHOOK_URL.
CREATE TABLE notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  severity    TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
  agent_id    TEXT REFERENCES agents(id),
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  dedupe_key  TEXT UNIQUE,
  delivered   BOOLEAN NOT NULL DEFAULT FALSE,
  acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Global spend cap across ALL agents (owner-set). Default $50/month.
ALTER TABLE system_controls ADD COLUMN global_monthly_limit BIGINT NOT NULL DEFAULT 5000 CHECK (global_monthly_limit >= 0);
