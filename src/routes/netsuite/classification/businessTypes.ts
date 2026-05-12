/**
 * BUSINESS TYPE APIs
 *
 *  GET   /api/v1/netsuite/business-types
 *  GET   /api/v1/netsuite/business-types/:nsId
 *  POST  /api/v1/netsuite/business-types
 *  PUT   /api/v1/netsuite/business-types/:nsId
 *  PATCH /api/v1/netsuite/business-types/:nsId/status
 *
 * Body for POST/PUT:
 *  { "netsuiteInternalId": "30", "name": "B2B" }
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../config/database.js';
import { businessTypes } from '../../../db/schema/index.js';
import { NotFoundError } from '../../../utils/errors.js';
import { invalidateDropdown } from '../../../utils/cache.js';

const CreateSchema = z.object({
  netsuiteInternalId: z.string().min(1),
  name: z.string().min(1).max(255),
});

const UpdateSchema = CreateSchema.omit({ netsuiteInternalId: true }).partial();
const StatusSchema = z.object({ isActive: z.boolean() });

export default async function businessTypeRoutes(app: FastifyInstance) {

  app.get('/', async () =>
    getDb().select().from(businessTypes).where(eq(businessTypes.isActive, true)).orderBy(businessTypes.name),
  );

  app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
    const [row] = await getDb().select().from(businessTypes)
      .where(eq(businessTypes.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!row) throw new NotFoundError('BusinessType', req.params.nsId);
    return row;
  });

  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: businessTypes.id }).from(businessTypes)
      .where(eq(businessTypes.netsuiteInternalId, body.netsuiteInternalId)).limit(1);
    if (existing) {
      const [upd] = await db.update(businessTypes)
        .set({ name: body.name, updatedAt: new Date() })
        .where(eq(businessTypes.id, existing.id)).returning();
      await invalidateDropdown('business_types');
      return reply.status(200).send({ ...upd, _action: 'updated' });
    }
    const [created] = await db.insert(businessTypes)
      .values({ ...body, source: 'netsuite', syncStatus: 'synced', syncedAt: new Date() }).returning();
    await invalidateDropdown('business_types');
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: businessTypes.id }).from(businessTypes)
      .where(eq(businessTypes.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('BusinessType', req.params.nsId);
    const [updated] = await db.update(businessTypes)
      .set({ ...body, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(businessTypes.id, existing.id)).returning();
    await invalidateDropdown('business_types');
    return updated;
  });

  app.patch<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
    const { isActive } = StatusSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: businessTypes.id }).from(businessTypes)
      .where(eq(businessTypes.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('BusinessType', req.params.nsId);
    const [updated] = await db.update(businessTypes)
      .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(businessTypes.id, existing.id))
      .returning({ id: businessTypes.id, netsuiteInternalId: businessTypes.netsuiteInternalId, isActive: businessTypes.isActive });
    await invalidateDropdown('business_types');
    return updated;
  });
}
