CREATE TYPE "public"."country_of_dest" AS ENUM('US', 'EU');--> statement-breakpoint
CREATE TYPE "public"."direction" AS ENUM('to_netsuite', 'from_netsuite');--> statement-breakpoint
CREATE TYPE "public"."estimate_status" AS ENUM('draft', 'submitted', 'approved', 'otb', 'closed_won', 'closed_lost');--> statement-breakpoint
CREATE TYPE "public"."operation" AS ENUM('create', 'update', 'deactivate');--> statement-breakpoint
CREATE TYPE "public"."source" AS ENUM('portal', 'netsuite');--> statement-breakpoint
CREATE TYPE "public"."sync_status" AS ENUM('pending', 'synced', 'dirty', 'failed', 'skipped');--> statement-breakpoint
CREATE TABLE "addresses" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer,
	"type" varchar(20) DEFAULT 'shipping',
	"label" varchar(100),
	"addr_line1" varchar(255),
	"addr_line2" varchar(255),
	"city" varchar(100),
	"state" varchar(100),
	"country" varchar(100),
	"postal_code" varchar(20),
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
CREATE TABLE "api_keys" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"key_hash" varchar(255) NOT NULL,
	"key_prefix" varchar(8) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "business_types" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
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
CREATE TABLE "business_verticals" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
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
CREATE TABLE "compliance_partners" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"contact_name" varchar(255),
	"cert_types" jsonb DEFAULT '[]'::jsonb,
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
CREATE TABLE "contacts" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"first_name" varchar(100),
	"last_name" varchar(100),
	"email" varchar(255),
	"phone" varchar(50),
	"title" varchar(100),
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
CREATE TABLE "currencies" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" varchar(3) NOT NULL,
	"name" varchar(100) NOT NULL,
	"symbol" varchar(10),
	"exchange_rate" numeric(12, 6) DEFAULT '1',
	"netsuite_internal_id" varchar(50),
	"is_active" boolean DEFAULT true NOT NULL,
	"source" "source" DEFAULT 'portal' NOT NULL,
	"sync_status" "sync_status" DEFAULT 'pending' NOT NULL,
	"sync_error" text,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "currencies_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"email" varchar(255),
	"phone" varchar(50),
	"currency_id" integer,
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
CREATE TABLE "departments" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"code" varchar(50),
	"parent_id" integer,
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
CREATE TABLE "employees" (
	"id" serial PRIMARY KEY NOT NULL,
	"first_name" varchar(100) NOT NULL,
	"last_name" varchar(100) NOT NULL,
	"email" varchar(255),
	"roles" jsonb DEFAULT '[]'::jsonb,
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
CREATE TABLE "estimate_line_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"netsuite_internal_id" varchar(50),
	"estimate_id" integer NOT NULL,
	"line_number" integer NOT NULL,
	"item_type_id" integer,
	"short_description" varchar(500),
	"vendor_id" integer,
	"quantity" numeric(12, 4) DEFAULT '0',
	"sell_price_per_unit" numeric(15, 4) DEFAULT '0',
	"sku_margin_pct" numeric(6, 3) DEFAULT '0',
	"sales_amount" numeric(15, 2),
	"pickup_exw_fob" numeric(15, 2),
	"ocean_ddp" numeric(15, 2),
	"air_ddp" numeric(15, 2),
	"exclude" boolean DEFAULT false,
	"description" text,
	"factory_id" integer,
	"vendor_currency_id" integer,
	"factory_cost_per_unit" numeric(15, 4) DEFAULT '0',
	"packing_cost_per_unit" numeric(15, 4) DEFAULT '0',
	"sample_fees" numeric(15, 2) DEFAULT '0',
	"other_per_unit" numeric(15, 4) DEFAULT '0',
	"freight_per_unit" numeric(15, 4) DEFAULT '0',
	"duty_pct" numeric(6, 3) DEFAULT '0',
	"tariff_pct" numeric(6, 3) DEFAULT '10',
	"tariff_mu_pct" numeric(6, 3) DEFAULT '0',
	"other_cost_pct" numeric(6, 3) DEFAULT '0',
	"padding_pct" numeric(6, 3) DEFAULT '0',
	"usd_factory_cost" numeric(15, 4),
	"landed_cost_per_unit" numeric(15, 4),
	"extended_landed_cost" numeric(15, 2),
	"product_class_id" integer,
	"sustainability_id" integer,
	"hts_code" varchar(20),
	"country_of_origin" varchar(100),
	"country_of_dest" "country_of_dest" DEFAULT 'US',
	"units_per_carton" integer,
	"dim_l_cm" numeric(8, 2),
	"dim_w_cm" numeric(8, 2),
	"dim_h_cm" numeric(8, 2),
	"weight_kg_per_carton" numeric(8, 3),
	"cbm_per_carton" numeric(10, 5),
	"total_cartons" integer DEFAULT 0,
	"total_cbm" numeric(10, 3),
	"chargeable_weight_kg" numeric(10, 3),
	"shipping_group_id" integer,
	"ex_factory_date" date,
	"vendor_incoterms_id" integer,
	"ship_to_vendor_id" integer,
	"ship_to_vendor_addr_id" integer,
	"notes" text,
	"sync_status" "sync_status" DEFAULT 'pending' NOT NULL,
	"sync_error" text,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "estimate_line_items_netsuite_internal_id_unique" UNIQUE("netsuite_internal_id")
);
--> statement-breakpoint
CREATE TABLE "estimates" (
	"id" serial PRIMARY KEY NOT NULL,
	"netsuite_internal_id" varchar(50),
	"customer_id" integer NOT NULL,
	"customer_contact_id" integer,
	"customer_po" varchar(100),
	"project_name" varchar(255) NOT NULL,
	"project_type_id" integer,
	"expected_close_date" date,
	"promise_date" date,
	"likely_to_close_id" integer,
	"sell_currency_id" integer,
	"projected_total_amt" numeric(15, 2),
	"estimated_qty" integer,
	"department_id" integer,
	"sales_channel_id" integer,
	"business_vertical_id" integer,
	"business_type_id" integer,
	"compliance_partner_id" integer,
	"acct_manager_id" integer,
	"product_developer_id" integer,
	"hk_partner_id" integer,
	"ops_partner_1_id" integer,
	"ops_partner_2_id" integer,
	"deck_request" boolean DEFAULT false,
	"art_setup_request" boolean DEFAULT false,
	"pkg_deck_request" boolean DEFAULT false,
	"pkg_art_setup_request" boolean DEFAULT false,
	"client_incoterms_id" integer,
	"client_ship_method_id" integer,
	"shipping_address_id" integer,
	"billing_address_id" integer,
	"sample_only_order" boolean DEFAULT false,
	"re_order" boolean DEFAULT false,
	"bible_link" varchar(1000),
	"memo" text,
	"attachments" jsonb DEFAULT '[]'::jsonb,
	"status" "estimate_status" DEFAULT 'draft' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"source" "source" DEFAULT 'portal' NOT NULL,
	"sync_status" "sync_status" DEFAULT 'pending' NOT NULL,
	"sync_error" text,
	"synced_at" timestamp with time zone,
	"created_by" integer,
	"updated_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "estimates_netsuite_internal_id_unique" UNIQUE("netsuite_internal_id")
);
--> statement-breakpoint
CREATE TABLE "factories" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"vendor_id" integer,
	"country" varchar(100),
	"lead_time_days" integer,
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
CREATE TABLE "hk_partners" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"contact_name" varchar(255),
	"email" varchar(255),
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
CREATE TABLE "incoterms" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" varchar(10) NOT NULL,
	"full_name" varchar(255) NOT NULL,
	"rules_version" varchar(10) DEFAULT '2020',
	"netsuite_internal_id" varchar(50),
	"is_active" boolean DEFAULT true NOT NULL,
	"source" "source" DEFAULT 'portal' NOT NULL,
	"sync_status" "sync_status" DEFAULT 'pending' NOT NULL,
	"sync_error" text,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incoterms_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "item_types" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"requires_hts" boolean DEFAULT false,
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
CREATE TABLE "likely_to_close" (
	"id" serial PRIMARY KEY NOT NULL,
	"label" varchar(100) NOT NULL,
	"probability_pct" integer NOT NULL,
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
CREATE TABLE "ops_partners" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"contact_name" varchar(255),
	"region" varchar(100),
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
CREATE TABLE "product_classes" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"tariff_default_pct" numeric(6, 3) DEFAULT '10',
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
CREATE TABLE "project_types" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
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
CREATE TABLE "sales_channels" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
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
CREATE TABLE "shipping_groups" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"volumetric_divisor" numeric(10, 2) DEFAULT '5000',
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
CREATE TABLE "shipping_methods" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"carrier" varchar(100),
	"transit_days" integer,
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
CREATE TABLE "sustainability_options" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"cert_body" varchar(100),
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
CREATE TABLE "sync_conflicts" (
	"id" serial PRIMARY KEY NOT NULL,
	"entity_type" varchar(50) NOT NULL,
	"entity_id" integer,
	"netsuite_internal_id" varchar(50),
	"portal_data" jsonb NOT NULL,
	"netsuite_data" jsonb NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolution" varchar(20),
	"resolved_by" integer,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sync_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"entity_type" varchar(50) NOT NULL,
	"entity_id" integer,
	"netsuite_internal_id" varchar(50),
	"operation" "operation" NOT NULL,
	"direction" "direction" NOT NULL,
	"status" varchar(20) NOT NULL,
	"attempt_count" integer DEFAULT 1,
	"portal_payload" jsonb,
	"netsuite_response" jsonb,
	"error_message" text,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" varchar(255) NOT NULL,
	"password_hash" varchar(255) NOT NULL,
	"first_name" varchar(100),
	"last_name" varchar(100),
	"role" varchar(50) DEFAULT 'user' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "vendor_addresses" (
	"id" serial PRIMARY KEY NOT NULL,
	"vendor_id" integer NOT NULL,
	"label" varchar(100),
	"addr_line1" varchar(255),
	"city" varchar(100),
	"country" varchar(100),
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
CREATE TABLE "vendors" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"email" varchar(255),
	"payment_terms" varchar(100),
	"default_currency_id" integer,
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
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimate_line_items" ADD CONSTRAINT "estimate_line_items_estimate_id_estimates_id_fk" FOREIGN KEY ("estimate_id") REFERENCES "public"."estimates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimate_line_items" ADD CONSTRAINT "estimate_line_items_item_type_id_item_types_id_fk" FOREIGN KEY ("item_type_id") REFERENCES "public"."item_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimate_line_items" ADD CONSTRAINT "estimate_line_items_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimate_line_items" ADD CONSTRAINT "estimate_line_items_factory_id_factories_id_fk" FOREIGN KEY ("factory_id") REFERENCES "public"."factories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimate_line_items" ADD CONSTRAINT "estimate_line_items_vendor_currency_id_currencies_id_fk" FOREIGN KEY ("vendor_currency_id") REFERENCES "public"."currencies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimate_line_items" ADD CONSTRAINT "estimate_line_items_product_class_id_product_classes_id_fk" FOREIGN KEY ("product_class_id") REFERENCES "public"."product_classes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimate_line_items" ADD CONSTRAINT "estimate_line_items_sustainability_id_sustainability_options_id_fk" FOREIGN KEY ("sustainability_id") REFERENCES "public"."sustainability_options"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimate_line_items" ADD CONSTRAINT "estimate_line_items_shipping_group_id_shipping_groups_id_fk" FOREIGN KEY ("shipping_group_id") REFERENCES "public"."shipping_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimate_line_items" ADD CONSTRAINT "estimate_line_items_vendor_incoterms_id_incoterms_id_fk" FOREIGN KEY ("vendor_incoterms_id") REFERENCES "public"."incoterms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimate_line_items" ADD CONSTRAINT "estimate_line_items_ship_to_vendor_id_vendors_id_fk" FOREIGN KEY ("ship_to_vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimate_line_items" ADD CONSTRAINT "estimate_line_items_ship_to_vendor_addr_id_vendor_addresses_id_fk" FOREIGN KEY ("ship_to_vendor_addr_id") REFERENCES "public"."vendor_addresses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_customer_contact_id_contacts_id_fk" FOREIGN KEY ("customer_contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_project_type_id_project_types_id_fk" FOREIGN KEY ("project_type_id") REFERENCES "public"."project_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_likely_to_close_id_likely_to_close_id_fk" FOREIGN KEY ("likely_to_close_id") REFERENCES "public"."likely_to_close"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_sell_currency_id_currencies_id_fk" FOREIGN KEY ("sell_currency_id") REFERENCES "public"."currencies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_sales_channel_id_sales_channels_id_fk" FOREIGN KEY ("sales_channel_id") REFERENCES "public"."sales_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_business_vertical_id_business_verticals_id_fk" FOREIGN KEY ("business_vertical_id") REFERENCES "public"."business_verticals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_business_type_id_business_types_id_fk" FOREIGN KEY ("business_type_id") REFERENCES "public"."business_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_compliance_partner_id_compliance_partners_id_fk" FOREIGN KEY ("compliance_partner_id") REFERENCES "public"."compliance_partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_acct_manager_id_employees_id_fk" FOREIGN KEY ("acct_manager_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_product_developer_id_employees_id_fk" FOREIGN KEY ("product_developer_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_hk_partner_id_hk_partners_id_fk" FOREIGN KEY ("hk_partner_id") REFERENCES "public"."hk_partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_ops_partner_1_id_ops_partners_id_fk" FOREIGN KEY ("ops_partner_1_id") REFERENCES "public"."ops_partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_ops_partner_2_id_ops_partners_id_fk" FOREIGN KEY ("ops_partner_2_id") REFERENCES "public"."ops_partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_client_incoterms_id_incoterms_id_fk" FOREIGN KEY ("client_incoterms_id") REFERENCES "public"."incoterms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_client_ship_method_id_shipping_methods_id_fk" FOREIGN KEY ("client_ship_method_id") REFERENCES "public"."shipping_methods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_shipping_address_id_addresses_id_fk" FOREIGN KEY ("shipping_address_id") REFERENCES "public"."addresses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_billing_address_id_addresses_id_fk" FOREIGN KEY ("billing_address_id") REFERENCES "public"."addresses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "factories" ADD CONSTRAINT "factories_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_conflicts" ADD CONSTRAINT "sync_conflicts_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_addresses" ADD CONSTRAINT "vendor_addresses_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_default_currency_id_currencies_id_fk" FOREIGN KEY ("default_currency_id") REFERENCES "public"."currencies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "addresses_ns_id_idx" ON "addresses" USING btree ("netsuite_internal_id");--> statement-breakpoint
CREATE INDEX "addresses_customer_idx" ON "addresses" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_ns_id_idx" ON "contacts" USING btree ("netsuite_internal_id");--> statement-breakpoint
CREATE INDEX "contacts_customer_idx" ON "contacts" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_ns_id_idx" ON "customers" USING btree ("netsuite_internal_id");--> statement-breakpoint
CREATE INDEX "customers_sync_idx" ON "customers" USING btree ("sync_status");--> statement-breakpoint
CREATE INDEX "customers_name_idx" ON "customers" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "employees_ns_id_idx" ON "employees" USING btree ("netsuite_internal_id");--> statement-breakpoint
CREATE INDEX "eli_estimate_idx" ON "estimate_line_items" USING btree ("estimate_id");--> statement-breakpoint
CREATE INDEX "eli_sync_idx" ON "estimate_line_items" USING btree ("sync_status");--> statement-breakpoint
CREATE INDEX "eli_vendor_idx" ON "estimate_line_items" USING btree ("vendor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "eli_line_number_idx" ON "estimate_line_items" USING btree ("estimate_id","line_number");--> statement-breakpoint
CREATE UNIQUE INDEX "estimates_ns_id_idx" ON "estimates" USING btree ("netsuite_internal_id");--> statement-breakpoint
CREATE INDEX "estimates_customer_idx" ON "estimates" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "estimates_sync_idx" ON "estimates" USING btree ("sync_status");--> statement-breakpoint
CREATE INDEX "estimates_updated_idx" ON "estimates" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "estimates_status_idx" ON "estimates" USING btree ("status");--> statement-breakpoint
CREATE INDEX "factories_vendor_idx" ON "factories" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "sync_logs_entity_idx" ON "sync_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "sync_logs_status_idx" ON "sync_logs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sync_logs_created_idx" ON "sync_logs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "vendors_ns_id_idx" ON "vendors" USING btree ("netsuite_internal_id");