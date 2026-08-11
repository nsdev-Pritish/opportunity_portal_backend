-- revenue_comparison: wide/cross-tab layout — Pipeline/Open SO/Invoice
-- amounts, revenue dates, and USD deltas broken out as separate columns,
-- plus reconciled totals (col K + col H / col M + col I / col O - col N) and
-- a USD total delta. Per the "Comparison Table" worked example in the
-- Cons Rev & comparison tab and the consolidated business-logic writeup.
--
-- Safe to drop and recreate: this table has never carried real comparison
-- rows in any environment this migration folder has run against (the
-- comparison job only ever writes here after this shape is in place), and
-- doing so also cleanly supersedes 0078's unique index — 0078 targets
-- whatever column layout revenue_comparison already had when it ran, and a
-- DROP+CREATE here removes that index along with the table it was on rather
-- than trying to reconcile two different index definitions in place.

DROP TABLE IF EXISTS "revenue_comparison";
--> statement-breakpoint
CREATE TABLE "revenue_comparison" (
  "id" serial PRIMARY KEY NOT NULL,

  "anchor_id" varchar(50) NOT NULL,
  "report_type" varchar(10) NOT NULL,

  "prior_snapshot_period" date NOT NULL,
  "current_snapshot_period" date NOT NULL,

  "prior_pipeline_amt" numeric(18, 2),
  "current_pipeline_amt" numeric(18, 2),
  "pipeline_amount_change" numeric(18, 2),
  "prior_pipeline_rev_date" date,
  "current_pipeline_rev_date" date,
  "pipeline_revenue_date_change" varchar(50),

  "prior_open_so_amt" numeric(18, 2),
  "current_open_so_amt" numeric(18, 2),
  "open_so_amount_change" numeric(18, 2),
  "usd_so_amount_change" numeric(18, 2),
  "prior_so_rev_date" date,
  "current_so_rev_date" date,
  "so_revenue_date_change" varchar(50),

  "prior_invoice_amt" numeric(18, 2),
  "current_invoice_amt" numeric(18, 2),
  "invoice_amount_change" numeric(18, 2),
  "usd_invoice_amount_change" numeric(18, 2),
  "prior_invoice_date" date,
  "current_invoice_date" date,
  "invoice_revenue_period_summary" varchar(50),

  "total_prior_amount" numeric(18, 2),
  "total_current_amount" numeric(18, 2),
  "total_amount_change" numeric(18, 2),
  "usd_total_amount_change" numeric(18, 2),

  "check_flag" boolean,

  "lifecycle_event" varchar(100),
  "revenue_date_change_summary" varchar(100),

  "customer_name" varchar(200),
  "parent" varchar(200),
  "project_name" varchar(250),
  "sales_rep" varchar(100),
  "department" varchar(100),
  "subsidiary" varchar(100),
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
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rc_anchor_report_period_uidx" ON "revenue_comparison" ("anchor_id", "report_type", "prior_snapshot_period", "current_snapshot_period");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rc_report_type_current_idx" ON "revenue_comparison" ("report_type", "current_snapshot_period");
