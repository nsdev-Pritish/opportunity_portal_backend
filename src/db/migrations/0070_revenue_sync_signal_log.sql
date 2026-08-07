-- Revenue Analytics Snapshot Engine — signal-driven control table.
-- Replaces the earlier quiet-period-based revenue_snapshot_run_log design
-- (never applied to any database) with an explicit start/end/fail signal
-- model: NetSuite calls three endpoints once per source per day, each
-- upserting one row here. A 5th synthetic row per day (source_type = 'ALL')
-- tracks the overall insert job once all 4 real sources report 'completed'.
-- If any real source reports 'failed', that day is never used — the insert
-- only fires once all 4 show 'completed'.

CREATE TABLE IF NOT EXISTS "revenue_sync_signal_log" (
  "id" serial PRIMARY KEY NOT NULL,
  "run_date" date NOT NULL,
  "source_type" varchar(20) NOT NULL,
  "status" varchar(20) DEFAULT 'pending' NOT NULL,
  "record_count" integer,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "error_message" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rssl_run_date_source_idx" ON "revenue_sync_signal_log" ("run_date", "source_type");
