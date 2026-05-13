-- Extend addresses table for client billing/shipping dropdowns
ALTER TABLE "addresses" ADD COLUMN "company_name" varchar(255);--> statement-breakpoint
ALTER TABLE "addresses" ADD COLUMN "attention" varchar(255);--> statement-breakpoint
ALTER TABLE "addresses" ADD COLUMN "addressee" varchar(255);--> statement-breakpoint
ALTER TABLE "addresses" ADD COLUMN "phone" varchar(50);--> statement-breakpoint
CREATE INDEX "addresses_type_idx" ON "addresses" USING btree ("type");--> statement-breakpoint

-- Dedicated client incoterms table
CREATE TABLE "client_incoterms" (
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
);--> statement-breakpoint

-- Dedicated client shipping methods table
CREATE TABLE "client_shipping_methods" (
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

