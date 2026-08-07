-- Revenue Analytics Snapshot Engine (1/3): fact_revenue_snapshot
-- Full historical copy of every active Pipeline/SO/Invoice/Budget record,
-- appended (never updated) on every sync run. Deliberately has NO foreign
-- keys to estimate_quote_search / sales_order_search / invoice_search /
-- budget_search — it's an append-only fact table that must survive after a
-- source row changes or is deleted, so anchor_id / internal_id are plain
-- indexed strings, not FK columns.

CREATE TABLE IF NOT EXISTS "fact_revenue_snapshot" (
  "id" serial PRIMARY KEY NOT NULL,

  "snapshot_date" date NOT NULL,
  "snapshot_ts" timestamp with time zone NOT NULL,
  "source_type" varchar(20) NOT NULL,
  "source_name" varchar(100),
  "internal_id" varchar(50) NOT NULL,
  "anchor_id" varchar(50),
  "document_number" varchar(100),

  "consolidated_customer" varchar(200),
  "top_level_parent" varchar(200),
  "department" varchar(100),
  "sales_rep" varchar(100),
  "project_name" varchar(250),

  "status" varchar(100),
  "stage" varchar(100),
  "likely_to_close" varchar(100),

  "created_date" date,
  "revenue_date" date,
  "revenue_period" date,

  "foreign_amount" numeric(18, 2),
  "currency" varchar(10),
  "exchange_rate" numeric(18, 8),
  "usd_amount" numeric(18, 2),

  "change_driver" varchar(30),
  "is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "frs_snapshot_date_idx" ON "fact_revenue_snapshot" ("snapshot_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "frs_source_type_idx" ON "fact_revenue_snapshot" ("source_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "frs_internal_id_idx" ON "fact_revenue_snapshot" ("internal_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "frs_anchor_idx" ON "fact_revenue_snapshot" ("anchor_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "frs_anchor_snapshot_idx" ON "fact_revenue_snapshot" ("anchor_id", "snapshot_date");
