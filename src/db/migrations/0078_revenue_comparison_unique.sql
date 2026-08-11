-- Revenue Comparison: re-run safety + report-type lookup index.
--
-- The table itself already exists (0068). This adds the one thing that was
-- missing for the comparison job: a UNIQUE key over
-- (report_type, anchor_id, prior_snapshot_period, current_snapshot_period),
-- which is what makes ON CONFLICT DO NOTHING work in
-- src/jobs/revenueComparison/comparisonBuilder.ts. Without it, running the
-- daily job twice for the same pair of snapshot dates would double every row.
--
-- A UNIQUE INDEX (not ALTER TABLE ... ADD CONSTRAINT) is used deliberately:
-- it supports IF NOT EXISTS, so this file is idempotent on a database where
-- db:push already created it, and it serves ON CONFLICT column inference
-- exactly the same way a table constraint would. Same style as
-- rssl_run_date_source_idx on revenue_sync_signal_log.
--
-- The DELETE below is a safety net for any database that already collected
-- duplicate comparison rows before this key existed (the job had no way to
-- prevent them). It keeps the lowest id of each duplicate group. On a table
-- with no duplicates it is a no-op.

DELETE FROM "revenue_comparison" a
USING "revenue_comparison" b
WHERE a.id > b.id
  AND a.report_type = b.report_type
  AND a.anchor_id = b.anchor_id
  AND a.prior_snapshot_period = b.prior_snapshot_period
  AND a.current_snapshot_period = b.current_snapshot_period;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rc_report_anchor_period_uniq"
  ON "revenue_comparison" ("report_type", "anchor_id", "prior_snapshot_period", "current_snapshot_period");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rc_report_type_current_idx"
  ON "revenue_comparison" ("report_type", "current_snapshot_period");
