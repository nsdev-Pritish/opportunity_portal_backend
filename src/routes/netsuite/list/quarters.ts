/**
 * QUARTER LIST APIs
 *
 *  GET   /api/v1/netsuite/list/quarters
 *  GET   /api/v1/netsuite/list/quarters/:nsId
 *  POST  /api/v1/netsuite/list/quarters
 *  PUT   /api/v1/netsuite/list/quarters/:nsId
 *  PUT   /api/v1/netsuite/list/quarters/:nsId/status   (activate / deactivate)
 *
 * Body for POST/PUT:
 *  { "netsuiteInternalId": "1", "name": "Q1 FY25" }
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../config/database.js';
import { quarters } from '../../../db/schema/index.js';
import { NotFoundError } from '../../../utils/errors.js';
import { invalidateDropdown } from '../../../utils/cache.js';

const CreateSchema = z.object({
  netsuiteInternalId: z.string().min(1),
  name              : z.string().min(1).max(255),
});

const UpdateSchema = CreateSchema.omit({ netsuiteInternalId: true }).partial();
const StatusSchema = z.object({ isActive: z.boolean() });

export default async function quarterRoutes(app: FastifyInstance) {

  app.get('/', async () =>
    getDb().select().from(quarters).where(eq(quarters.isActive, true)).orderBy(quarters.name),
  );

  app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
    const [row] = await getDb().select().from(quarters)
      .where(eq(quarters.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!row) throw new NotFoundError('Quarter', req.params.nsId);
    return row;
  });

  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: quarters.id }).from(quarters)
      .where(eq(quarters.netsuiteInternalId, body.netsuiteInternalId)).limit(1);
    if (existing) {
      const [upd] = await db.update(quarters)
        .set({ name: body.name, updatedAt: new Date() })
        .where(eq(quarters.id, existing.id)).returning();
      await invalidateDropdown('quarters');
      return reply.status(200).send({ ...upd, _action: 'updated' });
    }
    const [created] = await db.insert(quarters)
      .values({ ...body, source: 'netsuite', syncStatus: 'synced', syncedAt: new Date() }).returning();
    await invalidateDropdown('quarters');
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: quarters.id }).from(quarters)
      .where(eq(quarters.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('Quarter', req.params.nsId);
    const [updated] = await db.update(quarters)
      .set({ ...body, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(quarters.id, existing.id)).returning();
    await invalidateDropdown('quarters');
    return updated;
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
    const { isActive } = StatusSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: quarters.id }).from(quarters)
      .where(eq(quarters.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('Quarter', req.params.nsId);
    const [updated] = await db.update(quarters)
      .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(quarters.id, existing.id))
      .returning({ id: quarters.id, netsuiteInternalId: quarters.netsuiteInternalId, isActive: quarters.isActive });
    await invalidateDropdown('quarters');
    return updated;
  });
}
