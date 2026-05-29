-- Add edit-form fields to estimates table

ALTER TABLE estimates
  ADD COLUMN IF NOT EXISTS status_id                    INTEGER REFERENCES estimate_statuses(id),
  ADD COLUMN IF NOT EXISTS closed_lost_reason_id        INTEGER REFERENCES closed_lost_reasons(id),
  ADD COLUMN IF NOT EXISTS client_pursuit_alternative_id INTEGER REFERENCES client_pursuit_alternatives(id),
  ADD COLUMN IF NOT EXISTS project_hold_date            DATE,
  ADD COLUMN IF NOT EXISTS notes_closed_lost_reason     TEXT;
