-- Creative Request per-request child tables — BACKFILL MIGRATION.
--
-- These three tables already exist in the deployed database, but no migration ever created
-- them: they were applied by hand as raw SQL. src/db/schema/index.ts has referenced them
-- since 0087 and src/services/creativeRequest.service.ts writes to all three on every
-- estimate save, so a fresh environment running `npm run db:migrate` would crash with
-- "relation does not exist" on the first save that has a creative-request toggle ON.
--
-- This file closes that gap. Every statement is IF NOT EXISTS, so it is a NO-OP against
-- the current deployed database and only does real work on a fresh one. The DDL below was
-- read back out of the live database (information_schema + pg_constraint + pg_indexes)
-- rather than written from the spec, so the two can never disagree.
--
-- Tables created here:
--   creative_request_asset            — per-request selected assets
--   creative_request_scope_work_item  — per-request selected scope of work
--   creative_request_attachment       — per-request file attachments
--
-- NAMING TRAP: creative_request_assets and creative_request_scope_work (plural / no
-- _item suffix, both from migration 0084) are the MASTER DROPDOWN LISTS. The tables here
-- are the per-request SELECTIONS and are the singular / _item-suffixed names. They are
-- different tables and the FKs below point from the selection to the master.
--
-- SHAPE: hybrid id + snapshot. Each selection row carries a NULLABLE FK to the master row
-- plus a NOT NULL text copy of the label. The snapshot means a request keeps its original
-- wording if the master row is renamed later, and a free-text entry matching no master row
-- is still storable with a null id.
--
-- TYPE NOTE: integer, not bigint. The spec proposed BIGINT/BIGSERIAL but creative_request.id
-- is `serial` (integer), so these match it. Same decision as 0087.

-- ── Per-request selected assets ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS creative_request_asset (
  id          serial PRIMARY KEY,
  request_id  integer NOT NULL REFERENCES creative_request(id) ON DELETE CASCADE,
  asset_id    integer REFERENCES creative_request_assets(id),
  asset_value text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_creative_request_asset_request
  ON creative_request_asset (request_id);
--> statement-breakpoint

-- ── Per-request selected scope of work ──────────────────────────────
CREATE TABLE IF NOT EXISTS creative_request_scope_work_item (
  id            serial PRIMARY KEY,
  request_id    integer NOT NULL REFERENCES creative_request(id) ON DELETE CASCADE,
  scope_work_id integer REFERENCES creative_request_scope_work(id),
  scope_value   text NOT NULL
);
--> statement-breakpoint
-- Index name is idx_creative_request_scope_request, NOT ..._scope_work_item_request —
-- kept verbatim from the live database so this migration stays a true no-op there.
CREATE INDEX IF NOT EXISTS idx_creative_request_scope_request
  ON creative_request_scope_work_item (request_id);
--> statement-breakpoint

-- ── Per-request attachments ─────────────────────────────────────────
-- Append-only during a normal estimate save. addNewAttachments() inserts one row per file
-- sent and never deletes, because a file may already have been pushed to Wrike or the
-- NetSuite File Cabinet. Removal is a separate explicit feature.
--
-- No uniqueness on (request_id, file_name, file_size_bytes) ON PURPOSE: two genuinely
-- different files can share a name and a length, so the same name+size may appear twice
-- against one request.
--
-- Deliberately looser than the spec, matching the live database:
--   file_name        varchar(500), not 255 — the deployed column is 500 and shrinking a
--                    column with live rows in it is not something a backfill should do.
--   file_size_bytes  NULLABLE — the spec says NOT NULL, but the service accepts an
--                    attachment whose payload carries no size and stores null rather than
--                    failing the whole toggle.
--   storage_uri      NULLABLE — same reason: metadata can arrive before the upload lands.
--   netsuite_file_id varchar(50), not BIGINT — every other NetSuite id in this schema is
--                    stored as a string.t
-- The 10 MB per-file cap from the spec is NOT enforced here. A CHECK constraint cannot be
-- added safely while file_size_bytes is nullable and unvalidated rows already exist; the
-- cap belongs in the upload path.
CREATE TABLE IF NOT EXISTS creative_request_attachment (
  id                  serial PRIMARY KEY,
  request_id          integer NOT NULL REFERENCES creative_request(id) ON DELETE CASCADE,
  file_name           varchar(500) NOT NULL,
  file_size_bytes     bigint,
  storage_uri         text,
  netsuite_file_id    varchar(50),
  wrike_attachment_id varchar(50),
  uploaded_at         timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_creative_request_attachment_request
  ON creative_request_attachment (request_id);
