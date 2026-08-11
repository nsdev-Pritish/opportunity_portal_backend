-- fact_revenue_snapshot: add subsidiary — Pipeline/SO/Invoice all carry a
-- subsidiary_id FK to the subsidiaries master table (Budget doesn't), needed
-- so revenue_comparison can carry the deal's subsidiary through without a
-- join back to the 3 source tables. Resolved to display text at snapshot
-- time, same pattern as consolidated_customer/department/sales_rep/etc.
-- Idempotent: the column already exists on databases where this shipped
-- under an earlier filename, so IF NOT EXISTS makes this a no-op there.

ALTER TABLE "fact_revenue_snapshot" ADD COLUMN IF NOT EXISTS "subsidiary" varchar(100);
