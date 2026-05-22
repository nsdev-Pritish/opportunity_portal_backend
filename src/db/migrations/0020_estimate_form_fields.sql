-- Add project_name_id FK to estimates (project name selected from dropdown)
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "project_name_id" integer REFERENCES "project_names"("id");
--> statement-breakpoint

-- Make project_name nullable (now stored via project_name_id FK)
ALTER TABLE "estimates" ALTER COLUMN "project_name" DROP NOT NULL;
--> statement-breakpoint

-- Fix acct_manager_id FK: point to account_managers (not employees)
ALTER TABLE "estimates" DROP CONSTRAINT IF EXISTS "estimates_acct_manager_id_employees_id_fk";
--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_acct_manager_id_account_managers_id_fk"
  FOREIGN KEY ("acct_manager_id") REFERENCES "account_managers"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

-- Fix product_developer_id FK: point to product_developers (not employees)
ALTER TABLE "estimates" DROP CONSTRAINT IF EXISTS "estimates_product_developer_id_employees_id_fk";
--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_product_developer_id_product_developers_id_fk"
  FOREIGN KEY ("product_developer_id") REFERENCES "product_developers"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

-- Re-add vendor_incoterms_id to estimate_line_items (was dropped in 0011, now references vendor_incoterms table)
ALTER TABLE "estimate_line_items" ADD COLUMN IF NOT EXISTS "vendor_incoterms_id" integer REFERENCES "vendor_incoterms"("id");
--> statement-breakpoint

-- Add Ship To / Bill To text fields (formatted address text, editable textarea in UI)
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "ship_to" text;
--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "bill_to" text;
