-- customer_name: display-text fallback for Customer on credit_memo_search,
-- carried alongside the resolved customer_id FK. NetSuite's updated script now
-- sends both customerInternalId (resolved to customer_id) and customerName
-- (this column) — kept so the customer is still readable even when
-- customerInternalId matches no row in customers (not synced yet / mismatch).
ALTER TABLE "credit_memo_search" ADD COLUMN IF NOT EXISTS "customer_name" varchar(200);
