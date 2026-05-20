-- Vendor addresses: add new address fields, drop label, add indexes
ALTER TABLE "vendor_addresses" DROP COLUMN IF EXISTS "label";--> statement-breakpoint
ALTER TABLE "vendor_addresses" ADD COLUMN IF NOT EXISTS "attention" varchar(255);--> statement-breakpoint
ALTER TABLE "vendor_addresses" ADD COLUMN IF NOT EXISTS "addressee" varchar(255);--> statement-breakpoint
ALTER TABLE "vendor_addresses" ADD COLUMN IF NOT EXISTS "phone" varchar(50);--> statement-breakpoint
ALTER TABLE "vendor_addresses" ADD COLUMN IF NOT EXISTS "addr_line2" varchar(255);--> statement-breakpoint
ALTER TABLE "vendor_addresses" ADD COLUMN IF NOT EXISTS "state" varchar(100);--> statement-breakpoint
ALTER TABLE "vendor_addresses" ADD COLUMN IF NOT EXISTS "zip" varchar(20);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vendor_addresses_ns_id_idx" ON "vendor_addresses" ("netsuite_internal_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendor_addresses_vendor_idx" ON "vendor_addresses" ("vendor_id");
