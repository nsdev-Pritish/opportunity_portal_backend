-- Make line-number uniqueness apply only to ACTIVE line items.
-- Soft-deleted rows (is_active = false) retain their old line_number, but must not
-- block a re-inserted active row from reusing that number during a full-estimate update.

DROP INDEX IF EXISTS eli_line_number_idx;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS eli_line_number_idx
  ON estimate_line_items (estimate_id, line_number)
  WHERE is_active = true;
