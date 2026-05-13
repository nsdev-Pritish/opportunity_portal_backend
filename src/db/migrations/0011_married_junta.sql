CREATE TABLE IF NOT EXISTS "client_incoterms" (
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
CREATE TABLE IF NOT EXISTS "client_shipping_methods" (
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
DROP TABLE IF EXISTS "incoterms" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "shipping_methods" CASCADE;--> statement-breakpoint
ALTER TABLE "estimate_line_items" DROP CONSTRAINT IF EXISTS "estimate_line_items_vendor_incoterms_id_incoterms_id_fk";
--> statement-breakpoint
ALTER TABLE "estimates" DROP CONSTRAINT IF EXISTS "estimates_client_incoterms_id_incoterms_id_fk";
--> statement-breakpoint
ALTER TABLE "estimates" DROP CONSTRAINT IF EXISTS "estimates_client_ship_method_id_shipping_methods_id_fk";
--> statement-breakpoint
ALTER TABLE "addresses" ADD COLUMN IF NOT EXISTS "company_name" varchar(255);--> statement-breakpoint
ALTER TABLE "addresses" ADD COLUMN IF NOT EXISTS "attention" varchar(255);--> statement-breakpoint
ALTER TABLE "addresses" ADD COLUMN IF NOT EXISTS "addressee" varchar(255);--> statement-breakpoint
ALTER TABLE "addresses" ADD COLUMN IF NOT EXISTS "phone" varchar(50);--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "client_incoterms_id" integer REFERENCES "client_incoterms"("id");--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "client_ship_method_id" integer REFERENCES "client_shipping_methods"("id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "addresses_type_idx" ON "addresses" USING btree ("type");--> statement-breakpoint
ALTER TABLE "estimate_line_items" DROP COLUMN IF EXISTS "vendor_incoterms_id";
