CREATE TABLE IF NOT EXISTS "lcl_rates" (
  "id" serial PRIMARY KEY NOT NULL,
  "name" varchar(255) NOT NULL,
  "pol" varchar(255),
  "pod" varchar(255),
  "price_per_cbm" numeric(15, 4),
  "min_flat_rate" numeric(15, 4),
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
CREATE UNIQUE INDEX IF NOT EXISTS "lcl_rates_ns_id_idx" ON "lcl_rates" ("netsuite_internal_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fcl_rates" (
  "id" serial PRIMARY KEY NOT NULL,
  "name" varchar(255) NOT NULL,
  "pol" varchar(255),
  "pod" varchar(255),
  "container20" numeric(15, 4),
  "container40" numeric(15, 4),
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
CREATE UNIQUE INDEX IF NOT EXISTS "fcl_rates_ns_id_idx" ON "fcl_rates" ("netsuite_internal_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "air_rates" (
  "id" serial PRIMARY KEY NOT NULL,
  "name" varchar(255) NOT NULL,
  "pol" varchar(255),
  "pod" varchar(255),
  "price_per_kg" numeric(15, 4),
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
CREATE UNIQUE INDEX IF NOT EXISTS "air_rates_ns_id_idx" ON "air_rates" ("netsuite_internal_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "additional_fees" (
  "id" serial PRIMARY KEY NOT NULL,
  "name" varchar(255) NOT NULL,
  "freight_type" varchar(100),
  "doc_fee" numeric(15, 4),
  "ams_fee" numeric(15, 4),
  "de_consol_fee" numeric(15, 4),
  "ddsis_fee" numeric(15, 4),
  "fce_fee" numeric(15, 4),
  "pier_pass" numeric(15, 4),
  "handling_fee" numeric(15, 4),
  "isf_filing" numeric(15, 4),
  "entry_fee" numeric(15, 4),
  "pallet_surcharge" numeric(15, 4),
  "carrier_import_fee" numeric(15, 4),
  "add_fee_total" numeric(15, 4),
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
CREATE UNIQUE INDEX IF NOT EXISTS "additional_fees_ns_id_idx" ON "additional_fees" ("netsuite_internal_id");
