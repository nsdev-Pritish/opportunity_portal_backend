-- Add Sales Rep to customers so the GET customer API can return it and the UI
-- can pre-populate the Account Manager.
--   sales_rep        → the rep's name (display / fallback matching)
--   sales_rep_ns_id  → the NetSuite internal id exactly as received from NetSuite
--   sales_rep_id     → the RESOLVED local account_managers.id (what the UI binds to)

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS sales_rep        VARCHAR(255),
  ADD COLUMN IF NOT EXISTS sales_rep_ns_id  VARCHAR(50),
  ADD COLUMN IF NOT EXISTS sales_rep_id     INTEGER;
--> statement-breakpoint

ALTER TABLE customers
  ADD CONSTRAINT customers_sales_rep_id_fk
  FOREIGN KEY (sales_rep_id) REFERENCES account_managers(id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS customers_sales_rep_idx ON customers (sales_rep_id);
