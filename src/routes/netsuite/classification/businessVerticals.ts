/**
 * BUSINESS VERTICAL APIs
 *
 *  GET   /api/v1/netsuite/business-verticals
 *  GET   /api/v1/netsuite/business-verticals/:nsId
 *  POST  /api/v1/netsuite/business-verticals
 *  PUT   /api/v1/netsuite/business-verticals/:nsId
 *  PUT   /api/v1/netsuite/business-verticals/:nsId/status
 *
 * Body for POST/PUT:
 *  { "netsuiteInternalId": "20", "name": "Retail" }
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../config/database.js';
import { businessVerticals } from '../../../db/schema/index.js';
import { NotFoundError } from '../../../utils/errors.js';
import { invalidateDropdown } from '../../../utils/cache.js';

const CreateSchema = z.object({
  netsuiteInternalId: z.string().min(1),
  name: z.string().min(1).max(255),
});

const UpdateSchema = CreateSchema.omit({ netsuiteInternalId: true }).partial();
const StatusSchema = z.object({ isActive: z.boolean() });

export default async function businessVerticalRoutes(app: FastifyInstance) {

  app.get('/', async () =>
    getDb().select().from(businessVerticals).where(eq(businessVerticals.isActive, true)).orderBy(businessVerticals.name),
  );

  app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
    const [row] = await getDb().select().from(businessVerticals)
      .where(eq(businessVerticals.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!row) throw new NotFoundError('BusinessVertical', req.params.nsId);
    return row;
  });

  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: businessVerticals.id }).from(businessVerticals)
      .where(eq(businessVerticals.netsuiteInternalId, body.netsuiteInternalId)).limit(1);
    if (existing) {
      const [upd] = await db.update(businessVerticals)
        .set({ name: body.name, updatedAt: new Date() })
        .where(eq(businessVerticals.id, existing.id)).returning();
      await invalidateDropdown('business_verticals');
      return reply.status(200).send({ ...upd, _action: 'updated' });
    }
    const [created] = await db.insert(businessVerticals)
      .values({ ...body, source: 'netsuite', syncStatus: 'synced', syncedAt: new Date() }).returning();
    await invalidateDropdown('business_verticals');
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: businessVerticals.id }).from(businessVerticals)
      .where(eq(businessVerticals.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('BusinessVertical', req.params.nsId);
    const [updated] = await db.update(businessVerticals)
      .set({ ...body, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(businessVerticals.id, existing.id)).returning();
    await invalidateDropdown('business_verticals');
    return updated;
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
    const { isActive } = StatusSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: businessVerticals.id }).from(businessVerticals)
      .where(eq(businessVerticals.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('BusinessVertical', req.params.nsId);
    const [updated] = await db.update(businessVerticals)
      .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(businessVerticals.id, existing.id))
      .returning({ id: businessVerticals.id, netsuiteInternalId: businessVerticals.netsuiteInternalId, isActive: businessVerticals.isActive });
    await invalidateDropdown('business_verticals');
    return updated;
  });
}
