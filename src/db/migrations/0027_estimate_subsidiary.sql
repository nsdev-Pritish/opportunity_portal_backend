-- Migration: add subsidiary_id to estimates

ALTER TABLE estimates
  ADD COLUMN IF NOT EXISTS subsidiary_id INTEGER REFERENCES subsidiaries(id);

CREATE INDEX IF NOT EXISTS estimates_subsidiary_idx ON estimates(subsidiary_id);
