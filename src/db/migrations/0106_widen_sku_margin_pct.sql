-- Widen estimate_line_items.sku_margin_pct so extreme margins can be saved.
--
-- numeric(10,3) holds at most ±9,999,999.999. Margin % = (sell − cost) ÷ sell × 100, so a
-- tiny sell price against a large cost explodes it: €0.01 sell against a $3,333 cost gives
-- about −37,476,344%. That overflowed the column ("numeric field overflow"), which failed the
-- WHOLE estimate save — every line is written in one transaction — and also failed the
-- NetSuite → portal sync of that estimate, so the line existed in NetSuite but not here.
--
-- numeric(20,3) allows 17 digits before the decimal point, beyond anything the sell-price and
-- cost columns can produce. Same scale, so no stored value changes.
--
-- SAFETY: widening a numeric's precision (same scale) is a metadata-only change on
-- Postgres 9.2+ — no table rewrite, no data change. No views depend on this column.

ALTER TABLE estimate_line_items
  ALTER COLUMN sku_margin_pct TYPE numeric(20, 3);
