ALTER TABLE "factories" DROP CONSTRAINT "factories_vendor_id_vendors_id_fk";
--> statement-breakpoint
DROP INDEX "factories_vendor_idx";--> statement-breakpoint
ALTER TABLE "product_classes" ADD COLUMN "parent_class" varchar(255);--> statement-breakpoint
ALTER TABLE "product_classes" ADD COLUMN "class_code" varchar(255);--> statement-breakpoint
ALTER TABLE "product_classes" ADD COLUMN "us_hts_code" varchar(50);--> statement-breakpoint
ALTER TABLE "product_classes" ADD COLUMN "china_duty_rate" numeric(6, 3);--> statement-breakpoint
ALTER TABLE "product_classes" ADD COLUMN "cambodia_duty_rate" numeric(6, 3);--> statement-breakpoint
ALTER TABLE "product_classes" ADD COLUMN "taiwan_duty_rate" numeric(6, 3);--> statement-breakpoint
ALTER TABLE "product_classes" ADD COLUMN "thailand_duty_rate" numeric(6, 3);--> statement-breakpoint
ALTER TABLE "product_classes" ADD COLUMN "vietnam_duty_rate" numeric(6, 3);--> statement-breakpoint
ALTER TABLE "product_classes" ADD COLUMN "china_tariff_rate" numeric(6, 3);--> statement-breakpoint
ALTER TABLE "product_classes" ADD COLUMN "hk_tariff_rate" numeric(6, 3);--> statement-breakpoint
ALTER TABLE "product_classes" ADD COLUMN "taiwan_tariff_rate" numeric(6, 3);--> statement-breakpoint
ALTER TABLE "product_classes" ADD COLUMN "vietnam_tariff_rate" numeric(6, 3);--> statement-breakpoint
ALTER TABLE "product_classes" ADD COLUMN "cambodia_tariff_rate" numeric(6, 3);--> statement-breakpoint
ALTER TABLE "product_classes" ADD COLUMN "thailand_tariff_rate" numeric(6, 3);--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "company_name" varchar(255);--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "subsidiary_id" integer;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_subsidiary_id_subsidiaries_id_fk" FOREIGN KEY ("subsidiary_id") REFERENCES "public"."subsidiaries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vendors_subsidiary_idx" ON "vendors" USING btree ("subsidiary_id");--> statement-breakpoint
ALTER TABLE "factories" DROP COLUMN "vendor_id";--> statement-breakpoint
ALTER TABLE "factories" DROP COLUMN "lead_time_days";--> statement-breakpoint
ALTER TABLE "product_classes" DROP COLUMN "description";--> statement-breakpoint
ALTER TABLE "product_classes" DROP COLUMN "tariff_default_pct";--> statement-breakpoint
ALTER TABLE "sustainability_options" DROP COLUMN "description";--> statement-breakpoint
ALTER TABLE "sustainability_options" DROP COLUMN "cert_body";--> statement-breakpoint
ALTER TABLE "sustainability_options" DROP COLUMN "netsuite_internal_id";--> statement-breakpoint
ALTER TABLE "sustainability_options" DROP COLUMN "is_active";--> statement-breakpoint
ALTER TABLE "sustainability_options" DROP COLUMN "source";--> statement-breakpoint
ALTER TABLE "sustainability_options" DROP COLUMN "sync_status";--> statement-breakpoint
ALTER TABLE "sustainability_options" DROP COLUMN "sync_error";--> statement-breakpoint
ALTER TABLE "sustainability_options" DROP COLUMN "synced_at";--> statement-breakpoint
ALTER TABLE "sustainability_options" DROP COLUMN "created_at";--> statement-breakpoint
ALTER TABLE "sustainability_options" DROP COLUMN "updated_at";--> statement-breakpoint
ALTER TABLE "vendors" DROP COLUMN "email";--> statement-breakpoint
ALTER TABLE "vendors" DROP COLUMN "payment_terms";