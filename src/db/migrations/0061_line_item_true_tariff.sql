ALTER TABLE estimate_line_items
  ADD COLUMN IF NOT EXISTS true_tariff VARCHAR(255);
