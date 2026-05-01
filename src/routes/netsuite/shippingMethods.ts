/**
 * SHIPPING METHOD APIs
 *
 *  GET   /api/v1/netsuite/shipping-methods
 *  GET   /api/v1/netsuite/shipping-methods/:nsId
 *  POST  /api/v1/netsuite/shipping-methods
 *  PUT   /api/v1/netsuite/shipping-methods/:nsId
 *  PATCH /api/v1/netsuite/shipping-methods/:nsId/status
 *
 * Body for POST/PUT:
 *  { "netsuiteInternalId": "5", "name": "Ocean FCL", "carrier": "Maersk", "transitDays": 30 }
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../config/database.js';
import { shippingMethods } from '../../db/schema/index.js';
import { NotFoundError } from '../../utils/errors.js';
import { invalidateDropdown } from '../../utils/cache.js';

const CreateSchema = z.object({
  netsuiteInternalId : z.string().min(1),
  name               : z.string().min(1).max(255),
  carrier            : z.string().max(100).optional().nullable(),
  transitDays        : z.number().int().optional().nullable(),
});

const UpdateSchema = CreateSchema.omit({ netsuiteInternalId: true }).partial();
const StatusSchema = z.object({ isActive: z.boolean() });

export default async function shippingMethodRoutes(app: FastifyInstance) {

  app.get('/', async () =>
    getDb().select().from(shippingMethods).where(eq(shippingMethods.isActive, true)).orderBy(shippingMethods.name),
  );

  app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
    const [row] = await getDb().select().from(shippingMethods)
      .where(eq(shippingMethods.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!row) throw new NotFoundError('ShippingMethod', req.params.nsId);
    return row;
  });

  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: shippingMethods.id }).from(shippingMethods)
      .where(eq(shippingMethods.netsuiteInternalId, body.netsuiteInternalId)).limit(1);
    if (existing) {
      const [upd] = await db.update(shippingMethods)
        .set({ name: body.name, carrier: body.carrier, transitDays: body.transitDays, updatedAt: new Date() })
        .where(eq(shippingMethods.id, existing.id)).returning();
      await invalidateDropdown('shipping_methods');
      return reply.status(200).send({ ...upd, _action: 'updated' });
    }
    const [created] = await db.insert(shippingMethods)
      .values({ ...body, source: 'netsuite', syncStatus: 'synced', syncedAt: new Date() }).returning();
    await invalidateDropdown('shipping_methods');
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: shippingMethods.id }).from(shippingMethods)
      .where(eq(shippingMethods.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('ShippingMethod', req.params.nsId);
    const [updated] = await db.update(shippingMethods)
      .set({ ...body, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(shippingMethods.id, existing.id)).returning();
    await invalidateDropdown('shipping_methods');
    return updated;
  });

  app.patch<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
    const { isActive } = StatusSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: shippingMethods.id }).from(shippingMethods)
      .where(eq(shippingMethods.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('ShippingMethod', req.params.nsId);
    const [updated] = await db.update(shippingMethods)
      .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(shippingMethods.id, existing.id))
      .returning({ id: shippingMethods.id, netsuiteInternalId: shippingMethods.netsuiteInternalId, isActive: shippingMethods.isActive });
    await invalidateDropdown('shipping_methods');
    return updated;
  });
}
