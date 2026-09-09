-- Mirrors employees.portal_user (NetSuite "EST Portal User" checkbox) onto users,
-- so login can gate on the user's own row instead of joining back to employees.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS portal_user boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- Backfill from the currently-synced employees row so existing portal users aren't
-- locked out of login until the next NetSuite sync touches their record.
UPDATE users u
SET portal_user = e.portal_user
FROM employees e
WHERE e.netsuite_internal_id = u.netsuite_internal_id
  AND u.netsuite_internal_id IS NOT NULL;
