-- Migration: Reverse project type and project name relationship
-- Project types now depend on project names (not vice versa)

-- Step 1: Drop the foreign key constraint on project_names.project_type_id
ALTER TABLE "project_names" DROP CONSTRAINT IF EXISTS "project_names_project_type_id_project_types_id_fk";

-- Step 2: Drop the project_type_id column from project_names
ALTER TABLE "project_names" DROP COLUMN IF EXISTS "project_type_id";

-- Step 3: Add project_name_id column to project_types
ALTER TABLE "project_types" ADD COLUMN IF NOT EXISTS "project_name_id" integer;

-- Step 4: Add foreign key constraint to project_types referencing project_names
ALTER TABLE "project_types" ADD CONSTRAINT "project_types_project_name_id_project_names_id_fk" 
  FOREIGN KEY ("project_name_id") REFERENCES "project_names"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Step 5: Create index on project_types.project_name_id for better query performance
CREATE INDEX IF NOT EXISTS "project_types_project_name_idx" ON "project_types" ("project_name_id");
