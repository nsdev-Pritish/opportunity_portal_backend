-- Migration: 0033_component_kit_items
-- Creates the component_kit_items master table and adds FK on estimate_line_items

CREATE TABLE IF NOT EXISTS component_kit_items (
  id                  SERIAL PRIMARY KEY,
  name                VARCHAR(255) NOT NULL,
  netsuite_internal_id VARCHAR(50),
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  source              VARCHAR(20) NOT NULL DEFAULT 'portal',
  sync_status         VARCHAR(20) NOT NULL DEFAULT 'pending',
  sync_error          TEXT,
  synced_at           TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS cki_ns_id_idx ON component_kit_items (netsuite_internal_id)
  WHERE netsuite_internal_id IS NOT NULL;

ALTER TABLE estimate_line_items
  ADD COLUMN IF NOT EXISTS component_kit_item_id INTEGER
    REFERENCES component_kit_items(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS eli_cki_idx ON estimate_line_items (component_kit_item_id);
