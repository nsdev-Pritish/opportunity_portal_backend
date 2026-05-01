/**
 * EMPLOYEE APIs
 * Used for: Acct Manager and Product Developer dropdowns.
 *
 *  GET   /api/v1/netsuite/employees
 *  GET   /api/v1/netsuite/employees/:nsId
 *  POST  /api/v1/netsuite/employees
 *  PUT   /api/v1/netsuite/employees/:nsId
 *  PATCH /api/v1/netsuite/employees/:nsId/status
 *
 * Body for POST/PUT:
 *  {
 *    "netsuiteInternalId": "5678",
 *    "firstName": "Jane",
 *    "lastName": "Smith",
 *    "email": "jane@company.com",
 *    "roles": ["acct_manager", "product_developer"]
 *  }
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../config/database.js';
import { employees } from '../../db/schema/index.js';
import { NotFoundError } from '../../utils/errors.js';
import { invalidateDropdown } from '../../utils/cache.js';

const CreateSchema = z.object({
  netsuiteInternalId : z.string().min(1),
  firstName          : z.string().min(1).max(100),
  lastName           : z.string().min(1).max(100),
  email              : z.string().email().optional().nullable(),
  roles              : z.array(z.string()).optional().default([]),
});

const UpdateSchema = CreateSchema.omit({ netsuiteInternalId: true }).partial();
const StatusSchema = z.object({ isActive: z.boolean() });

export default async function employeeRoutes(app: FastifyInstance) {

  app.get('/', async () =>
    getDb().select().from(employees).where(eq(employees.isActive, true)).orderBy(employees.lastName),
  );

  app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
    const [row] = await getDb().select().from(employees)
      .where(eq(employees.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!row) throw new NotFoundError('Employee', req.params.nsId);
    return row;
  });

  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: employees.id }).from(employees)
      .where(eq(employees.netsuiteInternalId, body.netsuiteInternalId)).limit(1);
    if (existing) {
      const [upd] = await db.update(employees)
        .set({ firstName: body.firstName, lastName: body.lastName, email: body.email, roles: body.roles, updatedAt: new Date() })
        .where(eq(employees.id, existing.id)).returning();
      await invalidateDropdown('employees');
      return reply.status(200).send({ ...upd, _action: 'updated' });
    }
    const [created] = await db.insert(employees)
      .values({ ...body, source: 'netsuite', syncStatus: 'synced', syncedAt: new Date() }).returning();
    await invalidateDropdown('employees');
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: employees.id }).from(employees)
      .where(eq(employees.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('Employee', req.params.nsId);
    const [updated] = await db.update(employees)
      .set({ ...body, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(employees.id, existing.id)).returning();
    await invalidateDropdown('employees');
    return updated;
  });

  app.patch<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
    const { isActive } = StatusSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: employees.id }).from(employees)
      .where(eq(employees.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('Employee', req.params.nsId);
    const [updated] = await db.update(employees)
      .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(employees.id, existing.id))
      .returning({ id: employees.id, netsuiteInternalId: employees.netsuiteInternalId, isActive: employees.isActive });
    await invalidateDropdown('employees');
    return updated;
  });
}
