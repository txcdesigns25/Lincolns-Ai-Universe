-- Owner decision (2026-11-13): no per-agent spending limits and no daily AI cap.
-- The global monthly cap (set by the owner on Budgets) is the single backstop.
-- Per-agent limits stay in the schema and can be switched back on from Budgets.
ALTER TABLE system_controls ADD COLUMN IF NOT EXISTS per_agent_limits_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE system_controls ALTER COLUMN global_daily_limit DROP NOT NULL;
ALTER TABLE system_controls ALTER COLUMN global_daily_limit DROP DEFAULT;
UPDATE system_controls SET global_daily_limit = NULL, per_agent_limits_enabled = FALSE;
