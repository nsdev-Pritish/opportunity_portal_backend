-- Fix: 0070_revenue_sync_signal_log.sql was applied to this database before
-- record_count was added to that file. Since that migration is already
-- recorded as applied (by filename) and its CREATE TABLE IF NOT EXISTS is a
-- no-op on a table that already exists, re-running it does nothing. This is
-- a new filename, so it runs regardless, and every statement is idempotent
-- (safe even if the table/column/index already happen to be correct).

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
ALTER TABLE "revenue_sync_signal_log" ADD COLUMN IF NOT EXISTS "record_count" integer;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rssl_run_date_source_idx" ON "revenue_sync_signal_log" ("run_date", "source_type");
