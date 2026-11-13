-- Telegram push updates (2026-11-13).
-- Which approval requests have already been pushed to the owner.
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;
-- Requests that already existed before this change are not pushed retroactively
-- (the owner can list them with /approvals).
UPDATE approvals SET notified_at = now() WHERE notified_at IS NULL;
