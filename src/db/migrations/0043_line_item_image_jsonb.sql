ALTER TABLE estimate_line_items DROP COLUMN IF EXISTS image_url;
--> statement-breakpoint
ALTER TABLE estimate_line_items ADD COLUMN image jsonb;
