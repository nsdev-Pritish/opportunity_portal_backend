ALTER TABLE "project_types" DROP CONSTRAINT "project_types_project_name_id_project_names_id_fk";
--> statement-breakpoint
DROP INDEX "project_types_project_name_idx";--> statement-breakpoint
ALTER TABLE "project_names" ADD COLUMN "project_type_id" integer;--> statement-breakpoint
ALTER TABLE "project_names" ADD CONSTRAINT "project_names_project_type_id_project_types_id_fk" FOREIGN KEY ("project_type_id") REFERENCES "public"."project_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_names_project_type_idx" ON "project_names" USING btree ("project_type_id");--> statement-breakpoint
ALTER TABLE "project_types" DROP COLUMN "project_name_id";