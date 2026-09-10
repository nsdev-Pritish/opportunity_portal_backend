ALTER TABLE estimate_line_items
  ADD COLUMN IF NOT EXISTS testing NUMERIC(15, 4);
