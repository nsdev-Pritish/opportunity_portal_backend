-- Creative Requests — the Estimate's "Creative Requests" tab.
--
-- Four independent toggles (Deck·Product, Setup·Product, Deck·Packaging, Setup·Packaging).
-- Every toggle that is ON produces exactly one creative_request header row plus exactly one
-- detail row (creative_request_deck or creative_request_setup). A toggle that is OFF
-- produces no rows at all.
--
-- Tables created here, in dependency order:
--   creative_request        — header, one row per ACTIVE toggle
--   creative_request_deck   — detail, 1:1 with a 'deck' header
--   creative_request_setup  — detail, 1:1 with a 'setup' header
--
-- NOT created here: per-request selection/attachment tables. Selected assets, selected
-- scope of work and file attachments are accepted by the API but not persisted — the
-- existing `creative_request_assets` / `creative_request_scope_work` tables (migration
-- 0084) are MASTER LISTS of dropdown options and carry no request_id, so they cannot hold
-- a per-request selection. Add link tables later if that data needs to be stored.
--
-- TYPE NOTE: the spec proposed BIGSERIAL / BIGINT, but estimates.id is `serial` (integer)
-- in this schema, so the FK is integer and the PKs are serial to match.
-- See src/db/schema/index.ts (estimates ~L696).

-- ── Header ─────────────────────────────────────────────────────────
-- sync_status here is a varchar + CHECK, NOT the existing `sync_status` pgEnum (which is
-- 'pending','synced','dirty','failed','skipped' and has no 'draft' value). The two are
-- deliberately independent — a creative request has its own lifecycle.
CREATE TABLE IF NOT EXISTS creative_request (
  id                   serial PRIMARY KEY,
  estimate_id          integer NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
  request_type         varchar(10) NOT NULL CHECK (request_type IN ('deck','setup')),
  category             varchar(12) NOT NULL CHECK (category IN ('product','packaging')),

  -- Requestor is captured PER REQUEST. Deck and Setup each carry their own value and must
  -- never share one. Stored as plain values, NOT resolved against the requestors master:
  -- Wrike integration is columns-only for now, with no lookup logic behind it.
  requestor_wrike_id   varchar(50) NOT NULL,
  requestor_name       varchar(120) NOT NULL,

  due_date             date NOT NULL,

  -- Plain column, no FK to users(id): there is no user management in the portal yet, so
  -- nothing guarantees a matching users row. Nullable, and populated only if the caller
  -- explicitly sends it. Add the FK when user management lands.
  submitted_by_user_id integer,
  submitted_at         timestamptz NOT NULL DEFAULT now(),

  netsuite_record_id   varchar(50),
  -- Wrike columns are created here but NOTHING writes to them yet — the Wrike push is a
  -- separate, later feature. Columns only, no logic.
  wrike_task_id        varchar(50),
  wrike_permalink      text,

  sync_status          varchar(20) NOT NULL DEFAULT 'draft'
                         CHECK (sync_status IN ('draft','pending','synced','failed')),
  last_sync_attempt_at timestamptz,
  last_sync_error      text,

  -- Set true once a request is synced/locked. A locked row is NEVER overwritten by a
  -- subsequent estimate save; it is reported back as skipped_locked instead.
  is_locked            boolean NOT NULL DEFAULT false,

  idempotency_key      varchar(64) UNIQUE,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  -- One active request per toggle per estimate. This is what makes
  -- "update if it exists, insert if it doesn't" resolvable without ambiguity.
  CONSTRAINT creative_request_estimate_toggle_uniq UNIQUE (estimate_id, request_type, category)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_creative_request_estimate ON creative_request (estimate_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_creative_request_sync_status ON creative_request (sync_status);
--> statement-breakpoint

-- ── Detail: Deck ───────────────────────────────────────────────────
-- request_id is both PK and FK, which structurally enforces the 1:1 relationship.
CREATE TABLE IF NOT EXISTS creative_request_deck (
  request_id           integer PRIMARY KEY REFERENCES creative_request(id) ON DELETE CASCADE,
  item_budget          text NOT NULL,
  scope                text,
  intent               text,
  meeting_detail       text,
  is_first_time_client varchar(3) NOT NULL CHECK (is_first_time_client IN ('Yes','No')),
  include_about_us     varchar(3) CHECK (include_about_us IN ('Yes','No')),
  formatting_pref      text,
  dropbox_link         text
);
--> statement-breakpoint

-- ── Detail: Setup ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS creative_request_setup (
  request_id          integer PRIMARY KEY REFERENCES creative_request(id) ON DELETE CASCADE,
  number_of_setups    integer NOT NULL CHECK (number_of_setups >= 1),
  design_tracker_link text,
  where_to_save_link  text,
  notes               text,
  dropbox_link        text
);
