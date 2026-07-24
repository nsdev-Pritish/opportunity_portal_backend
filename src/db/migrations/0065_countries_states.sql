-- Country + State master dropdown tables.
-- Mirrors the `countries` and `states` definitions in src/db/schema/index.ts.
-- Both follow the standard dropdown shape (id + name + syncCols).
--   countries: name + optional ISO code.
--   states:    name + optional code + country_id FK (country → many states).
-- `is_active` is the active/inactive flag driven by the /status APIs.

CREATE TABLE IF NOT EXISTS countries (
  id                   serial PRIMARY KEY,
  name                 varchar(255) NOT NULL,
  code                 varchar(10),                  -- ISO country code, e.g. "US"
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

CREATE UNIQUE INDEX IF NOT EXISTS countries_ns_id_idx ON countries (netsuite_internal_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS states (
  id                   serial PRIMARY KEY,
  name                 varchar(255) NOT NULL,
  code                 varchar(20),                  -- state / province code, e.g. "CA"
  country_id           integer,
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

ALTER TABLE states
  ADD CONSTRAINT states_country_id_fk
  FOREIGN KEY (country_id) REFERENCES countries(id);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS states_ns_id_idx ON states (netsuite_internal_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS states_country_idx ON states (country_id);
