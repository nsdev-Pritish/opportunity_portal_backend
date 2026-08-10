-- Adds a foreign_amount column to 3 of the 4 NetSuite saved-search source
-- tables (estimate_quote_search, sales_order_search, invoice_search) — NOT
-- budget_search, which has no native-currency concept per the workbook.
-- None of the 3 have a native-currency amount field today; the snapshot
-- builder falls back to deriving it (projectedTotal ÷ exchangeRate) when
-- this column is NULL, until NetSuite starts sending real values into it.
-- Idempotent — safe to run whether or not any of these already exist.

ALTER TABLE "estimate_quote_search" ADD COLUMN IF NOT EXISTS "foreign_amount" numeric;
--> statement-breakpoint
ALTER TABLE "sales_order_search" ADD COLUMN IF NOT EXISTS "foreign_amount" numeric;
--> statement-breakpoint
ALTER TABLE "invoice_search" ADD COLUMN IF NOT EXISTS "foreign_amount" numeric;
