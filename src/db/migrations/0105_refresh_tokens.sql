-- Refresh tokens: keep a user signed in while they're active, without a long-lived access token.
--
-- Access tokens (JWT) stay short-lived and are never stored. A refresh token is a random
-- opaque value handed to the client at login; only its SHA-256 hash is stored here, so a
-- database read alone can't be used to impersonate anyone.
--
-- Rolling: every successful refresh REVOKES the presented token and issues a new one valid
-- for REFRESH_TOKEN_TTL_DAYS (default 7) from that moment. A user is therefore only signed
-- out after that much INACTIVITY, never mid-work.
--
-- replaced_by_id links a rotated token to its successor. It drives two behaviours in
-- services/refreshToken.service.ts:
--   · a short grace period (REFRESH_TOKEN_GRACE_SECONDS, default 30) in which a just-rotated
--     token is still accepted — two tabs refreshing at once, or a retry after a dropped
--     response, must not log the user out;
--   · reuse detection — a rotated token presented AFTER the grace period may have been
--     stolen, so every refresh token for that user is revoked.
--
-- last_active_at records the last refresh (i.e. last real use), alongside last_login_at,
-- which keeps meaning "actually signed in".
--
-- SAFETY: purely additive — a new table and a nullable column. Nothing existing changes.

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id             serial PRIMARY KEY,
  user_id        integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash     varchar(64) NOT NULL,
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  replaced_by_id integer,
  created_at     timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS rt_token_hash_idx ON refresh_tokens (token_hash);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS rt_user_idx ON refresh_tokens (user_id);
--> statement-breakpoint
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at timestamptz;
