-- Divisional Budget master list (NetSuite list), mirrors the other classification
-- dropdowns (departments / business_types / business_verticals).
-- Same shape as those tables: id + name + syncCols.
-- `is_active` is the active/inactive flag driven by the /activate and /inactivate APIs.

CREATE TABLE IF NOT EXISTS divisional_budgets (
  id                   serial PRIMARY KEY,
  name                 varchar(255) NOT NULL,
  netsuite_internal_id varchar(50),
  is_active            boolean NOT NULL DEFAULT true,
  source               source NOT NULL DEFAULT 'portal',
  sync_status          sync_status NOT NULL DEFAULT 'pending',
  sync_error           text,
  synced_at            timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS divisional_budgets_ns_id_idx ON divisional_budgets (netsuite_internal_id);
