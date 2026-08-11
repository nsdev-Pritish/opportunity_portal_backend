-- revenue_change_log: anchor-grain, plain-language business-event log built
-- straight off revenue_comparison, one batch per (report_type,
-- current_snapshot_period) — see src/jobs/revenueChangeLog/revenueChangeLog.ts.
--
-- Only meaningful events land here: a "nothing changed" comparison row
-- produces no row at all, so any row in this table is by definition something
-- a human or a BI tool should look at. change_description carries the fully
-- worded explanation so dashboards never re-derive the rule logic.
--
-- RELATIONSHIP TO fact_revenue_change_log (migration 0069): that table is a
-- separate, finer-grained log — one row per SOURCE RECORD (internal_id) for
-- the DOD pair only, with snake_case change_type codes. This table is
-- anchor-grain, covers all four report types (DOD/WOW/MOM/QOQ), and stores
-- prose change_type values. Both are populated today by different jobs
-- writing to different tables; they do not conflict, but consolidating them
-- is an open decision — see the assumptions list in the change-log job.
--
-- change_event_id is BIGSERIAL here (not the app-generated uuid that
-- fact_revenue_change_log uses) per the agreed column spec; change_group_id
-- stays a UUID and is generated once per batch by the job.

CREATE TABLE IF NOT EXISTS "revenue_change_log" (
  "change_event_id" bigserial PRIMARY KEY NOT NULL,
  "change_group_id" uuid NOT NULL,
  "change_type" varchar(50) NOT NULL,
  "change_driver" varchar(30) NOT NULL,             -- BUSINESS / FX_ONLY / BUSINESS_AND_FX / PERIOD / LIFECYCLE / DATA_QUALITY

  "source_type" varchar(20),
  "source_record_id" bigint,
  "document_number" varchar(50),
  "anchor_id" varchar(50) NOT NULL,

  "from_snapshot_date" date NOT NULL,
  "to_snapshot_date" date NOT NULL,
  "report_type" varchar(10) NOT NULL,               -- carried over from revenue_comparison: DOD/WOW/MOM/QOQ

  "original_foreign_amount" numeric(18, 2),
  "prior_foreign_amount" numeric(18, 2),
  "current_foreign_amount" numeric(18, 2),
  "foreign_delta_vs_prior" numeric(18, 2),
  "foreign_delta_vs_original" numeric(18, 2),

  "original_reported_usd_amount" numeric(18, 2),
  "prior_reported_usd_amount" numeric(18, 2),
  "current_reported_usd_amount" numeric(18, 2),
  "reported_usd_delta_vs_prior" numeric(18, 2),

  "original_exchange_rate" numeric(18, 8),
  "prior_exchange_rate" numeric(18, 8),
  "current_exchange_rate" numeric(18, 8),
  "fx_only_change_flag" boolean DEFAULT false,

  "original_revenue_period" date,
  "prior_revenue_period" date,
  "current_revenue_period" date,
  "months_shifted_vs_prior" integer,
  "months_shifted_vs_original" integer,

  "change_description" text,
  "control_severity" varchar(10),                   -- INFO / REVIEW / WARNING / CRITICAL

  "created_at" timestamp DEFAULT now(),

  -- Re-run safety: the job inserts with ON CONFLICT DO NOTHING against this
  -- key, so re-running the same batch is a no-op rather than a duplicate.
  -- change_type is part of the key on purpose — rule 7 can legitimately emit
  -- a second row ('Revenue Shift') for the same anchor and date alongside an
  -- amount/FX row, and both must survive.
  CONSTRAINT "revenue_change_log_report_anchor_date_type_key"
    UNIQUE ("report_type", "anchor_id", "to_snapshot_date", "change_type")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_change_log_anchor" ON "revenue_change_log" ("anchor_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_change_log_severity" ON "revenue_change_log" ("control_severity", "to_snapshot_date");
