-- FOB Target Price on line items (and components), synced both ways with NetSuite line field
-- custcoltwelve_fob_target_price. double precision (float), as specified by the client.
--
-- SAFETY: additive only. Existing lines read as NULL (no target price).

ALTER TABLE estimate_line_items
  ADD COLUMN IF NOT EXISTS fob_target_price double precision;
