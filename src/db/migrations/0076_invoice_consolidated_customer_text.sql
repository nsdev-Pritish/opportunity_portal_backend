-- Convert invoice_search.consolidated_customer_id from an integer FK to
-- free-text varchar, and rename it to consolidated_customer (no longer an
-- id). Mirrors 0073_sos_consolidated_status_text.sql (the same fix already
-- applied to sales_order_search).
--
-- NetSuite's Invoice saved search sends the DISPLAY TEXT for this field
-- ("L'OREAL FR : Diesel"), never an internal id, so the FK lookup matched
-- nothing and every row stored null.
--
-- Backfills the new column from the customers table first, so any row that
-- DID resolve keeps its display name instead of turning into the
-- stringified id.
ALTER TABLE "invoice_search" ADD COLUMN IF NOT EXISTS "consolidated_customer" varchar(500);
--> statement-breakpoint
UPDATE "invoice_search" i
   SET "consolidated_customer" = c."name"
  FROM "customers" c
 WHERE c."id" = i."consolidated_customer_id"
   AND i."consolidated_customer" IS NULL;
--> statement-breakpoint
ALTER TABLE "invoice_search" DROP COLUMN IF EXISTS "consolidated_customer_id";
