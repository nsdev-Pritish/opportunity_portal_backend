/**
 * ESTIMATE STATUS APIs
 *
 *  GET   /api/v1/netsuite/estimate-statuses
 *  GET   /api/v1/netsuite/estimate-statuses/:nsId
 *  POST  /api/v1/netsuite/estimate-statuses
 *  PUT   /api/v1/netsuite/estimate-statuses/:nsId
 *  PATCH /api/v1/netsuite/estimate-statuses/:nsId/status
 *
 * Body for POST/PUT:
 *  { "netsuiteInternalId": "1", "name": "In Progress" }
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../config/database.js';
import { estimateStatuses } from '../../db/schema/index.js';
import { NotFoundError } from '../../utils/errors.js';
import { invalidateDropdown } from '../../utils/cache.js';

const CreateSchema = z.object({
  netsuiteInternalId: z.string().min(1),
  name              : z.string().min(1).max(255),
});

const UpdateSchema = CreateSchema.omit({ netsuiteInternalId: true }).partial();
const StatusSchema = z.object({ isActive: z.boolean() });

export default async function estimateStatusRoutes(app: FastifyInstance) {

  app.get('/', async () =>
    getDb().select().from(estimateStatuses).where(eq(estimateStatuses.isActive, true)).orderBy(estimateStatuses.name),
  );

  app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
    const [row] = await getDb().select().from(estimateStatuses)
      .where(eq(estimateStatuses.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!row) throw new NotFoundError('EstimateStatus', req.params.nsId);
    return row;
  });

  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: estimateStatuses.id }).from(estimateStatuses)
      .where(eq(estimateStatuses.netsuiteInternalId, body.netsuiteInternalId)).limit(1);
    if (existing) {
      const [upd] = await db.update(estimateStatuses)
        .set({ name: body.name, updatedAt: new Date() })
        .where(eq(estimateStatuses.id, existing.id)).returning();
      await invalidateDropdown('estimate_statuses');
      return reply.status(200).send({ ...upd, _action: 'updated' });
    }
    const [created] = await db.insert(estimateStatuses)
      .values({ ...body, source: 'netsuite', syncStatus: 'synced', syncedAt: new Date() }).returning();
    await invalidateDropdown('estimate_statuses');
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: estimateStatuses.id }).from(estimateStatuses)
      .where(eq(estimateStatuses.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('EstimateStatus', req.params.nsId);
    const [updated] = await db.update(estimateStatuses)
      .set({ ...body, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(estimateStatuses.id, existing.id)).returning();
    await invalidateDropdown('estimate_statuses');
    return updated;
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
    const { isActive } = StatusSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: estimateStatuses.id }).from(estimateStatuses)
      .where(eq(estimateStatuses.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('EstimateStatus', req.params.nsId);
    const [updated] = await db.update(estimateStatuses)
      .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(estimateStatuses.id, existing.id))
      .returning({ id: estimateStatuses.id, netsuiteInternalId: estimateStatuses.netsuiteInternalId, isActive: estimateStatuses.isActive });
    await invalidateDropdown('estimate_statuses');
    return updated;
  });
}
