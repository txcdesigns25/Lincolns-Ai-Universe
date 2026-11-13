-- Approved Level 2 actions (e.g. publishing a landing page) were rejected with
-- "not_preauthorized" even though the owner approved that exact request.
-- The check is fixed; re-run those tasks while their approval is still unused.
UPDATE tasks t
   SET status = 'queued', attempts = 0, run_at = now(), last_error = NULL, finished_at = NULL, locked_by = NULL, locked_until = NULL
 WHERE t.type = 'execute_action'
   AND t.status IN ('failed', 'dead')
   AND t.last_error LIKE 'not_preauthorized%'
   AND EXISTS (SELECT 1 FROM approvals a WHERE a.id::text = t.payload->>'approval_id' AND a.status = 'approved');
