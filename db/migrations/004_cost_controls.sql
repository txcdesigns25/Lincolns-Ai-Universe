-- Cost controls (2026-11-13): cheap-by-default agents.
-- 1. A global DAILY cap on AI spend across all agents ($1.50/day by default).
ALTER TABLE system_controls ADD COLUMN IF NOT EXISTS global_daily_limit BIGINT NOT NULL DEFAULT 150 CHECK (global_daily_limit >= 0);

-- 2. Per-agent "boost": the owner marks an agent as working on an important
--    project, and its tasks use the stronger model. Off by default.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS boost BOOLEAN NOT NULL DEFAULT FALSE;

-- 3. Lower per-agent defaults, but only where the owner has not set them.
UPDATE agent_budgets SET daily_limit = 25, weekly_limit = 100, monthly_limit = 300, ai_monthly_limit = 300
 WHERE updated_by = 'system';

-- 4. Stagger existing schedules so a resume does not fire every agent at once.
WITH ordered AS (
  SELECT id, task_type, row_number() OVER (ORDER BY agent_id, id) AS n
    FROM schedules WHERE task_type <> 'health_check')
UPDATE schedules s SET next_run_at = now()
  + CASE WHEN o.task_type IN ('performance_review', 'portfolio_evaluation') THEN interval '7 days' ELSE interval '0' END
  + (o.n * interval '90 minutes')
  FROM ordered o WHERE s.id = o.id;
