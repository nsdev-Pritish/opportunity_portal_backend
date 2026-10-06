-- Widen addresses.label from varchar(100) to varchar(2000).
--
-- NetSuite auto-fills the address-book label with the entire rendered address when the
-- user never types one of their own ("1234 Long Street Name, Suite 500, Some City, CA
-- 90210, United States"). Those overflow 100 characters, and because the route schema
-- mirrored the column at max(100), the sync rejected the whole request for that address
-- instead of storing it.
--
-- SAFETY: widening a varchar is a metadata-only change in Postgres — no table rewrite,
-- no lock beyond a brief ACCESS EXCLUSIVE, and no existing value is altered or truncated.

ALTER TABLE addresses
  ALTER COLUMN label TYPE VARCHAR(2000);
