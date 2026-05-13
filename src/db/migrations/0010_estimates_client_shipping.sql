-- Add client incoterms and shipping method FK columns to estimates
ALTER TABLE "estimates" ADD COLUMN "client_incoterms_id" integer REFERENCES "client_incoterms"("id");--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN "client_ship_method_id" integer REFERENCES "client_shipping_methods"("id");
