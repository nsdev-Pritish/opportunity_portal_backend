-- Link estimates → es_status.
--   es_status_id → resolved local es_status.id (what the UI binds to)

ALTER TABLE estimates
  ADD COLUMN IF NOT EXISTS es_status_id INTEGER;
--> statement-breakpoint

ALTER TABLE estimates
  ADD CONSTRAINT estimates_es_status_id_fk
  FOREIGN KEY (es_status_id) REFERENCES es_status(id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS estimates_es_status_idx ON estimates (es_status_id);
