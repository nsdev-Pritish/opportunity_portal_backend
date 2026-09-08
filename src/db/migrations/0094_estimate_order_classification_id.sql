-- Order Classification on estimates becomes a dropdown selection.
-- Adds the FK to the order_classifications master list created in 0093,
-- mirroring how divisional_budget_id was added in 0086.

ALTER TABLE estimates
  ADD COLUMN IF NOT EXISTS order_classification_id integer REFERENCES order_classifications(id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS estimates_order_classification_id_idx ON estimates (order_classification_id);
