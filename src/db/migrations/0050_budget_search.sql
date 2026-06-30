CREATE TABLE IF NOT EXISTS "budget_search" (
  "id" serial PRIMARY KEY NOT NULL,
  "name" varchar(500),
  "so_close_period" date,
  "lead_time" varchar(100),
  "revenue_period" date,
  "moved_from_date" date,
  "revenue_moved_to_period" date,
  "fiscal_year" integer,
  "so_qtr_id" integer,
  "revenue_qtr_id" integer,
  "budget_amount" numeric,
  "dilutions_pct" numeric,
  "dilutions_amt" numeric,
  "net_revenue" numeric,
  "projected_gm" numeric,
  "projected_profit" numeric,
  "true_gm_goal" numeric,
  "forecast_status_id" integer,
  "forecast_scenario" varchar(255),
  "department_id" integer,
  "parent_id" integer,
  "consolidated_customer_id" integer,
  "consolidated_customer_text" varchar(500),
  "account_manager_id" integer,
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
ALTER TABLE "budget_search" ADD CONSTRAINT "budget_search_so_qtr_id_quarters_id_fk" FOREIGN KEY ("so_qtr_id") REFERENCES "quarters"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "budget_search" ADD CONSTRAINT "budget_search_revenue_qtr_id_quarters_id_fk" FOREIGN KEY ("revenue_qtr_id") REFERENCES "quarters"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "budget_search" ADD CONSTRAINT "budget_search_forecast_status_id_forecast_statuses_id_fk" FOREIGN KEY ("forecast_status_id") REFERENCES "forecast_statuses"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "budget_search" ADD CONSTRAINT "budget_search_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "budget_search" ADD CONSTRAINT "budget_search_parent_id_customers_id_fk" FOREIGN KEY ("parent_id") REFERENCES "customers"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "budget_search" ADD CONSTRAINT "budget_search_consolidated_customer_id_customers_id_fk" FOREIGN KEY ("consolidated_customer_id") REFERENCES "customers"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "budget_search" ADD CONSTRAINT "budget_search_account_manager_id_employees_id_fk" FOREIGN KEY ("account_manager_id") REFERENCES "employees"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bs_ns_id_idx" ON "budget_search" ("netsuite_internal_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bs_sync_idx" ON "budget_search" ("sync_status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bs_parent_idx" ON "budget_search" ("parent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bs_dept_idx" ON "budget_search" ("department_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bs_forecast_status_idx" ON "budget_search" ("forecast_status_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bs_name_idx" ON "budget_search" ("name");
