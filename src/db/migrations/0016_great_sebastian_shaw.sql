ALTER TABLE "project_names" DROP CONSTRAINT IF EXISTS "project_names_subsidiary_id_subsidiaries_id_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "project_names_subsidiary_idx";--> statement-breakpoint
ALTER TABLE "customers" ALTER COLUMN "chargeback_royalties" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "customers" ALTER COLUMN "chargeback_royalties" SET DATA TYPE numeric USING (chargeback_royalties::int::numeric);--> statement-breakpoint
ALTER TABLE "project_names" DROP COLUMN "subsidiary_id";