-- creative_request_attachment.mime_type
--
-- Callers send the browser-reported MIME type alongside every file — the legacy RESTlet
-- payload carries it as `type` on each attachWrike entry, and the multipart path gets it
-- from part.mimetype. Until now it had nowhere to land and was discarded: R2 keeps it as
-- object metadata, but that is not queryable from Postgres, so "show me every PDF brief"
-- or picking a per-file icon in the UI meant re-fetching every object from R2.
--
-- Nullable with no default. Older rows genuinely have no known type and guessing one from
-- the file extension would be inventing data; a null says "not recorded" honestly.
--
-- varchar(255): a MIME type plus parameters is short, but the value is client-supplied and
-- must not be able to fail an INSERT for length. It is stored as received, NOT validated
-- against a whitelist — this column is descriptive metadata, not an access-control decision.
ALTER TABLE creative_request_attachment
  ADD COLUMN IF NOT EXISTS mime_type varchar(255);
