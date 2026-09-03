import { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { eq, and, gt } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { users, employees, departments, subsidiaries, currencies } from '../../db/schema/index.js';
import { UnauthorizedError, ConflictError, ValidationError } from '../../utils/errors.js';
import { sendPasswordResetEmail } from '../../services/email.service.js';
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

    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, body.email)).limit(1);
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
        isActive: users.isActive, netsuiteInternalId: users.netsuiteInternalId, mustChangePassword: users.mustChangePassword,
      })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (!user || !user.isActive) throw new UnauthorizedError('Invalid credentials');

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) throw new UnauthorizedError('Invalid credentials');

    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));

    const token = signUser(app, user);
    return {
      token,
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
    await db.update(users)
      .set({ passwordHash, mustChangePassword: false, passwordResetTokenHash: null, passwordResetExpiresAt: null, updatedAt: new Date() })
      .where(eq(users.id, user.id));

    return { message: 'Password changed successfully' };
  });

  // POST /api/v1/auth/forgot-password — always a generic response, never reveals
  // whether the email exists.
  app.post('/forgot-password', async (req) => {
    const { email } = ForgotPasswordBody.parse(req.body);
    const db = getDb();

    const [user] = await db.select({ id: users.id, isActive: users.isActive })
      .from(users).where(eq(users.email, email)).limit(1);

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

    return { message: 'Password reset successfully' };
  });

  // POST /api/v1/auth/refresh
  app.post('/refresh', { preHandler: [app.authenticate] }, async (req) => {
    const db = getDb();
    const [user] = await db
      .select({ id: users.id, email: users.email, role: users.role, netsuiteInternalId: users.netsuiteInternalId, mustChangePassword: users.mustChangePassword })
      .from(users)
      .where(eq(users.id, req.user.id))
      .limit(1);
    if (!user) throw new UnauthorizedError('Invalid credentials');

    const token = signUser(app, user);
    return { token };
  });
}
