ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "otb_converted_at" timestamptz;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "estimate_quotes" (
  "id"                          serial PRIMARY KEY,
  "estimate_id"                 integer NOT NULL REFERENCES "estimates"("id") ON DELETE CASCADE,
  "quote_netsuite_internal_id"  varchar(50),
  "quote_document_number"       varchar(100),
  "status"                      varchar(20) NOT NULL DEFAULT 'active',
  "sync_status"                 sync_status NOT NULL DEFAULT 'pending',
  "sync_error"                  text,
  "synced_at"                   timestamptz,
  "created_at"                  timestamptz NOT NULL DEFAULT now(),
  "updated_at"                  timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "eq_estimate_idx" ON "estimate_quotes"("estimate_id");
