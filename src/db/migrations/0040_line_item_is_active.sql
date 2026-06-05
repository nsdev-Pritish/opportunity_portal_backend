-- Soft-delete support for estimate line items.
-- is_active = TRUE  → live line item (shown / synced)
-- is_active = FALSE → "deleted" line item (hidden from reads; row + netsuite_internal_id retained
--                      so a future NetSuite call can deactivate the line: { internalId, isActive: false })

ALTER TABLE estimate_line_items
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
