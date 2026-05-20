CREATE TABLE IF NOT EXISTS "cs_items" (
  "id" serial PRIMARY KEY NOT NULL,
  "item_name" varchar(255) NOT NULL,
  "subsidiary_id" integer REFERENCES "subsidiaries"("id"),
  "is_fee_item" boolean DEFAULT false NOT NULL,
  "currency_id" integer REFERENCES "currencies"("id"),
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
CREATE UNIQUE INDEX IF NOT EXISTS "cs_items_ns_id_idx" ON "cs_items" ("netsuite_internal_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cs_items_subsidiary_idx" ON "cs_items" ("subsidiary_id");
