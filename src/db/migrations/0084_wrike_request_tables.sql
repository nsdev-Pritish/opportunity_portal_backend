-- Wrike request master lists (NetSuite custom lists / records).
-- Mirrors the definitions in src/db/schema/index.ts (id + name + syncCols).
-- `is_active` is the active/inactive flag driven by the /activate and /inactivate APIs.
-- `requestors` additionally carries the Wrike user id used when pushing requests to Wrike.

-- ── Creative Request Type ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS creative_request_types (
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
CREATE UNIQUE INDEX IF NOT EXISTS creative_request_types_ns_id_idx ON creative_request_types (netsuite_internal_id);
--> statement-breakpoint

-- ── Creative Request Category ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS creative_request_categories (
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
CREATE UNIQUE INDEX IF NOT EXISTS creative_request_categories_ns_id_idx ON creative_request_categories (netsuite_internal_id);
--> statement-breakpoint

-- ── New Client ─────────────────────────────────────────────────────
-- Yes/No list — `name` holds the label ('Yes' / 'No').
CREATE TABLE IF NOT EXISTS new_clients (
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
CREATE UNIQUE INDEX IF NOT EXISTS new_clients_ns_id_idx ON new_clients (netsuite_internal_id);
--> statement-breakpoint

-- ── Creative Request Assets ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS creative_request_assets (
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
CREATE UNIQUE INDEX IF NOT EXISTS creative_request_assets_ns_id_idx ON creative_request_assets (netsuite_internal_id);
--> statement-breakpoint

-- ── Creative Request Scope of Work ─────────────────────────────────
CREATE TABLE IF NOT EXISTS creative_request_scope_work (
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
CREATE UNIQUE INDEX IF NOT EXISTS creative_request_scope_work_ns_id_idx ON creative_request_scope_work (netsuite_internal_id);
--> statement-breakpoint

-- ── About Us Info ──────────────────────────────────────────────────
-- Yes/No list — `name` holds the label ('Yes' / 'No').
CREATE TABLE IF NOT EXISTS about_us_info (
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
CREATE UNIQUE INDEX IF NOT EXISTS about_us_info_ns_id_idx ON about_us_info (netsuite_internal_id);
--> statement-breakpoint

-- ── Requestor ──────────────────────────────────────────────────────
-- Same list shape plus wrike_id (the Wrike user/contact id for this requestor).
CREATE TABLE IF NOT EXISTS requestors (
  id                   serial PRIMARY KEY,
  name                 varchar(255) NOT NULL,
  wrike_id             varchar(100),
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
CREATE UNIQUE INDEX IF NOT EXISTS requestors_ns_id_idx ON requestors (netsuite_internal_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS requestors_wrike_id_idx ON requestors (wrike_id);