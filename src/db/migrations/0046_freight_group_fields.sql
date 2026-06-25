-- Expand estimate_freight_groups with the full client freight-group field set,
-- and add a back-reference (freight_group_id) on estimate_line_items.
-- All active freight logic now lives on estimate_freight_groups; the legacy freight_*
-- columns on estimate_line_items are retained for backward compatibility but unused.

ALTER TABLE estimate_freight_groups
  ADD COLUMN IF NOT EXISTS freight_mode_selected VARCHAR(20),
  ADD COLUMN IF NOT EXISTS item_ids           JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS num_items          INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_weight       NUMERIC(10, 3),
  ADD COLUMN IF NOT EXISTS ocean_lcl_total    NUMERIC(15, 4),
  ADD COLUMN IF NOT EXISTS ocean_lcl_per_unit NUMERIC(15, 4),
  ADD COLUMN IF NOT EXISTS ocean_lcl_pol      VARCHAR(255),
  ADD COLUMN IF NOT EXISTS ocean_lcl_pod      VARCHAR(255),
  ADD COLUMN IF NOT EXISTS ocean_fcl_total    NUMERIC(15, 4),
  ADD COLUMN IF NOT EXISTS ocean_fcl_per_unit NUMERIC(15, 4),
  ADD COLUMN IF NOT EXISTS ocean_fcl_pol      VARCHAR(255),
  ADD COLUMN IF NOT EXISTS ocean_fcl_pod      VARCHAR(255),
  ADD COLUMN IF NOT EXISTS air_total          NUMERIC(15, 4),
  ADD COLUMN IF NOT EXISTS air_per_unit       NUMERIC(15, 4),
  ADD COLUMN IF NOT EXISTS air_pol            VARCHAR(255),
  ADD COLUMN IF NOT EXISTS air_pod            VARCHAR(255),
  ADD COLUMN IF NOT EXISTS custom_total       NUMERIC(15, 4),
  ADD COLUMN IF NOT EXISTS custom_per_unit    NUMERIC(15, 4);
--> statement-breakpoint

ALTER TABLE estimate_line_items
  ADD COLUMN IF NOT EXISTS freight_group_id INTEGER;
--> statement-breakpoint

ALTER TABLE estimate_line_items
  ADD CONSTRAINT estimate_line_items_freight_group_id_fk
  FOREIGN KEY (freight_group_id) REFERENCES estimate_freight_groups(id) ON DELETE SET NULL;
