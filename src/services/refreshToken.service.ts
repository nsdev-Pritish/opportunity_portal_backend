/**
 * Refresh tokens — keep a user signed in while they're active.
 *
 * Access tokens (JWT) are short-lived and never stored. A refresh token is a random opaque
 * value; only its SHA-256 hash is persisted (refresh_tokens), so a database read alone can't
 * be used to sign in as anyone.
 *
 * ROLLING: rotateRefreshToken revokes the presented token and issues a new one valid for
 * REFRESH_TOKEN_TTL_DAYS from now. A user is only signed out after that much inactivity.
 *
 * GRACE PERIOD: a just-rotated token is still accepted for REFRESH_TOKEN_GRACE_SECONDS.
 * Two tabs refreshing at the same moment, or a retry after the first response was lost,
 * would otherwise present an already-rotated token and sign the user out.
 *
 * REUSE DETECTION: a rotated token presented AFTER the grace period may have been stolen,
 * so every refresh token for that user is revoked (signed out everywhere).
 */
import crypto from 'crypto';
import { eq, and, isNull } from 'drizzle-orm';
import { getDb } from '../config/database.js';
import { refreshTokens } from '../db/schema/index.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { UnauthorizedError } from '../utils/errors.js';

const hash = (raw: string) => crypto.createHash('sha256').update(raw).digest('hex');

function newExpiry(from: Date): Date {
  return new Date(from.getTime() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}

/** Issue a brand-new refresh token for a user (login, password change). Returns the raw value. */
export async function issueRefreshToken(userId: number): Promise<string> {
  const raw = crypto.randomBytes(48).toString('hex');
  await getDb().insert(refreshTokens).values({
    userId,
    tokenHash: hash(raw),
    expiresAt: newExpiry(new Date()),
  });
  return raw;
}

type RotateOutcome =
  | { ok: true;  userId: number; refreshToken: string }
  | { ok: false; reuseDetectedForUser: number | null };

/**
 * Exchange a refresh token for a new one. Throws UnauthorizedError when the token is
 * unknown, expired, revoked, or reused after the grace period.
 *
 * The row is locked (FOR UPDATE) so two concurrent refreshes of the same token run one
 * after the other: the second then sees it already rotated and takes the grace path.
 */
export async function rotateRefreshToken(raw: string): Promise<{ userId: number; refreshToken: string }> {
  const db  = getDb();
  const now = new Date();

  const outcome: RotateOutcome = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hash(raw)))
      .for('update')
      .limit(1);

    if (!row) return { ok: false, reuseDetectedForUser: null };

    if (row.revokedAt) {
      const rotated = row.replacedById !== null;
      const inGrace = rotated
        && now.getTime() - row.revokedAt.getTime() <= env.REFRESH_TOKEN_GRACE_SECONDS * 1000;
      if (!inGrace) {
        // Rotated and reused after the grace period → possible theft. A token revoked for
        // any other reason (logout, password change) is simply rejected.
        return { ok: false, reuseDetectedForUser: rotated ? row.userId : null };
      }
      // Within the grace period: fall through and issue another token. The old one stays
      // revoked and its first successor stays valid — each tab keeps its own token.
    } else if (row.expiresAt <= now) {
      return { ok: false, reuseDetectedForUser: null };
    }

    const nextRaw = crypto.randomBytes(48).toString('hex');
    const [next] = await tx.insert(refreshTokens)
      .values({ userId: row.userId, tokenHash: hash(nextRaw), expiresAt: newExpiry(now) })
      .returning({ id: refreshTokens.id });

    if (!row.revokedAt) {
      await tx.update(refreshTokens)
        .set({ revokedAt: now, replacedById: next.id })
        .where(eq(refreshTokens.id, row.id));
    }

    return { ok: true, userId: row.userId, refreshToken: nextRaw };
  });

  if (!outcome.ok) {
    // Revoke-all runs AFTER the transaction — inside it, the throw would roll it back.
    if (outcome.reuseDetectedForUser !== null) {
      logger.warn({ userId: outcome.reuseDetectedForUser },
        'Refresh token reused after rotation — revoking all sessions for this user');
      await revokeAllRefreshTokens(outcome.reuseDetectedForUser);
    }
    throw new UnauthorizedError('Session expired — please log in again');
  }

  return { userId: outcome.userId, refreshToken: outcome.refreshToken };
}

/** Revoke one refresh token (logout). Silent when the token is unknown or already revoked. */
export async function revokeRefreshToken(raw: string): Promise<void> {
  await getDb().update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.tokenHash, hash(raw)), isNull(refreshTokens.revokedAt)));
}

/** Revoke every refresh token for a user — password change/reset, deactivation, theft. */
export async function revokeAllRefreshTokens(userId: number): Promise<void> {
  await getDb().update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
}
