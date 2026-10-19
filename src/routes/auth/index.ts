import { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { eq, and, gt, sql } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { users, employees, departments, subsidiaries, currencies } from '../../db/schema/index.js';
import { UnauthorizedError, ConflictError, ValidationError } from '../../utils/errors.js';
import { sendPasswordResetEmail } from '../../services/email.service.js';
import {
  issueRefreshToken, rotateRefreshToken, revokeRefreshToken, revokeAllRefreshTokens,
} from '../../services/refreshToken.service.js';
import { env } from '../../config/env.js';
import { z } from 'zod';

const RegisterBody = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
});

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string(),
});

const ChangePasswordBody = z.object({
  currentPassword: z.string(),
  newPassword: z.string().min(8),
});

const ForgotPasswordBody = z.object({
  email: z.string().email(),
});

const ResetPasswordBody = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8),
});

// Optional: with no refreshToken, /refresh keeps its original behaviour (re-sign the
// still-valid access token), so existing callers are unaffected.
const RefreshBody = z.object({
  refreshToken: z.string().min(1).optional(),
});

const LogoutBody = z.object({
  refreshToken: z.string().min(1).optional(),
});

const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

const signUser = (app: FastifyInstance, user: { id: number; email: string | null; role: string; netsuiteInternalId: string | null; mustChangePassword: boolean }) =>
  app.jwt.sign({
    id: user.id,
    email: user.email,
    role: user.role,
    netsuiteInternalId: user.netsuiteInternalId,
    mustChangePassword: user.mustChangePassword,
  });

export default async function authRoutes(app: FastifyInstance) {
  // POST /api/v1/auth/register — no public sign-up (users arrive via NetSuite sync).
  // Kept as an admin-only tool for manual account creation.
  app.post('/register', { preHandler: [app.authenticateAdmin] }, async (req, reply) => {
    const body = RegisterBody.parse(req.body);
    const db = getDb();

    const [existing] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = lower(${body.email})`).limit(1);
    if (existing) throw new ConflictError('Email already registered');

    const passwordHash = await bcrypt.hash(body.password, 12);
    const [user] = await db
      .insert(users)
      .values({ email: body.email, passwordHash, firstName: body.firstName, lastName: body.lastName, mustChangePassword: true })
      .returning({ id: users.id, email: users.email, role: users.role, netsuiteInternalId: users.netsuiteInternalId, mustChangePassword: users.mustChangePassword });

    const token = signUser(app, user);
    return reply.status(201).send({ token, user });
  });

  // POST /api/v1/auth/login
  app.post('/login', async (req, reply) => {
    const { email, password } = LoginBody.parse(req.body);
    const db = getDb();

    const [user] = await db
      .select({
        id: users.id, email: users.email, passwordHash: users.passwordHash, role: users.role,
        isActive: users.isActive, portalUser: users.portalUser, netsuiteInternalId: users.netsuiteInternalId, mustChangePassword: users.mustChangePassword,
      })
      .from(users)
      .where(sql`lower(${users.email}) = lower(${email})`)
      .limit(1);

    if (!user) throw new UnauthorizedError('Invalid credentials');
    if (!user.isActive || !user.portalUser) throw new UnauthorizedError('User is not active.');

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) throw new UnauthorizedError('Invalid credentials');

    const now = new Date();
    await db.update(users).set({ lastLoginAt: now, lastActiveAt: now }).where(eq(users.id, user.id));

    const token = signUser(app, user);
    // Exchanged at POST /refresh for a new access token when this one expires.
    const refreshToken = await issueRefreshToken(user.id);
    return {
      token,
      refreshToken,
      user: { id: user.id, email: user.email, role: user.role, netsuiteInternalId: user.netsuiteInternalId },
      mustChangePassword: user.mustChangePassword,
    };
  });

  // GET /api/v1/auth/me
  app.get('/me', { preHandler: [app.authenticate] }, async (req) => {
    const db = getDb();
    const [user] = await db
      .select({ id: users.id, email: users.email, firstName: users.firstName, lastName: users.lastName, role: users.role, mustChangePassword: users.mustChangePassword })
      .from(users)
      .where(eq(users.id, req.user.id))
      .limit(1);
    return user;
  });

  // GET /api/v1/auth/profile — identity plus whatever NetSuite employee info is linked
  app.get('/profile', { preHandler: [app.authenticate] }, async (req) => {
    const db = getDb();
    const [user] = await db
      .select({
        id: users.id, email: users.email, firstName: users.firstName, lastName: users.lastName,
        role: users.role, netsuiteInternalId: users.netsuiteInternalId, mustChangePassword: users.mustChangePassword,
        lastLoginAt: users.lastLoginAt,
      })
      .from(users)
      .where(eq(users.id, req.user.id))
      .limit(1);

    let employee = null;
    if (user?.netsuiteInternalId) {
      const [emp] = await db
        .select({
          jobTitle: employees.jobTitle,
          departmentName: departments.name,
          subsidiaryName: subsidiaries.name,
          currencyCode: currencies.code,
          developer: employees.developer,
          salesRep: employees.salesRep,
          productDeveloper: employees.productDeveloper,
        })
        .from(employees)
        .leftJoin(departments, eq(employees.departmentId, departments.id))
        .leftJoin(subsidiaries, eq(employees.subsidiaryId, subsidiaries.id))
        .leftJoin(currencies, eq(employees.currencyId, currencies.id))
        .where(eq(employees.netsuiteInternalId, user.netsuiteInternalId))
        .limit(1);
      employee = emp ?? null;
    }

    return { ...user, employee };
  });

  // POST /api/v1/auth/change-password — the escape hatch from the forced-change gate,
  // so it only requires a valid token, not an already-changed password.
  app.post('/change-password', { preHandler: [app.authenticate] }, async (req) => {
    const { currentPassword, newPassword } = ChangePasswordBody.parse(req.body);
    const db = getDb();

    const [user] = await db.select({ id: users.id, passwordHash: users.passwordHash })
      .from(users).where(eq(users.id, req.user.id)).limit(1);
    if (!user) throw new UnauthorizedError('Invalid credentials');

    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) throw new UnauthorizedError('Current password is incorrect');

    const passwordHash = await bcrypt.hash(newPassword, 12);
    const [updated] = await db.update(users)
      .set({ passwordHash, mustChangePassword: false, passwordResetTokenHash: null, passwordResetExpiresAt: null, updatedAt: new Date() })
      .where(eq(users.id, user.id))
      .returning({ id: users.id, email: users.email, role: users.role, netsuiteInternalId: users.netsuiteInternalId, mustChangePassword: users.mustChangePassword });

    // Sign out every other session (other tabs/devices hold refresh tokens issued under the
    // old password), then hand THIS session a fresh pair so it carries on uninterrupted.
    // The new access token also reflects mustChangePassword: false.
    await revokeAllRefreshTokens(user.id);
    const token = signUser(app, updated);
    const refreshToken = await issueRefreshToken(user.id);

    return { message: 'Password changed successfully', token, refreshToken };
  });

  // POST /api/v1/auth/forgot-password — always a generic response, never reveals
  // whether the email exists.
  app.post('/forgot-password', async (req) => {
    const { email } = ForgotPasswordBody.parse(req.body);
    const db = getDb();

    const [user] = await db.select({ id: users.id, isActive: users.isActive })
      .from(users).where(sql`lower(${users.email}) = lower(${email})`).limit(1);

    if (user?.isActive) {
      const rawToken = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + env.PASSWORD_RESET_TOKEN_TTL_MINUTES * 60_000);
      await db.update(users)
        .set({ passwordResetTokenHash: hashToken(rawToken), passwordResetExpiresAt: expiresAt, updatedAt: new Date() })
        .where(eq(users.id, user.id));

      const resetUrl = `${env.FRONTEND_URL}/reset-password?token=${rawToken}`;
      await sendPasswordResetEmail(email, resetUrl);
    }

    return { message: 'If an account with that email exists, a password reset link has been sent.' };
  });

  // POST /api/v1/auth/reset-password
  app.post('/reset-password', async (req) => {
    const { token, newPassword } = ResetPasswordBody.parse(req.body);
    const db = getDb();

    const [user] = await db.select({ id: users.id })
      .from(users)
      .where(and(eq(users.passwordResetTokenHash, hashToken(token)), gt(users.passwordResetExpiresAt, new Date())))
      .limit(1);
    if (!user) throw new ValidationError('Invalid or expired reset link');

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await db.update(users)
      .set({ passwordHash, mustChangePassword: false, passwordResetTokenHash: null, passwordResetExpiresAt: null, updatedAt: new Date() })
      .where(eq(users.id, user.id));

    // A reset means the old password may be compromised — sign out every existing session.
    await revokeAllRefreshTokens(user.id);

    return { message: 'Password reset successfully' };
  });

  // POST /api/v1/auth/refresh
  //
  //   Body { refreshToken } → exchange it for a NEW access token + NEW refresh token. Works
  //     even when the access token has expired — that's the point. The old refresh token
  //     stops working (after a short grace period); the new one is valid for
  //     REFRESH_TOKEN_TTL_DAYS from now, so active users are never signed out.
  //     The user is re-checked on every refresh: a deactivated user, or one no longer an
  //     EST Portal User, is refused and all their sessions are revoked.
  //
  //   No body → ORIGINAL behaviour, unchanged: re-sign the caller's still-valid access token
  //     (used e.g. after change-password to pick up mustChangePassword: false).
  app.post('/refresh', async (req, reply) => {
    const parsed = RefreshBody.safeParse(req.body ?? {});
    const refreshToken = parsed.success ? parsed.data.refreshToken : undefined;
    const db = getDb();

    if (!refreshToken) {
      await app.authenticate(req, reply);
      const [user] = await db
        .select({ id: users.id, email: users.email, role: users.role, netsuiteInternalId: users.netsuiteInternalId, mustChangePassword: users.mustChangePassword })
        .from(users)
        .where(eq(users.id, req.user.id))
        .limit(1);
      if (!user) throw new UnauthorizedError('Invalid credentials');

      const token = signUser(app, user);
      return { token };
    }

    const rotated = await rotateRefreshToken(refreshToken);

    const [user] = await db
      .select({
        id: users.id, email: users.email, role: users.role, netsuiteInternalId: users.netsuiteInternalId,
        mustChangePassword: users.mustChangePassword, isActive: users.isActive, portalUser: users.portalUser,
      })
      .from(users)
      .where(eq(users.id, rotated.userId))
      .limit(1);

    // Same rule as login. Revoke everything so the refused user can't keep retrying.
    if (!user || !user.isActive || !user.portalUser) {
      await revokeAllRefreshTokens(rotated.userId);
      throw new UnauthorizedError('User is not active.');
    }

    await db.update(users).set({ lastActiveAt: new Date() }).where(eq(users.id, user.id));

    // Fresh claims from the database — role / mustChangePassword changes apply here.
    const token = signUser(app, user);
    return { token, refreshToken: rotated.refreshToken };
  });

  // POST /api/v1/auth/logout — revoke the session's refresh token. Needs no access token
  // (it may already have expired); the refresh token itself proves the session. Always
  // succeeds, so a repeat or an already-revoked token is harmless.
  app.post('/logout', async (req) => {
    const parsed = LogoutBody.safeParse(req.body ?? {});
    if (parsed.success && parsed.data.refreshToken) {
      await revokeRefreshToken(parsed.data.refreshToken);
    }
    return { message: 'Logged out' };
  });
}
