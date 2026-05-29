-- Add stage and probability columns to estimate_statuses

ALTER TABLE "estimate_statuses"
  ADD COLUMN IF NOT EXISTS "stage"       varchar(255),
  ADD COLUMN IF NOT EXISTS "probability" numeric(5, 2);
