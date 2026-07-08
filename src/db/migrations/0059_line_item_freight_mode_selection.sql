-- Store the freight mode selected for a single line item.
-- Distinct from estimate_freight_groups.freight_mode_selected (group-level, OCEAN_LCL/…);
-- this captures the line-level choice shown in the UI: FOB | Ocean | Air | Group.

ALTER TABLE estimate_line_items
  ADD COLUMN IF NOT EXISTS freight_mode_selection VARCHAR(20);
