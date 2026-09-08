/**
 * ORDER CLASSIFICATION APIs
 *
 *  GET   /api/v1/netsuite/order-classifications                 → list active records
 *  GET   /api/v1/netsuite/order-classifications/:nsId           → get one by NetSuite internal id
 *  POST  /api/v1/netsuite/order-classifications                 → create (upsert on netsuiteInternalId)
 *  PUT   /api/v1/netsuite/order-classifications/:nsId           → update name / isActive
 *  PUT   /api/v1/netsuite/order-classifications/:nsId/activate     → is_active = true
 *  PUT   /api/v1/netsuite/order-classifications/:nsId/inactivate   → is_active = false
 *  PUT   /api/v1/netsuite/order-classifications/:nsId/status       → is_active from body
 *
 * Body for POST:   { "netsuiteInternalId": "101", "name": "Domestic" }
 * Body for PUT :   { "name": "Domestic", "isActive": true }
 * Body for status: { "isActive": false }
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../config/database.js';
import { orderClassifications } from '../../../db/schema/index.js';
import { NotFoundError } from '../../../utils/errors.js';
import { invalidateDropdown } from '../../../utils/cache.js';

const CACHE_KEY = 'order_classifications';
const LABEL     = 'OrderClassification';

const CreateSchema = z.object({
  netsuiteInternalId: z.string().min(1),
  name              : z.string().min(1).max(255),
  isActive          : z.boolean().optional(),   // defaults to true when omitted
});

const UpdateSchema = CreateSchema.omit({ netsuiteInternalId: true }).partial();
const StatusSchema = z.object({ isActive: z.boolean() });

// Look the row up by NetSuite internal id — every write path starts here.
async function findByNsId(nsId: string) {
  const [row] = await getDb().select({ id: orderClassifications.id }).from(orderClassifications)
    .where(eq(orderClassifications.netsuiteInternalId, nsId)).limit(1);
  if (!row) throw new NotFoundError(LABEL, nsId);
  return row;
}

async function setActive(nsId: string, isActive: boolean) {
  const existing = await findByNsId(nsId);
  const [updated] = await getDb().update(orderClassifications)
    .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
    .where(eq(orderClassifications.id, existing.id))
    .returning({
      id: orderClassifications.id,
      netsuiteInternalId: orderClassifications.netsuiteInternalId,
      isActive: orderClassifications.isActive,
    });
  await invalidateDropdown(CACHE_KEY);
  return updated;
}

export default async function orderClassificationRoutes(app: FastifyInstance) {

  // LIST — active only
  app.get('/', async () =>
    getDb().select().from(orderClassifications)
      .where(eq(orderClassifications.isActive, true)).orderBy(orderClassifications.name),
  );

  // GET ONE
  app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
    const [row] = await getDb().select().from(orderClassifications)
      .where(eq(orderClassifications.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!row) throw new NotFoundError(LABEL, req.params.nsId);
    return row;
  });

  // CREATE — upsert on netsuiteInternalId so NetSuite can replay safely
  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const { netsuiteInternalId, ...body } = CreateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: orderClassifications.id }).from(orderClassifications)
      .where(eq(orderClassifications.netsuiteInternalId, netsuiteInternalId)).limit(1);

    if (existing) {
      const [upd] = await db.update(orderClassifications)
        .set({ ...body, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
        .where(eq(orderClassifications.id, existing.id)).returning();
      await invalidateDropdown(CACHE_KEY);
      return reply.status(200).send({ ...upd, _action: 'updated' });
    }

    const [created] = await db.insert(orderClassifications)
      .values({ netsuiteInternalId, ...body, source: 'netsuite', syncStatus: 'synced', syncedAt: new Date() })
      .returning();
    await invalidateDropdown(CACHE_KEY);
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  // UPDATE
  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateSchema.parse(req.body);
    const existing = await findByNsId(req.params.nsId);
    const [updated] = await getDb().update(orderClassifications)
      .set({ ...body, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(orderClassifications.id, existing.id)).returning();
    await invalidateDropdown(CACHE_KEY);
    return updated;
  });

  // ACTIVATE / INACTIVATE
  app.put<{ Params: { nsId: string } }>('/:nsId/activate', async (req) =>
    setActive(req.params.nsId, true),
  );

  app.put<{ Params: { nsId: string } }>('/:nsId/inactivate', async (req) =>
    setActive(req.params.nsId, false),
  );

  // STATUS — same thing driven by the body, for callers that send a flag
  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
    const { isActive } = StatusSchema.parse(req.body);
    return setActive(req.params.nsId, isActive);
  });
}
