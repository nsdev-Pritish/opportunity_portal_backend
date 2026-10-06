-- Link each converted line item to the quote it was converted into.
--
-- Until now the portal only stored `converted` (a bare boolean) on estimate_line_items, so
-- nothing recorded WHICH quote a line landed on. An estimate can hold several active quotes
-- (each convert only quotes the lines still converted = false), which made two things
-- impossible:
--   1. Showing what a given quote actually contains.
--   2. Deleting a quote and putting its lines back into play — without this column there is
--      no way to know which lines to reset to converted = false.
--
-- SAFETY: this migration only ADDS a column and fills it in. It never modifies `converted`,
-- never touches estimate_quotes, and never deletes anything. Existing data is preserved.
--
-- ON DELETE SET NULL is deliberate: deleting a quote must never delete estimate lines.
-- The application-level delete flow un-converts the lines first (converted = false,
-- estimate_quote_id = NULL); this clause is only the database-level safety net for a row
-- removed out-of-band.

ALTER TABLE estimate_line_items
  ADD COLUMN IF NOT EXISTS estimate_quote_id integer;
--> statement-breakpoint
ALTER TABLE estimate_line_items
  ADD CONSTRAINT estimate_line_items_estimate_quote_id_fkey
  FOREIGN KEY (estimate_quote_id) REFERENCES estimate_quotes(id) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS eli_quote_idx ON estimate_line_items (estimate_quote_id);
--> statement-breakpoint
-- Backfill.
-- Only estimates that have exactly ONE quote can be attributed with certainty: every
-- converted line on such an estimate must belong to that single quote.
--
-- Estimates with two or more quotes are intentionally LEFT NULL. The information needed to
-- split their existing converted lines between quotes was never recorded, so any guess would
-- be wrong data presented as fact. Those rows simply report "unknown quote" until they are
-- re-converted; nothing else in the system depends on this column.
UPDATE estimate_line_items li
SET    estimate_quote_id = sole.quote_id
FROM (
  SELECT estimate_id, MIN(id) AS quote_id
  FROM   estimate_quotes
  GROUP  BY estimate_id
  HAVING COUNT(*) = 1
) AS sole
WHERE li.estimate_id       = sole.estimate_id
  AND li.converted         = true
  AND li.estimate_quote_id IS NULL;
