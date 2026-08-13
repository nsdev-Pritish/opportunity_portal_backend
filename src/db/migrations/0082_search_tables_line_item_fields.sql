-- estimate_quote_search / sales_order_search: new line-item fields per Gina
-- Chang's pipeline field list ("column add pipeline and so" — AI Revenue
-- Logic.xlsx). Both tables share the same column set by convention (see the
-- header comment above sales_order_search).
--
-- All additive (ADD COLUMN IF NOT EXISTS) and nullable, so existing rows are
-- untouched and re-running the file is safe. netsuite_internal_id stays
-- unique for now — these columns are added but the create/update APIs and
-- the one-row-per-line grain change are a separate, later step.

-- ── Estimate Quote Search ────────────────────────────────────────────
ALTER TABLE "estimate_quote_search"
  ADD COLUMN IF NOT EXISTS "line_unique_key"    varchar(50),
  ADD COLUMN IF NOT EXISTS "line_number"        integer,
  ADD COLUMN IF NOT EXISTS "created_from_direct" varchar(255),
  ADD COLUMN IF NOT EXISTS "item_id"            integer,
  ADD COLUMN IF NOT EXISTS "item_name"          varchar(255),
  ADD COLUMN IF NOT EXISTS "item_type"          varchar(100),
  ADD COLUMN IF NOT EXISTS "quantity"           numeric,
  ADD COLUMN IF NOT EXISTS "quantity_back_ordered" numeric,
  ADD COLUMN IF NOT EXISTS "unit_sales_price"   numeric,
  ADD COLUMN IF NOT EXISTS "line_amount"        numeric,
  ADD COLUMN IF NOT EXISTS "short_description"  varchar(500),
  ADD COLUMN IF NOT EXISTS "vendor_currency"    varchar(100),
  ADD COLUMN IF NOT EXISTS "description"        text,
  ADD COLUMN IF NOT EXISTS "line_project_id"    integer,
  ADD COLUMN IF NOT EXISTS "line_project_type_id" integer;
--> statement-breakpoint
ALTER TABLE "estimate_quote_search" ADD CONSTRAINT "estimate_quote_search_item_id_cs_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."cs_items"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "estimate_quote_search" ADD CONSTRAINT "estimate_quote_search_line_project_id_project_names_id_fk" FOREIGN KEY ("line_project_id") REFERENCES "public"."project_names"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "estimate_quote_search" ADD CONSTRAINT "estimate_quote_search_line_project_type_id_project_types_id_fk" FOREIGN KEY ("line_project_type_id") REFERENCES "public"."project_types"("id") ON DELETE no action ON UPDATE no action;

-- ── Sales Order Search ───────────────────────────────────────────────
--> statement-breakpoint
ALTER TABLE "sales_order_search"
  ADD COLUMN IF NOT EXISTS "line_unique_key"    varchar(50),
  ADD COLUMN IF NOT EXISTS "line_number"        integer,
  ADD COLUMN IF NOT EXISTS "created_from_direct" varchar(255),
  ADD COLUMN IF NOT EXISTS "item_id"            integer,
  ADD COLUMN IF NOT EXISTS "item_name"          varchar(255),
  ADD COLUMN IF NOT EXISTS "item_type"          varchar(100),
  ADD COLUMN IF NOT EXISTS "quantity"           numeric,
  ADD COLUMN IF NOT EXISTS "quantity_back_ordered" numeric,
  ADD COLUMN IF NOT EXISTS "unit_sales_price"   numeric,
  ADD COLUMN IF NOT EXISTS "line_amount"        numeric,
  ADD COLUMN IF NOT EXISTS "short_description"  varchar(500),
  ADD COLUMN IF NOT EXISTS "vendor_currency"    varchar(100),
  ADD COLUMN IF NOT EXISTS "description"        text,
  ADD COLUMN IF NOT EXISTS "line_project_id"    integer,
  ADD COLUMN IF NOT EXISTS "line_project_type_id" integer;
--> statement-breakpoint
ALTER TABLE "sales_order_search" ADD CONSTRAINT "sales_order_search_item_id_cs_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."cs_items"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales_order_search" ADD CONSTRAINT "sales_order_search_line_project_id_project_names_id_fk" FOREIGN KEY ("line_project_id") REFERENCES "public"."project_names"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales_order_search" ADD CONSTRAINT "sales_order_search_line_project_type_id_project_types_id_fk" FOREIGN KEY ("line_project_type_id") REFERENCES "public"."project_types"("id") ON DELETE no action ON UPDATE no action;
