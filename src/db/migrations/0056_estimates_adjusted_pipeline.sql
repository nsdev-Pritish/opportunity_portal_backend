-- Add Adjusted Pipeline (currency) to estimates.
-- Sourced from NetSuite field `adjustedPipelineAmountNS`; stored as numeric(15,2)
-- to match the other currency amounts (e.g. projected_total_amt).

ALTER TABLE estimates
  ADD COLUMN IF NOT EXISTS adjusted_pipeline numeric(15, 2);
