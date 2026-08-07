-- Revenue Analytics Snapshot Engine (2/3): revenue_comparison
-- Wide/cross-tab layout — amounts and dates broken out per source type
-- (Pipeline/Open SO/Invoice) as separate columns, per the "Comparison Table"
-- worked example in the Cons Rev & comparison tab and the consolidated
-- business-logic writeup. Replaces the earlier narrow/generic design (never
-- applied to any database). No foreign keys — joined by anchor_id at
-- query/build time, same rationale as fact_revenue_snapshot.

CREATE TABLE IF NOT EXISTS "revenue_comparison" (
  "id" serial PRIMARY KEY NOT NULL,

  "anchor_id" varchar(50) NOT NULL,
  "report_type" varchar(10) NOT NULL,

  "prior_snapshot_period" date NOT NULL,
  "current_snapshot_period" date NOT NULL,

  "prior_source_type" varchar(20),
  "current_source_type" varchar(20),
  "source_type_change" varchar(30),

  "prior_document" varchar(100),
  "current_document" varchar(100),

  "prior_pipeline_amt" numeric(18, 2),
  "current_pipeline_amt" numeric(18, 2),
  "pipeline_amount_change" numeric(18, 2),

  "prior_open_so_amt" numeric(18, 2),
  "current_open_so_amt" numeric(18, 2),
  "open_so_amount_change" numeric(18, 2),

  "prior_invoice_amt" numeric(18, 2),
  "current_invoice_amt" numeric(18, 2),
  "invoice_amount_change" numeric(18, 2),

  "prior_revenue_period" date,
  "current_revenue_period" date,
  "revenue_period_shift" varchar(50),

  "total_prior_amount" numeric(18, 2),
  "total_current_amount" numeric(18, 2),
  "total_amount_change" numeric(18, 2),

  "check_flag" boolean,

  "lifecycle_event" varchar(100),

  "customer" varchar(200),
  "project_name" varchar(250),
  "sales_rep" varchar(100),
  "department" varchar(100),
  "currency" varchar(10),

  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rc_anchor_idx" ON "revenue_comparison" ("anchor_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rc_report_type_idx" ON "revenue_comparison" ("report_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rc_current_snapshot_idx" ON "revenue_comparison" ("current_snapshot_period");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rc_anchor_report_idx" ON "revenue_comparison" ("anchor_id", "report_type", "current_snapshot_period");
