-- Safety net for foreign_amount on estimate_quote_search / sales_order_search
-- / invoice_search. 0074 adds this column, but this session briefly emptied
-- 0074 out to a no-op and then restored it — since the migration runner
-- tracks applied files by FILENAME only (not content), if 0074 ever ran
-- during the no-op window it is permanently marked "done" and will never
-- re-run, even now that its content is back to the real ADD COLUMN
-- statements. This migration is a new filename, so it always runs once,
-- guaranteeing the column exists no matter what 0074 actually did.
ALTER TABLE "estimate_quote_search" ADD COLUMN IF NOT EXISTS "foreign_amount" numeric;
--> statement-breakpoint
ALTER TABLE "sales_order_search" ADD COLUMN IF NOT EXISTS "foreign_amount" numeric;
--> statement-breakpoint
ALTER TABLE "invoice_search" ADD COLUMN IF NOT EXISTS "foreign_amount" numeric;
