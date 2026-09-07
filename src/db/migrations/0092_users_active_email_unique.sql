-- Persist the NetSuite "EST Portal User" checkbox (custentity_obc_portal_user) on the
-- employees row, so it's a concrete, queryable field rather than a payload-only flag.
-- The /list/employees sync endpoint sets it from the NetSuite feed; syncUserForEmployee
-- reads it back to gate whether a Portal login (USERS row) may be created.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS portal_user boolean DEFAULT false NOT NULL;
--> statement-breakpoint

-- Enforce a unique email per ACTIVE user, case-insensitively.
--
-- Migration 0091 dropped the email unique constraint entirely so every NetSuite
-- employee could get its own row, including duplicates. NetSuite now curates portal
-- access via the "EST Portal User" checkbox (see syncUserForEmployee), so going
-- forward there should be at most one active login per email. This index only
-- constrains active rows: deactivated duplicates from the one-time USERS cleanup keep
-- whatever email they already had, so this migration applies cleanly without needing
-- that cleanup to touch email values, and a future sync bug that tries to create a
-- second active account with an email already in use now fails loudly at sync time
-- instead of leaving one of the two accounts unable to log in.
CREATE UNIQUE INDEX IF NOT EXISTS users_active_email_idx
  ON users (lower(email))
  WHERE email is not null and is_active = true;
