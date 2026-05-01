CREATE TABLE "project_names" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"netsuite_internal_id" varchar(50),
	"is_active" boolean DEFAULT true NOT NULL,
	"source" "source" DEFAULT 'portal' NOT NULL,
	"sync_status" "sync_status" DEFAULT 'pending' NOT NULL,
	"sync_error" text,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_types" ADD COLUMN "project_name_id" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "project_names_ns_id_idx" ON "project_names" USING btree ("netsuite_internal_id");--> statement-breakpoint
ALTER TABLE "project_types" ADD CONSTRAINT "project_types_project_name_id_project_names_id_fk" FOREIGN KEY ("project_name_id") REFERENCES "public"."project_names"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_types_ns_id_idx" ON "project_types" USING btree ("netsuite_internal_id");--> statement-breakpoint
CREATE INDEX "project_types_project_name_idx" ON "project_types" USING btree ("project_name_id");