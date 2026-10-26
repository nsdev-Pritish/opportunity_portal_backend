-- Freight Planning: let a kit's components be split across freight groups.
--
--   freight_split       — on a kit (parent) line: are its components split across groups?
--   freight_group_index — on a component: which freight group it belongs to, as its 0-based
--                         position in the estimate's freightGroups list. NULL = not assigned.
--
-- PORTAL-ONLY: both are set by the frontend and returned on load, but never sent to NetSuite
-- and never written by the NetSuite sync (both directions name their fields explicitly).
-- freight_group_index is deliberately its own column, not the existing freight_group_id, which
-- the NetSuite sync clears and rebuilds on every inbound sync and would wipe the split.
--
-- SAFETY: additive only. Existing lines read as not split and unassigned.

ALTER TABLE estimate_line_items
  ADD COLUMN IF NOT EXISTS freight_split boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE estimate_line_items
  ADD COLUMN IF NOT EXISTS freight_group_index integer;
