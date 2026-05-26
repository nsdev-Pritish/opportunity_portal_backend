-- Migration: add pol, pod, total_cartons to estimate_freight_groups

ALTER TABLE estimate_freight_groups
  ADD COLUMN IF NOT EXISTS pol           VARCHAR(255),
  ADD COLUMN IF NOT EXISTS pod           VARCHAR(255),
  ADD COLUMN IF NOT EXISTS total_cartons INTEGER NOT NULL DEFAULT 0;
