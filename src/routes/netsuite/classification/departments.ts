/**
 * DEPARTMENT APIs
 *
 *  GET   /api/v1/netsuite/departments
 *  GET   /api/v1/netsuite/departments/:nsId
 *  POST  /api/v1/netsuite/departments
 *  PUT   /api/v1/netsuite/departments/:nsId
 *  PUT   /api/v1/netsuite/departments/:nsId/status
 *
 * Body for POST/PUT:
 *  { "netsuiteInternalId": "91", "name": "Sales" }
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../config/database.js';
import { departments } from '../../../db/schema/index.js';
import { NotFoundError } from '../../../utils/errors.js';
import { invalidateDropdown } from '../../../utils/cache.js';

const CreateSchema = z.object({
  netsuiteInternalId: z.string().min(1),
  name: z.string().min(1).max(255),
});

const UpdateSchema = CreateSchema.omit({ netsuiteInternalId: true }).partial();
const StatusSchema = z.object({ isActive: z.boolean() });

export default async function departmentRoutes(app: FastifyInstance) {

  app.get('/', async () =>
    getDb().select().from(departments).where(eq(departments.isActive, true)).orderBy(departments.name),
  );

  app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
    const [row] = await getDb().select().from(departments)
      .where(eq(departments.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!row) throw new NotFoundError('Department', req.params.nsId);
    return row;
  });

  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: departments.id }).from(departments)
      .where(eq(departments.netsuiteInternalId, body.netsuiteInternalId)).limit(1);
    if (existing) {
      const [upd] = await db.update(departments)
        .set({ name: body.name, updatedAt: new Date() })
        .where(eq(departments.id, existing.id)).returning();
      await invalidateDropdown('departments');
      return reply.status(200).send({ ...upd, _action: 'updated' });
    }
    const [created] = await db.insert(departments)
      .values({ ...body, source: 'netsuite', syncStatus: 'synced', syncedAt: new Date() }).returning();
    await invalidateDropdown('departments');
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: departments.id }).from(departments)
      .where(eq(departments.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('Department', req.params.nsId);
    const [updated] = await db.update(departments)
      .set({ ...body, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(departments.id, existing.id)).returning();
    await invalidateDropdown('departments');
    return updated;
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
    const { isActive } = StatusSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: departments.id }).from(departments)
      .where(eq(departments.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('Department', req.params.nsId);
    const [updated] = await db.update(departments)
      .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(departments.id, existing.id))
      .returning({ id: departments.id, netsuiteInternalId: departments.netsuiteInternalId, isActive: departments.isActive });
    await invalidateDropdown('departments');
    return updated;
  });
}
