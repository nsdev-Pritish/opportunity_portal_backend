-- Revenue Analytics Snapshot Engine (3/3): fact_revenue_change_log
-- Reverted to the 32-column 4_Change Log Output-based design, per the
-- consolidated business-logic writeup — replaces the brief 14-column
-- "13_Expected Outputs" sample-row version (never applied to any database).
-- No foreign keys, same rationale as fact_revenue_snapshot and
-- revenue_comparison: joined by anchor_id + snapshot dates, not by a
-- schema-level relation.
--
-- change_type includes DELETED: fires only on the one comparison run where
-- the prior snapshot still had the anchor_id and the current snapshot
-- doesn't; a later run where the anchor is absent from both produces no row
-- at all, so DELETED never repeats.

CREATE TABLE IF NOT EXISTS "fact_revenue_change_log" (
  "id" serial PRIMARY KEY NOT NULL,

  "change_event_id" uuid NOT NULL,
  "change_group_id" uuid NOT NULL,
  "change_type" varchar(50) NOT NULL,
  "change_driver" varchar(30) NOT NULL,

  "source_type" varchar(20),
  "source_record_id" varchar(50),
  "document_number" varchar(100),
  "anchor_id" varchar(50) NOT NULL,

  "from_snapshot_date" date NOT NULL,
  "to_snapshot_date" date NOT NULL,

  "currency" varchar(10),

  "original_foreign_amount" numeric(18, 2),
  "prior_foreign_amount" numeric(18, 2),
  "current_foreign_amount" numeric(18, 2),
  "foreign_delta_vs_prior" numeric(18, 2),
  "foreign_delta_vs_original" numeric(18, 2),

  "original_reported_usd_amount" numeric(18, 2),
  "prior_reported_usd_amount" numeric(18, 2),
  "current_reported_usd_amount" numeric(18, 2),

  "original_exchange_rate" numeric(18, 8),
  "prior_exchange_rate" numeric(18, 8),
  "current_exchange_rate" numeric(18, 8),
  "reported_usd_delta_vs_prior" numeric(18, 2),

  "fx_only_change_flag" boolean DEFAULT false NOT NULL,

  "original_revenue_period" date,
  "prior_revenue_period" date,
  "current_revenue_period" date,
  "months_shifted_vs_prior" integer,
  "months_shifted_vs_original" integer,

  "change_description" text,
  "control_severity" varchar(20),

  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "crl_anchor_idx" ON "fact_revenue_change_log" ("anchor_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "crl_group_idx" ON "fact_revenue_change_log" ("change_group_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "crl_event_idx" ON "fact_revenue_change_log" ("change_event_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "crl_change_type_idx" ON "fact_revenue_change_log" ("change_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "crl_change_driver_idx" ON "fact_revenue_change_log" ("change_driver");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "crl_snapshot_range_idx" ON "fact_revenue_change_log" ("from_snapshot_date", "to_snapshot_date");
