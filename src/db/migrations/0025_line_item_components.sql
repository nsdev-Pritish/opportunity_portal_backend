-- Migration: add parent_line_item_id and sort_order to estimate_line_items
-- Enables Quote Kit Items to have multiple Component Kit Items nested under them.
-- parent_line_item_id = NULL  → top-level item (Quote Kit Item or standalone)
-- parent_line_item_id = <id>  → component belonging to that parent

ALTER TABLE estimate_line_items
  ADD COLUMN IF NOT EXISTS parent_line_item_id INTEGER REFERENCES estimate_line_items(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

-- Also relax the line_number unique constraint: components share lineNumber = 0
-- so the existing unique index (estimate_id, line_number) would conflict.
-- Drop and recreate it as a partial index that only covers top-level items.
DROP INDEX IF EXISTS eli_line_number_idx;
CREATE UNIQUE INDEX IF NOT EXISTS eli_line_number_idx
  ON estimate_line_items(estimate_id, line_number)
  WHERE parent_line_item_id IS NULL;

CREATE INDEX IF NOT EXISTS eli_parent_idx ON estimate_line_items(parent_line_item_id);
