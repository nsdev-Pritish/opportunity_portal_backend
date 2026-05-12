/**
 * SALES CHANNEL APIs
 *
 *  GET   /api/v1/netsuite/sales-channels
 *  GET   /api/v1/netsuite/sales-channels/:nsId
 *  POST  /api/v1/netsuite/sales-channels
 *  PUT   /api/v1/netsuite/sales-channels/:nsId
 *  PATCH /api/v1/netsuite/sales-channels/:nsId/status
 *
 * Body for POST/PUT:
 *  { "netsuiteInternalId": "10", "name": "Direct" }
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../config/database.js';
import { salesChannels } from '../../../db/schema/index.js';
import { NotFoundError } from '../../../utils/errors.js';
import { invalidateDropdown } from '../../../utils/cache.js';

const CreateSchema = z.object({
  netsuiteInternalId: z.string().min(1),
  name: z.string().min(1).max(255),
});

const UpdateSchema = CreateSchema.omit({ netsuiteInternalId: true }).partial();
const StatusSchema = z.object({ isActive: z.boolean() });

export default async function salesChannelRoutes(app: FastifyInstance) {

  app.get('/', async () =>
    getDb().select().from(salesChannels).where(eq(salesChannels.isActive, true)).orderBy(salesChannels.name),
  );

  app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
    const [row] = await getDb().select().from(salesChannels)
      .where(eq(salesChannels.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!row) throw new NotFoundError('SalesChannel', req.params.nsId);
    return row;
  });

  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: salesChannels.id }).from(salesChannels)
      .where(eq(salesChannels.netsuiteInternalId, body.netsuiteInternalId)).limit(1);
    if (existing) {
      const [upd] = await db.update(salesChannels)
        .set({ name: body.name, updatedAt: new Date() })
        .where(eq(salesChannels.id, existing.id)).returning();
      await invalidateDropdown('sales_channels');
      return reply.status(200).send({ ...upd, _action: 'updated' });
    }
    const [created] = await db.insert(salesChannels)
      .values({ ...body, source: 'netsuite', syncStatus: 'synced', syncedAt: new Date() }).returning();
    await invalidateDropdown('sales_channels');
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: salesChannels.id }).from(salesChannels)
      .where(eq(salesChannels.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('SalesChannel', req.params.nsId);
    const [updated] = await db.update(salesChannels)
      .set({ ...body, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(salesChannels.id, existing.id)).returning();
    await invalidateDropdown('sales_channels');
    return updated;
  });

  app.patch<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
    const { isActive } = StatusSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: salesChannels.id }).from(salesChannels)
      .where(eq(salesChannels.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('SalesChannel', req.params.nsId);
    const [updated] = await db.update(salesChannels)
      .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(salesChannels.id, existing.id))
      .returning({ id: salesChannels.id, netsuiteInternalId: salesChannels.netsuiteInternalId, isActive: salesChannels.isActive });
    await invalidateDropdown('sales_channels');
    return updated;
  });
}
