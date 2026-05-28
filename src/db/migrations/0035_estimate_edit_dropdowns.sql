-- Dropdowns used on the Estimate edit/update form

CREATE TABLE IF NOT EXISTS closed_lost_reasons (
  id                   SERIAL PRIMARY KEY,
  name                 VARCHAR(255) NOT NULL,
  netsuite_internal_id VARCHAR(50),
  is_active            BOOLEAN      NOT NULL DEFAULT TRUE,
  source               VARCHAR(20)  NOT NULL DEFAULT 'portal',
  sync_status          VARCHAR(20)  NOT NULL DEFAULT 'pending',
  sync_error           TEXT,
  synced_at            TIMESTAMPTZ,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS closed_lost_reasons_ns_id_idx
  ON closed_lost_reasons (netsuite_internal_id)
  WHERE netsuite_internal_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS client_pursuit_alternatives (
  id                   SERIAL PRIMARY KEY,
  name                 VARCHAR(255) NOT NULL,
  netsuite_internal_id VARCHAR(50),
  is_active            BOOLEAN      NOT NULL DEFAULT TRUE,
  source               VARCHAR(20)  NOT NULL DEFAULT 'portal',
  sync_status          VARCHAR(20)  NOT NULL DEFAULT 'pending',
  sync_error           TEXT,
  synced_at            TIMESTAMPTZ,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS client_pursuit_alternatives_ns_id_idx
  ON client_pursuit_alternatives (netsuite_internal_id)
  WHERE netsuite_internal_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS estimate_statuses (
  id                   SERIAL PRIMARY KEY,
  name                 VARCHAR(255) NOT NULL,
  netsuite_internal_id VARCHAR(50),
  is_active            BOOLEAN      NOT NULL DEFAULT TRUE,
  source               VARCHAR(20)  NOT NULL DEFAULT 'portal',
  sync_status          VARCHAR(20)  NOT NULL DEFAULT 'pending',
  sync_error           TEXT,
  synced_at            TIMESTAMPTZ,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS estimate_statuses_ns_id_idx
  ON estimate_statuses (netsuite_internal_id)
  WHERE netsuite_internal_id IS NOT NULL;
