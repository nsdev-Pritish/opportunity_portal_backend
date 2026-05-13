/**
 * CLIENT INCOTERMS APIs
 * Dedicated table: client_incoterms (id, name, ...syncCols)
 *
 *  GET   /api/v1/netsuite/client-incoterms
 *  GET   /api/v1/netsuite/client-incoterms/:nsId
 *  POST  /api/v1/netsuite/client-incoterms
 *  PUT   /api/v1/netsuite/client-incoterms/:nsId
 *  PUT   /api/v1/netsuite/client-incoterms/:nsId/status
 *
 * POST/PUT body:
 *  { "netsuiteInternalId": "1", "name": "Ex Works" }
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../config/database.js';
import { clientIncoterms } from '../../../db/schema/index.js';
import { NotFoundError } from '../../../utils/errors.js';
import { invalidateDropdown } from '../../../utils/cache.js';

const CreateSchema = z.object({
  netsuiteInternalId : z.string().min(1),
  name               : z.string().min(1).max(255),
});

const UpdateSchema = CreateSchema.omit({ netsuiteInternalId: true }).partial();
const StatusSchema = z.object({ isActive: z.boolean() });

export default async function clientIncotermRoutes(app: FastifyInstance) {

  app.get('/', async () =>
    getDb().select().from(clientIncoterms).where(eq(clientIncoterms.isActive, true)).orderBy(clientIncoterms.name),
  );

  app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
    const [row] = await getDb().select().from(clientIncoterms)
      .where(eq(clientIncoterms.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!row) throw new NotFoundError('ClientIncoterm', req.params.nsId);
    return row;
  });

  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: clientIncoterms.id }).from(clientIncoterms)
      .where(eq(clientIncoterms.netsuiteInternalId, body.netsuiteInternalId)).limit(1);
    if (existing) {
      const [upd] = await db.update(clientIncoterms)
        .set({ name: body.name, updatedAt: new Date() })
        .where(eq(clientIncoterms.id, existing.id)).returning();
      await invalidateDropdown('client_incoterms');
      return reply.status(200).send({ ...upd, _action: 'updated' });
    }
    const [created] = await db.insert(clientIncoterms)
      .values({ ...body, source: 'netsuite', syncStatus: 'synced', syncedAt: new Date() }).returning();
    await invalidateDropdown('client_incoterms');
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: clientIncoterms.id }).from(clientIncoterms)
      .where(eq(clientIncoterms.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('ClientIncoterm', req.params.nsId);
    const [updated] = await db.update(clientIncoterms)
      .set({ ...body, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(clientIncoterms.id, existing.id)).returning();
    await invalidateDropdown('client_incoterms');
    return updated;
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
    const { isActive } = StatusSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: clientIncoterms.id }).from(clientIncoterms)
      .where(eq(clientIncoterms.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('ClientIncoterm', req.params.nsId);
    const [updated] = await db.update(clientIncoterms)
      .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(clientIncoterms.id, existing.id))
      .returning({ id: clientIncoterms.id, netsuiteInternalId: clientIncoterms.netsuiteInternalId, isActive: clientIncoterms.isActive });
    await invalidateDropdown('client_incoterms');
    return updated;
  });
}
