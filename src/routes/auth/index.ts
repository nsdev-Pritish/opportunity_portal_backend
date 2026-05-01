import { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { users } from '../../db/schema/index.js';
import { UnauthorizedError, ConflictError } from '../../utils/errors.js';
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

export default async function authRoutes(app: FastifyInstance) {
  // POST /api/v1/auth/register
  app.post('/register', async (req, reply) => {
    const body = RegisterBody.parse(req.body);
    const db = getDb();

    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, body.email)).limit(1);
    if (existing) throw new ConflictError('Email already registered');

    const passwordHash = await bcrypt.hash(body.password, 12);
    const [user] = await db
      .insert(users)
      .values({ email: body.email, passwordHash, firstName: body.firstName, lastName: body.lastName })
      .returning({ id: users.id, email: users.email, role: users.role });

    const token = app.jwt.sign({ id: user.id, email: user.email, role: user.role });
    return reply.status(201).send({ token, user });
  });

  // POST /api/v1/auth/login
  app.post('/login', async (req, reply) => {
    const { email, password } = LoginBody.parse(req.body);
    const db = getDb();

    const [user] = await db
      .select({ id: users.id, email: users.email, passwordHash: users.passwordHash, role: users.role, isActive: users.isActive })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (!user || !user.isActive) throw new UnauthorizedError('Invalid credentials');

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) throw new UnauthorizedError('Invalid credentials');

    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));

    const token = app.jwt.sign({ id: user.id, email: user.email, role: user.role });
    return { token, user: { id: user.id, email: user.email, role: user.role } };
  });

  // GET /api/v1/auth/me
  app.get('/me', { preHandler: [app.authenticate] }, async (req) => {
    const db = getDb();
    const [user] = await db
      .select({ id: users.id, email: users.email, firstName: users.firstName, lastName: users.lastName, role: users.role })
      .from(users)
      .where(eq(users.id, req.user.id))
      .limit(1);
    return user;
  });

  // POST /api/v1/auth/refresh
  app.post('/refresh', { preHandler: [app.authenticate] }, async (req) => {
    const token = app.jwt.sign({ id: req.user.id, email: req.user.email, role: req.user.role });
    return { token };
  });
}
