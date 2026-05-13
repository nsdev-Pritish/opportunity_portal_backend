/**
 * CLIENT SHIPPING METHOD APIs
 * Dedicated table: client_shipping_methods (id, name, ...syncCols)
 *
 *  GET   /api/v1/netsuite/client-shipping-methods
 *  GET   /api/v1/netsuite/client-shipping-methods/:nsId
 *  POST  /api/v1/netsuite/client-shipping-methods
 *  PUT   /api/v1/netsuite/client-shipping-methods/:nsId
 *  PUT   /api/v1/netsuite/client-shipping-methods/:nsId/status
 *
 * POST/PUT body:
 *  { "netsuiteInternalId": "5", "name": "Ocean FCL" }
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../config/database.js';
import { clientShippingMethods } from '../../../db/schema/index.js';
import { NotFoundError } from '../../../utils/errors.js';
import { invalidateDropdown } from '../../../utils/cache.js';

const CreateSchema = z.object({
  netsuiteInternalId : z.string().min(1),
  name               : z.string().min(1).max(255),
});

const UpdateSchema = CreateSchema.omit({ netsuiteInternalId: true }).partial();
const StatusSchema = z.object({ isActive: z.boolean() });

export default async function clientShippingMethodRoutes(app: FastifyInstance) {

  app.get('/', async () =>
    getDb().select().from(clientShippingMethods).where(eq(clientShippingMethods.isActive, true)).orderBy(clientShippingMethods.name),
  );

  app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
    const [row] = await getDb().select().from(clientShippingMethods)
      .where(eq(clientShippingMethods.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!row) throw new NotFoundError('ClientShippingMethod', req.params.nsId);
    return row;
  });

  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: clientShippingMethods.id }).from(clientShippingMethods)
      .where(eq(clientShippingMethods.netsuiteInternalId, body.netsuiteInternalId)).limit(1);
    if (existing) {
      const [upd] = await db.update(clientShippingMethods)
        .set({ name: body.name, updatedAt: new Date() })
        .where(eq(clientShippingMethods.id, existing.id)).returning();
      await invalidateDropdown('client_shipping_methods');
      return reply.status(200).send({ ...upd, _action: 'updated' });
    }
    const [created] = await db.insert(clientShippingMethods)
      .values({ ...body, source: 'netsuite', syncStatus: 'synced', syncedAt: new Date() }).returning();
    await invalidateDropdown('client_shipping_methods');
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: clientShippingMethods.id }).from(clientShippingMethods)
      .where(eq(clientShippingMethods.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('ClientShippingMethod', req.params.nsId);
    const [updated] = await db.update(clientShippingMethods)
      .set({ ...body, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(clientShippingMethods.id, existing.id)).returning();
    await invalidateDropdown('client_shipping_methods');
    return updated;
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
    const { isActive } = StatusSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: clientShippingMethods.id }).from(clientShippingMethods)
      .where(eq(clientShippingMethods.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('ClientShippingMethod', req.params.nsId);
    const [updated] = await db.update(clientShippingMethods)
      .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(clientShippingMethods.id, existing.id))
      .returning({ id: clientShippingMethods.id, netsuiteInternalId: clientShippingMethods.netsuiteInternalId, isActive: clientShippingMethods.isActive });
    await invalidateDropdown('client_shipping_methods');
    return updated;
  });
}
