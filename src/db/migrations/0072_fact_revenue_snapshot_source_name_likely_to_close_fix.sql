-- Fix: 0067_fact_revenue_snapshot.sql was applied to this database before
-- source_name and likely_to_close were added to that file. Since that
-- migration is already recorded as applied (by filename) and its CREATE
-- TABLE IF NOT EXISTS is a no-op on a table that already exists, re-running
-- it does nothing. This is a new filename, so it runs regardless, and every
-- statement is idempotent (safe even if a column already happens to exist).

ALTER TABLE "fact_revenue_snapshot" ADD COLUMN IF NOT EXISTS "source_name" varchar(100);
--> statement-breakpoint
ALTER TABLE "fact_revenue_snapshot" ADD COLUMN IF NOT EXISTS "likely_to_close" varchar(100);
