ALTER TABLE "factories" ADD COLUMN "vendor_id" integer REFERENCES "vendors"("id");
--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "country" varchar(100);
