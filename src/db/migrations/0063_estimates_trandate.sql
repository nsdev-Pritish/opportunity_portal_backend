-- Add transaction date (trandate) to estimates.
-- Inbound (NetSuite → Portal): NetSuite sends the value under the `trandate` key
--   and it is stored here as-is (YYYY-MM-DD).
-- Outbound (Portal → NetSuite): the estimate's created_at is sent as the trandate,
--   so this column is not read on the outbound path.
-- Stored as `date` (like expected_close_date / promise_date) so it flows through
-- formatNsDate → MM/DD/YYYY.

ALTER TABLE estimates
  ADD COLUMN IF NOT EXISTS trandate date;
