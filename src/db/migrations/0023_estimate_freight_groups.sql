-- Migration: estimate_freight_groups
-- Per-estimate freight group selections (LCL / FCL / AIR / Custom Provider)

CREATE TABLE IF NOT EXISTS estimate_freight_groups (
  id                   SERIAL PRIMARY KEY,
  estimate_id          INTEGER NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
  group_name           VARCHAR(255) NOT NULL DEFAULT 'Group 1',
  sort_order           INTEGER NOT NULL DEFAULT 1,

  -- Chosen freight type: 'LCL' | 'FCL' | 'AIR' | 'CUSTOM'
  chosen_type          VARCHAR(20),

  -- Rate FK references (one per freight type option)
  lcl_rate_id          INTEGER REFERENCES lcl_rates(id),
  fcl_rate_id          INTEGER REFERENCES fcl_rates(id),
  air_rate_id          INTEGER REFERENCES air_rates(id),

  -- Custom Provider fields
  custom_provider      VARCHAR(255),
  custom_freight_cost  NUMERIC(15, 4),
  custom_notes         TEXT,

  -- Computed totals (rolled up from cost-sheet line items in this group)
  total_cbm            NUMERIC(10, 3),
  chargeable_weight_kg NUMERIC(10, 3),
  freight_cost         NUMERIC(15, 4),
  freight_cost_per_unit NUMERIC(15, 4),

  created_at           TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  updated_at           TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS efg_estimate_idx ON estimate_freight_groups(estimate_id);
CREATE INDEX IF NOT EXISTS efg_sort_idx     ON estimate_freight_groups(estimate_id, sort_order);
