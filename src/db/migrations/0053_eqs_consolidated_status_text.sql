-- Convert estimate_quote_search.consolidated_customer_id and status_id from
-- integer FKs to free-text varchar (stored as-is, like document_number), and
-- rename them to consolidated_customer / status (no longer ids).
ALTER TABLE "estimate_quote_search" DROP CONSTRAINT IF EXISTS "estimate_quote_search_consolidated_customer_id_customers_id_fk";
--> statement-breakpoint
ALTER TABLE "estimate_quote_search" DROP CONSTRAINT IF EXISTS "estimate_quote_search_status_id_estimate_statuses_id_fk";
--> statement-breakpoint
ALTER TABLE "estimate_quote_search" ALTER COLUMN "consolidated_customer_id" TYPE varchar(255) USING "consolidated_customer_id"::varchar;
--> statement-breakpoint
ALTER TABLE "estimate_quote_search" ALTER COLUMN "status_id" TYPE varchar(255) USING "status_id"::varchar;
--> statement-breakpoint
ALTER TABLE "estimate_quote_search" RENAME COLUMN "consolidated_customer_id" TO "consolidated_customer";
--> statement-breakpoint
ALTER TABLE "estimate_quote_search" RENAME COLUMN "status_id" TO "status";
