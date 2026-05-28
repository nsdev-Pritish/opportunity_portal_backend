-- Add extended line-level fields to estimate_line_items

ALTER TABLE estimate_line_items
  ADD COLUMN IF NOT EXISTS selected               BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS line_components        TEXT,
  ADD COLUMN IF NOT EXISTS previous_line_id       INTEGER,
  ADD COLUMN IF NOT EXISTS additional_fee_info    TEXT,
  ADD COLUMN IF NOT EXISTS country_origin         VARCHAR(100),
  ADD COLUMN IF NOT EXISTS item_class             VARCHAR(255),
  ADD COLUMN IF NOT EXISTS class_item             VARCHAR(255),
  ADD COLUMN IF NOT EXISTS vendor_sku             VARCHAR(255),
  ADD COLUMN IF NOT EXISTS shipping_instruction   TEXT,
  ADD COLUMN IF NOT EXISTS padding_amount         NUMERIC(15, 4),
  ADD COLUMN IF NOT EXISTS duty_markup_amount     NUMERIC(15, 4),
  ADD COLUMN IF NOT EXISTS converted              BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS freight_selected_group VARCHAR(255),
  ADD COLUMN IF NOT EXISTS freight_pol            VARCHAR(255),
  ADD COLUMN IF NOT EXISTS freight_pod            VARCHAR(255),
  ADD COLUMN IF NOT EXISTS total_freight_cost     NUMERIC(15, 4),
  ADD COLUMN IF NOT EXISTS freight_cost_per_unit  NUMERIC(15, 4),
  ADD COLUMN IF NOT EXISTS freight_provider       VARCHAR(255),
  ADD COLUMN IF NOT EXISTS freight_notes          TEXT,
  ADD COLUMN IF NOT EXISTS exclude_from_print     BOOLEAN NOT NULL DEFAULT FALSE;
