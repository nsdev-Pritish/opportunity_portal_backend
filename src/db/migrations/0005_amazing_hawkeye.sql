ALTER TABLE "project_names" DROP CONSTRAINT "project_names_project_type_id_project_types_id_fk";
--> statement-breakpoint
ALTER TABLE "project_types" ADD COLUMN "project_name_id" integer;--> statement-breakpoint
ALTER TABLE "project_types" ADD CONSTRAINT "project_types_project_name_id_project_names_id_fk" FOREIGN KEY ("project_name_id") REFERENCES "public"."project_names"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_types_project_name_idx" ON "project_types" USING btree ("project_name_id");--> statement-breakpoint
ALTER TABLE "project_names" DROP COLUMN "project_type_id";