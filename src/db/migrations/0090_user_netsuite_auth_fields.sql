-- users.netsuite_internal_id / must_change_password / password_reset_*
--
-- Employees synced from NetSuite now get a Portal login (see the employee push
-- handlers in src/routes/netsuite/employees.ts and src/routes/netsuite/list/employees.ts).
-- netsuite_internal_id is how the logged-in user is matched against an Estimate's
-- creator/sales-rep/ops-partner/product-developer fields for access control, and is
-- also how the sync upserts by identity instead of duplicating rows on re-sync.
--
-- must_change_password defaults to true: a NetSuite-synced account starts with the
-- default password (password@123) and must be changed on first login. Existing
-- manually-created rows also get true on this migration — there are no real users in
-- production yet, so forcing a one-time password change is the safe default.
--
-- password_reset_token_hash stores a SHA-256 hash of the random reset token, never the
-- raw value, so a DB read alone can't be used to complete a reset.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS netsuite_internal_id varchar(50),
  ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS password_reset_token_hash varchar(255),
  ADD COLUMN IF NOT EXISTS password_reset_expires_at timestamptz;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS users_ns_id_idx ON users (netsuite_internal_id);
