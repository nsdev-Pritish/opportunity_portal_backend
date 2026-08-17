-- Add the "Divisional Budget" field to estimates.
-- Maps to the NetSuite custom body field on the Estimate / Sales Order:
--   divisional_budget → custbody_divisional_budget (Divisional Budget)
-- Free text; NULL when unset. The frontend only shows this field for L'Oréal
-- customers (conditional display), but the column itself is not customer-scoped.

ALTER TABLE estimates
  ADD COLUMN IF NOT EXISTS divisional_budget VARCHAR(255);
