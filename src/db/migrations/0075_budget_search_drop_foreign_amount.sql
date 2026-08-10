-- Cleanup: 0074_search_tables_foreign_amount.sql originally added
-- foreign_amount to budget_search too, before that was reverted — Budget has
-- no native-currency concept per the workbook, so it never gets this column.
-- If 0074 already ran against this database with the old version, this
-- removes what it added. Safe/idempotent if it was never added at all.

ALTER TABLE "budget_search" DROP COLUMN IF EXISTS "foreign_amount";
