ALTER TABLE "departments"
  ADD COLUMN IF NOT EXISTS "dept_show" boolean NOT NULL DEFAULT true;
