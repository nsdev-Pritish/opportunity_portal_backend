CREATE TABLE IF NOT EXISTS "obc_pod_regions" (
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
CREATE UNIQUE INDEX IF NOT EXISTS "obc_pod_regions_ns_id_idx" ON "obc_pod_regions" ("netsuite_internal_id");
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "pod_region_id" integer;
--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_pod_region_id_obc_pod_regions_id_fk" FOREIGN KEY ("pod_region_id") REFERENCES "obc_pod_regions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customers_pod_region_idx" ON "customers" ("pod_region_id");
