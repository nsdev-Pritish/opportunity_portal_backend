CREATE TABLE IF NOT EXISTS "credit_memo_search" (
  "id" serial PRIMARY KEY NOT NULL,
  "document_number" varchar(100),
  "department_id" integer,
  "customer_id" integer,
  "consolidated_customer" varchar(500),
  "top_level_parent_id" integer,
  "created_from" varchar(255),
  "created_from_internal_id" varchar(50),
  "invoice_document_number" varchar(100),
  "invoice_date" date,
  "credit_memo_date" date,
  "amount" numeric,
  "currency_id" integer,
  "subsidiary_id" integer,
  "project_name_id" integer,
  "sales_rep_id" integer,
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
ALTER TABLE "credit_memo_search" ADD CONSTRAINT "credit_memo_search_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "credit_memo_search" ADD CONSTRAINT "credit_memo_search_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "credit_memo_search" ADD CONSTRAINT "credit_memo_search_top_level_parent_id_customers_id_fk" FOREIGN KEY ("top_level_parent_id") REFERENCES "customers"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "credit_memo_search" ADD CONSTRAINT "credit_memo_search_currency_id_currencies_id_fk" FOREIGN KEY ("currency_id") REFERENCES "currencies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "credit_memo_search" ADD CONSTRAINT "credit_memo_search_subsidiary_id_subsidiaries_id_fk" FOREIGN KEY ("subsidiary_id") REFERENCES "subsidiaries"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "credit_memo_search" ADD CONSTRAINT "credit_memo_search_project_name_id_project_names_id_fk" FOREIGN KEY ("project_name_id") REFERENCES "project_names"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "credit_memo_search" ADD CONSTRAINT "credit_memo_search_sales_rep_id_account_managers_id_fk" FOREIGN KEY ("sales_rep_id") REFERENCES "account_managers"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cms_ns_id_idx" ON "credit_memo_search" ("netsuite_internal_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cms_sync_idx" ON "credit_memo_search" ("sync_status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cms_customer_idx" ON "credit_memo_search" ("customer_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cms_doc_num_idx" ON "credit_memo_search" ("document_number");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cms_created_from_idx" ON "credit_memo_search" ("created_from");
