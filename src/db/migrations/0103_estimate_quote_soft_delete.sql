-- Soft-delete flag for quotes deleted in NetSuite.
--
-- Quotes are deleted in NETSUITE, not in the portal, and NetSuite deletes them for good.
-- The portal must keep the row (quote number, NetSuite id, dates stay available for audit
-- and reconciliation) while treating the quote as gone: it disappears from the picker, can
-- no longer receive line items, and its line items go back to converted = false so they can
-- be quoted again.
--
-- WHY is_active AND NOT the existing `status` COLUMN:
-- `status` is overwritten from NetSuite's payload on every sync (see syncAllQuotesFromNetsuite),
-- so a portal-owned meaning stored there could be silently wiped. `is_active` is written only
-- by the portal and nothing in the inbound sync touches it. It also matches how every other
-- table in this schema soft-deletes (estimates, estimate_line_items, the master tables).
--
-- SAFETY: both columns are additive. Every existing row defaults to is_active = true, i.e.
-- exactly today's behaviour. No existing data is modified.

ALTER TABLE estimate_quotes
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE estimate_quotes
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS eq_estimate_active_idx ON estimate_quotes (estimate_id, is_active);
