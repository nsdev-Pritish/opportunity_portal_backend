-- New saved-search columns on budget_search / sales_order_search / invoice_search.
--
-- All additive (ADD COLUMN IF NOT EXISTS) and nullable, so existing rows are
-- untouched and re-running the file is safe.
--
-- budget_search gets NetSuite's own record timestamps ("Last Modified" /
-- "Date Created"). These are NOT the same as the portal's created_at/updated_at
-- from syncCols — those track when the PORTAL row was written; these track the
-- NetSuite record itself.
--
-- sales_order_search.created_from and invoice_search.est_number are the
-- lifecycle link fields the snapshot engine's anchor_id was missing (see the
-- "gap — no Created From Estimate link field yet" notes in
-- src/jobs/revenueSnapshot/snapshotBuilder.ts). Both are plain indexed text
-- (an estimate document number such as "EST0008946"), matching how anchor_id is
-- carried everywhere else — never a numeric FK.

-- ── Budget ─────────────────────────────────────────────────────────
ALTER TABLE "budget_search"
  ADD COLUMN IF NOT EXISTS "last_modified" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "date_created"  timestamp with time zone;
--> statement-breakpoint

-- ── Sales Order ────────────────────────────────────────────────────
ALTER TABLE "sales_order_search"
  ADD COLUMN IF NOT EXISTS "created_from" varchar(255),
  ADD COLUMN IF NOT EXISTS "end_date"     date,
  ADD COLUMN IF NOT EXISTS "amount_net"   numeric,
  ADD COLUMN IF NOT EXISTS "open_amount"  numeric;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sos_created_from_idx" ON "sales_order_search" ("created_from");
--> statement-breakpoint

-- ── Invoice ────────────────────────────────────────────────────────
ALTER TABLE "invoice_search"
  ADD COLUMN IF NOT EXISTS "created_from"        varchar(255),
  ADD COLUMN IF NOT EXISTS "so_document_number"  varchar(100),
  ADD COLUMN IF NOT EXISTS "so_date"             date,
  ADD COLUMN IF NOT EXISTS "usd_invoice_amount"  numeric,
  ADD COLUMN IF NOT EXISTS "usd_net_revenue"     numeric,
  ADD COLUMN IF NOT EXISTS "est_number"          varchar(100);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invs_created_from_idx" ON "invoice_search" ("created_from");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invs_so_doc_num_idx" ON "invoice_search" ("so_document_number");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invs_est_number_idx" ON "invoice_search" ("est_number");
