-- Convert sales_order_search.consolidated_customer_id and status_id from integer
-- FKs to free-text varchar, and rename them to consolidated_customer / status
-- (no longer ids). Mirrors 0053_eqs_consolidated_status_text.sql.
--
-- NetSuite's Sales Order saved search sends the DISPLAY TEXT for both fields
-- ("L'OREAL FR : Diesel", "pendingFulfillment"), never an internal id, so the
-- FK lookup matched nothing and every row stored null.
--
-- Unlike 0053 (a straight ::varchar cast), this backfills the new columns from
-- the master tables first, so any row that DID resolve keeps its display name
-- instead of turning into the stringified id.
ALTER TABLE "sales_order_search" ADD COLUMN IF NOT EXISTS "consolidated_customer" varchar(500);
--> statement-breakpoint
ALTER TABLE "sales_order_search" ADD COLUMN IF NOT EXISTS "status" varchar(255);
--> statement-breakpoint
UPDATE "sales_order_search" s
   SET "consolidated_customer" = c."name"
  FROM "customers" c
 WHERE c."id" = s."consolidated_customer_id"
   AND s."consolidated_customer" IS NULL;
--> statement-breakpoint
UPDATE "sales_order_search" s
   SET "status" = es."name"
  FROM "estimate_statuses" es
 WHERE es."id" = s."status_id"
   AND s."status" IS NULL;
--> statement-breakpoint
ALTER TABLE "sales_order_search" DROP COLUMN IF EXISTS "consolidated_customer_id";
--> statement-breakpoint
ALTER TABLE "sales_order_search" DROP COLUMN IF EXISTS "status_id";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sos_status_idx" ON "sales_order_search" ("status");
