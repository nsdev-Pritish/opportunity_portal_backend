-- Drayage master dropdown table.
-- Mirrors the `drayage` definition in src/db/schema/index.ts (id + name + address/port/total + syncCols).
-- Synced from NetSuite custom record `customrecord_fcldrayage`.
--   name    → Name
--   netsuite_internal_id → recordid (NetSuite ID)
--   is_active → inverse of NetSuite `isinactive`
-- Also links estimate_freight_groups → drayage (freight group → one drayage).

CREATE TABLE IF NOT EXISTS drayage (
  id                   serial PRIMARY KEY,
  name                 varchar(255) NOT NULL,
  city                 varchar(255),                 -- custrecord_fcldrayage_city
  state                varchar(255),                 -- custrecord_fcldrayage_state
  zip_code             varchar(20),                  -- custrecord_fcldrayage_zipcode
  port                 varchar(255),                 -- custrecord_fcldrayage_port
  total                numeric(15, 4),               -- custrecord_fcldrayage_total
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

CREATE UNIQUE INDEX IF NOT EXISTS drayage_ns_id_idx ON drayage (netsuite_internal_id);
--> statement-breakpoint

-- Link estimate_freight_groups → drayage.
ALTER TABLE estimate_freight_groups
  ADD COLUMN IF NOT EXISTS drayage_id INTEGER;
--> statement-breakpoint

ALTER TABLE estimate_freight_groups
  ADD CONSTRAINT estimate_freight_groups_drayage_id_fk
  FOREIGN KEY (drayage_id) REFERENCES drayage(id) ON DELETE SET NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS efg_drayage_idx ON estimate_freight_groups (drayage_id);
