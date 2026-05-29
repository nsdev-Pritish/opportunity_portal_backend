-- Create product_classes_eu lookup table

CREATE TABLE "product_classes_eu" (
  "id"                      serial PRIMARY KEY NOT NULL,
  "name"                    varchar(255) NOT NULL,
  "parent_class"            varchar(255),
  "class_code"              varchar(255),
  "eu_hts_code"             varchar(50),
  "china_duty_rate"         numeric(10, 3),
  "cambodia_duty_rate"      numeric(10, 3),
  "taiwan_duty_rate"        numeric(10, 3),
  "thailand_duty_rate"      numeric(10, 3),
  "vietnam_duty_rate"       numeric(10, 3),
  "netsuite_internal_id"    varchar(50),
  "is_active"               boolean DEFAULT true NOT NULL,
  "source"                  "source" DEFAULT 'portal' NOT NULL,
  "sync_status"             "sync_status" DEFAULT 'pending' NOT NULL,
  "sync_error"              text,
  "synced_at"               timestamp with time zone,
  "created_at"              timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"              timestamp with time zone DEFAULT now() NOT NULL
);

-- Add EU product class FK to estimate_line_items
ALTER TABLE "estimate_line_items"
  ADD COLUMN IF NOT EXISTS "product_class_eu_id" integer REFERENCES "product_classes_eu"("id");
