-- "List" master tables (NetSuite custom lists) + extended employee fields.

-- ── Quarter List ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "quarters" (
  "id" serial PRIMARY KEY NOT NULL,
  "name" varchar(255) NOT NULL,
  "netsuite_internal_id" varchar(50),
  "is_active" boolean DEFAULT true NOT NULL,
  "source" "source" DEFAULT 'portal' NOT NULL,
  "sync_status" "sync_status" DEFAULT 'pending' NOT NULL,
  "sync_error" text,
  "synced_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "quarters_ns_id_idx" ON "quarters" ("netsuite_internal_id");
--> statement-breakpoint

-- ── Forecast Status List ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "forecast_statuses" (
  "id" serial PRIMARY KEY NOT NULL,
  "name" varchar(255) NOT NULL,
  "netsuite_internal_id" varchar(50),
  "is_active" boolean DEFAULT true NOT NULL,
  "source" "source" DEFAULT 'portal' NOT NULL,
  "sync_status" "sync_status" DEFAULT 'pending' NOT NULL,
  "sync_error" text,
  "synced_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "forecast_statuses_ns_id_idx" ON "forecast_statuses" ("netsuite_internal_id");
--> statement-breakpoint

-- ── Employee — extend existing table ───────────────────────────────
ALTER TABLE "employees"
  ADD COLUMN IF NOT EXISTS "employee_id"        varchar(100),
  ADD COLUMN IF NOT EXISTS "name"               varchar(255),
  ADD COLUMN IF NOT EXISTS "job_title"          varchar(255),
  ADD COLUMN IF NOT EXISTS "developer"          boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS "sales_rep"          boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS "product_developer"  boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS "currency_id"        integer,
  ADD COLUMN IF NOT EXISTS "subsidiary_id"      integer,
  ADD COLUMN IF NOT EXISTS "department_id"      integer;
--> statement-breakpoint
-- legacy first/last name are no longer required (the new flow uses "name")
ALTER TABLE "employees" ALTER COLUMN "first_name" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "employees" ALTER COLUMN "last_name" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_currency_id_fk" FOREIGN KEY ("currency_id") REFERENCES "currencies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_subsidiary_id_fk" FOREIGN KEY ("subsidiary_id") REFERENCES "subsidiaries"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_department_id_fk" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "employees_subsidiary_idx" ON "employees" ("subsidiary_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "employees_department_idx" ON "employees" ("department_id");
