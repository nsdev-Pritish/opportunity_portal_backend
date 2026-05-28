-- Add selected column to estimate_line_items

ALTER TABLE estimate_line_items
  ADD COLUMN IF NOT EXISTS selected BOOLEAN NOT NULL DEFAULT TRUE;
