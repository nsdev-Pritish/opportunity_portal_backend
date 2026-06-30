CREATE TABLE IF NOT EXISTS "estimate_quote_search" (
  "id" serial PRIMARY KEY NOT NULL,
  "document_number" varchar(100),
  "department_id" integer,
  "customer_id" integer,
  "consolidated_customer_id" integer,
  "top_level_parent_id" integer,
  "status_id" integer,
  "tran_date" date,
  "expected_close_date" date,
  "promised_delivery_date" date,
  "projected_total" numeric,
  "exchange_rate" numeric,
  "currency_id" integer,
  "subsidiary_id" integer,
  "project_name_id" integer,
  "business_vertical_id" integer,
  "sales_rep_id" integer,
  "likely_to_close_id" integer,
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
ALTER TABLE "estimate_quote_search" ADD CONSTRAINT "estimate_quote_search_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "estimate_quote_search" ADD CONSTRAINT "estimate_quote_search_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "estimate_quote_search" ADD CONSTRAINT "estimate_quote_search_consolidated_customer_id_customers_id_fk" FOREIGN KEY ("consolidated_customer_id") REFERENCES "customers"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "estimate_quote_search" ADD CONSTRAINT "estimate_quote_search_top_level_parent_id_customers_id_fk" FOREIGN KEY ("top_level_parent_id") REFERENCES "customers"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "estimate_quote_search" ADD CONSTRAINT "estimate_quote_search_status_id_estimate_statuses_id_fk" FOREIGN KEY ("status_id") REFERENCES "estimate_statuses"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "estimate_quote_search" ADD CONSTRAINT "estimate_quote_search_currency_id_currencies_id_fk" FOREIGN KEY ("currency_id") REFERENCES "currencies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "estimate_quote_search" ADD CONSTRAINT "estimate_quote_search_subsidiary_id_subsidiaries_id_fk" FOREIGN KEY ("subsidiary_id") REFERENCES "subsidiaries"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "estimate_quote_search" ADD CONSTRAINT "estimate_quote_search_project_name_id_project_names_id_fk" FOREIGN KEY ("project_name_id") REFERENCES "project_names"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "estimate_quote_search" ADD CONSTRAINT "estimate_quote_search_business_vertical_id_business_verticals_id_fk" FOREIGN KEY ("business_vertical_id") REFERENCES "business_verticals"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "estimate_quote_search" ADD CONSTRAINT "estimate_quote_search_sales_rep_id_account_managers_id_fk" FOREIGN KEY ("sales_rep_id") REFERENCES "account_managers"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "estimate_quote_search" ADD CONSTRAINT "estimate_quote_search_likely_to_close_id_likely_to_close_id_fk" FOREIGN KEY ("likely_to_close_id") REFERENCES "likely_to_close"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "eqs_ns_id_idx" ON "estimate_quote_search" ("netsuite_internal_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "eqs_sync_idx" ON "estimate_quote_search" ("sync_status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "eqs_customer_idx" ON "estimate_quote_search" ("customer_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "eqs_status_idx" ON "estimate_quote_search" ("status_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "eqs_doc_num_idx" ON "estimate_quote_search" ("document_number");
