-- Store a hex color (e.g. "#FFAA00") on each estimate line item so the UI can
-- save the colour chosen when an item is created/edited.

ALTER TABLE estimate_line_items
  ADD COLUMN IF NOT EXISTS color VARCHAR(20);
