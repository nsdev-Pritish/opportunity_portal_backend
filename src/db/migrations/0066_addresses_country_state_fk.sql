-- Link addresses → country / state master dropdowns.
-- The existing free-text `country` / `state` columns are kept (used for display and the
-- NetSuite address sync); these FK columns add a proper relation to the master tables.
-- State depends on the selected country (states.country_id → countries.id).

ALTER TABLE addresses
  ADD COLUMN IF NOT EXISTS country_id integer;
--> statement-breakpoint

ALTER TABLE addresses
  ADD COLUMN IF NOT EXISTS state_id integer;
--> statement-breakpoint

ALTER TABLE addresses
  ADD CONSTRAINT addresses_country_id_fk
  FOREIGN KEY (country_id) REFERENCES countries(id);
--> statement-breakpoint

ALTER TABLE addresses
  ADD CONSTRAINT addresses_state_id_fk
  FOREIGN KEY (state_id) REFERENCES states(id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS addresses_country_idx ON addresses (country_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS addresses_state_idx ON addresses (state_id);
