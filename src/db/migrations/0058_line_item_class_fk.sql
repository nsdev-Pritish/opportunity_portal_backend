-- Link estimate_line_items to the new unified `classes` master.
-- Added alongside the existing product_class_id / product_class_eu_id FKs
-- (kept during the transition away from the two split tables).

ALTER TABLE estimate_line_items ADD COLUMN IF NOT EXISTS class_id INTEGER;
--> statement-breakpoint

ALTER TABLE estimate_line_items
  ADD CONSTRAINT estimate_line_items_class_id_fk
  FOREIGN KEY (class_id) REFERENCES classes(id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS estimate_line_items_class_idx ON estimate_line_items (class_id);
