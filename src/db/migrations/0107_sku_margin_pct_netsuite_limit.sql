-- Match estimate_line_items.sku_margin_pct to NetSuite's limit: 11 digits before the decimal.
--
-- 0106 widened the column to numeric(20,3) (17 digits) so extreme margins could save. But the
-- margin field in NetSuite only takes 11 digits before the decimal, so a 12–17 digit value
-- would save in the portal and then fail when synced to NetSuite. numeric(14,3) caps it at
-- 99,999,999,999.999, the same as NetSuite. Anything larger is now rejected before saving with
-- a message naming the field and line (src/utils/columnLimits.ts reads this precision).
--
-- Still far above real margins: the case that prompted 0106 (−37,476,344.4%) is 8 digits.
--
-- Scale stays 3. Dropping to NetSuite's 2 decimals would round every existing value — a real
-- data change — so the extra decimal stays here and NetSuite rounds on its side.
--
-- SAFETY: no value is modified. Unlike widening, NARROWING makes Postgres check every row, so
-- the table is rewritten and estimate_line_items is locked for a few seconds — run at a quiet
-- time. If any stored value exceeds 11 digits the statement fails and changes nothing; check
-- first with:
--   SELECT id, sku_margin_pct FROM estimate_line_items
--   WHERE abs(sku_margin_pct) >= 99999999999.9995;

ALTER TABLE estimate_line_items
  ALTER COLUMN sku_margin_pct TYPE numeric(14, 3);
