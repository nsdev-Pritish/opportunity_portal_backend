-- Soft-delete flag for freight groups. On an update where fewer groups are sent than
-- already exist, the surplus groups are deactivated (is_active=false) instead of being
-- hard-deleted, so their row id survives. All read paths filter on is_active=true.
-- Existing rows default to active.

ALTER TABLE estimate_freight_groups
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
