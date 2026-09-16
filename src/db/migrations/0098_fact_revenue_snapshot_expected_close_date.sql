-- fact_revenue_snapshot: add expected_close_date, carried through from the
-- Pipeline source (estimate_quote_search.expected_close_date) the same way
-- other Pipeline-only fields (e.g. subsidiary) were added in earlier
-- migrations, so downstream consumers of the snapshot don't need to join
-- back to the source tables.
-- Idempotent via IF NOT EXISTS, consistent with prior migrations in this file set.

ALTER TABLE "fact_revenue_snapshot" ADD COLUMN IF NOT EXISTS "expected_close_date" date;
