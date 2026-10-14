-- Body-level Freight Mode Lock flag on estimates.
--
-- PORTAL-ONLY: it is never sent to NetSuite and never written by the NetSuite inbound sync.
-- Both sync directions build their field lists explicitly (no row/body spreads), so a column
-- that neither side names is left untouched — a NetSuite sync keeps whatever the portal set.
--
-- NOT NULL DEFAULT false: existing estimates read as unlocked, and a create that omits the
-- field gets false. On Postgres 11+ adding a column with a constant default is a metadata-only
-- change — no table rewrite.

ALTER TABLE estimates
  ADD COLUMN IF NOT EXISTS freight_mode_lock boolean NOT NULL DEFAULT false;
