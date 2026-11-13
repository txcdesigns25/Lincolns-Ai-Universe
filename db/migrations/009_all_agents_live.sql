-- Owner request (2026-11-13): put every agent in live mode. Live mode only lets
-- APPROVED external actions use real integrations where credentials exist;
-- approvals and the emergency stop still apply. Reversible from Settings.
UPDATE agents SET live_mode = TRUE, updated_at = now() WHERE NOT live_mode;
INSERT INTO audit_log (actor, action, outcome, details)
VALUES ('owner', 'agents.live_mode.all_on', 'info', '{"via":"migration 009, owner request"}');
