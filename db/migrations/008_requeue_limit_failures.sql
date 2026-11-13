-- Owner removed per-agent and daily limits (2026-11-13). Re-run the tasks that
-- failed on those limits in the last day instead of leaving them failed.
UPDATE tasks
   SET status = 'queued', attempts = 0, run_at = now(), last_error = NULL, finished_at = NULL, locked_by = NULL, locked_until = NULL
 WHERE status IN ('failed', 'dead')
   AND created_at > now() - interval '1 day'
   AND type <> 'health_check'
   AND (last_error LIKE 'daily_limit%' OR last_error LIKE 'weekly_limit%' OR last_error LIKE 'monthly_limit%'
        OR last_error LIKE 'ai_monthly_limit%' OR last_error LIKE 'starting_budget%' OR last_error LIKE 'per_transaction_limit%'
        OR last_error LIKE 'global_daily_limit%');
