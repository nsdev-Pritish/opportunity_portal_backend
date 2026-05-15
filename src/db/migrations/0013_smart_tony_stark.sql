ALTER TABLE "estimate_line_items" ALTER COLUMN "sku_margin_pct" SET DATA TYPE numeric(10, 3);--> statement-breakpoint
ALTER TABLE "estimate_line_items" ALTER COLUMN "sku_margin_pct" SET DEFAULT '0';--> statement-breakpoint
ALTER TABLE "estimate_line_items" ALTER COLUMN "duty_pct" SET DATA TYPE numeric(10, 3);--> statement-breakpoint
ALTER TABLE "estimate_line_items" ALTER COLUMN "duty_pct" SET DEFAULT '0';--> statement-breakpoint
ALTER TABLE "estimate_line_items" ALTER COLUMN "tariff_pct" SET DATA TYPE numeric(10, 3);--> statement-breakpoint
ALTER TABLE "estimate_line_items" ALTER COLUMN "tariff_pct" SET DEFAULT '10';--> statement-breakpoint
ALTER TABLE "estimate_line_items" ALTER COLUMN "tariff_mu_pct" SET DATA TYPE numeric(10, 3);--> statement-breakpoint
ALTER TABLE "estimate_line_items" ALTER COLUMN "tariff_mu_pct" SET DEFAULT '0';--> statement-breakpoint
ALTER TABLE "estimate_line_items" ALTER COLUMN "other_cost_pct" SET DATA TYPE numeric(10, 3);--> statement-breakpoint
ALTER TABLE "estimate_line_items" ALTER COLUMN "other_cost_pct" SET DEFAULT '0';--> statement-breakpoint
ALTER TABLE "estimate_line_items" ALTER COLUMN "padding_pct" SET DATA TYPE numeric(10, 3);--> statement-breakpoint
ALTER TABLE "estimate_line_items" ALTER COLUMN "padding_pct" SET DEFAULT '0';--> statement-breakpoint
ALTER TABLE "estimate_line_items" ALTER COLUMN "dim_l_cm" SET DATA TYPE numeric(10, 2);--> statement-breakpoint
ALTER TABLE "estimate_line_items" ALTER COLUMN "dim_w_cm" SET DATA TYPE numeric(10, 2);--> statement-breakpoint
ALTER TABLE "estimate_line_items" ALTER COLUMN "dim_h_cm" SET DATA TYPE numeric(10, 2);--> statement-breakpoint
ALTER TABLE "estimate_line_items" ALTER COLUMN "weight_kg_per_carton" SET DATA TYPE numeric(10, 3);--> statement-breakpoint
ALTER TABLE "product_classes" ALTER COLUMN "china_duty_rate" SET DATA TYPE numeric(10, 3);--> statement-breakpoint
ALTER TABLE "product_classes" ALTER COLUMN "cambodia_duty_rate" SET DATA TYPE numeric(10, 3);--> statement-breakpoint
ALTER TABLE "product_classes" ALTER COLUMN "taiwan_duty_rate" SET DATA TYPE numeric(10, 3);--> statement-breakpoint
ALTER TABLE "product_classes" ALTER COLUMN "thailand_duty_rate" SET DATA TYPE numeric(10, 3);--> statement-breakpoint
ALTER TABLE "product_classes" ALTER COLUMN "vietnam_duty_rate" SET DATA TYPE numeric(10, 3);--> statement-breakpoint
ALTER TABLE "product_classes" ALTER COLUMN "china_tariff_rate" SET DATA TYPE numeric(10, 3);--> statement-breakpoint
ALTER TABLE "product_classes" ALTER COLUMN "hk_tariff_rate" SET DATA TYPE numeric(10, 3);--> statement-breakpoint
ALTER TABLE "product_classes" ALTER COLUMN "taiwan_tariff_rate" SET DATA TYPE numeric(10, 3);--> statement-breakpoint
ALTER TABLE "product_classes" ALTER COLUMN "vietnam_tariff_rate" SET DATA TYPE numeric(10, 3);--> statement-breakpoint
ALTER TABLE "product_classes" ALTER COLUMN "cambodia_tariff_rate" SET DATA TYPE numeric(10, 3);--> statement-breakpoint
ALTER TABLE "product_classes" ALTER COLUMN "thailand_tariff_rate" SET DATA TYPE numeric(10, 3);--> statement-breakpoint
ALTER TABLE "sustainability_options" ADD COLUMN "netsuite_internal_id" varchar(50);--> statement-breakpoint
ALTER TABLE "sustainability_options" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "sustainability_options" ADD COLUMN "source" "source" DEFAULT 'portal' NOT NULL;--> statement-breakpoint
ALTER TABLE "sustainability_options" ADD COLUMN "sync_status" "sync_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "sustainability_options" ADD COLUMN "sync_error" text;--> statement-breakpoint
ALTER TABLE "sustainability_options" ADD COLUMN "synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sustainability_options" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "sustainability_options" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;