-- Divisional Budget on estimates becomes a dropdown selection.
-- 0083 added the free-text column `divisional_budget`; this adds the FK to the
-- divisional_budgets master list created in 0085. Both are kept:
--   divisional_budget_id → divisionalBudgetNSId (NetSuite internal id)
--   divisional_budget    → divisionalBudgetNS   (label / custbody_divisional_budget)

ALTER TABLE estimates
  ADD COLUMN IF NOT EXISTS divisional_budget_id integer REFERENCES divisional_budgets(id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS estimates_divisional_budget_idx ON estimates (divisional_budget_id);
--> statement-breakpoint

-- Backfill: link existing free-text values to the matching master row (case-insensitive).
-- Rows whose text has no match in divisional_budgets are left as text-only.
UPDATE estimates e
   SET divisional_budget_id = d.id
  FROM divisional_budgets d
 WHERE e.divisional_budget_id IS NULL
   AND e.divisional_budget IS NOT NULL
   AND lower(trim(e.divisional_budget)) = lower(trim(d.name));
