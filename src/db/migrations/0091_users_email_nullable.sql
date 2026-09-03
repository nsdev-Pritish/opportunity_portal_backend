-- users.email: drop NOT NULL and drop the unique constraint.
--
-- The NetSuite employee sync (src/services/userSync.service.ts) previously skipped any
-- employee with no email, and merged an employee onto an existing account when the email
-- already existed — both to stay inside these constraints. That left `users` short of
-- `employees` (311 vs 363). Every employee should now get its own Portal row, so a null
-- email is stored as null and duplicate emails are allowed.
--
-- Consequence: email is no longer a unique login identifier. A row with a null email can
-- never log in (`email = NULL` never matches), and if two rows share an email the login
-- lookup resolves to an arbitrary one of them. The unique index is replaced by a plain
-- index so the login/forgot-password lookups stay indexed.
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS users_email_idx;
--> statement-breakpoint
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_unique;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS users_email_idx ON users (email);
