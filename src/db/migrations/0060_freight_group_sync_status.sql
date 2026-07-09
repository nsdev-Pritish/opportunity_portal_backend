-- Add sync tracking to freight groups so a NetSuite sync outcome can be surfaced
-- per group in the UI (matching estimates + estimate_line_items).
-- The sync_status enum type already exists (created for estimates/line items).

ALTER TABLE estimate_freight_groups
  ADD COLUMN IF NOT EXISTS sync_status sync_status NOT NULL DEFAULT 'pending';
--> statement-breakpoint
ALTER TABLE estimate_freight_groups
  ADD COLUMN IF NOT EXISTS sync_error text;
--> statement-breakpoint
ALTER TABLE estimate_freight_groups
  ADD COLUMN IF NOT EXISTS synced_at timestamptz;
