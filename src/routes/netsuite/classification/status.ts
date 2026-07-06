/**
 * STATUS APIs
 *
 *  GET   /api/v1/netsuite/statuses                → list active statuses
 *  GET   /api/v1/netsuite/statuses/:nsId          → get one by NetSuite internal id
 *  POST  /api/v1/netsuite/statuses                → create (upsert on netsuiteInternalId)
 *  PUT   /api/v1/netsuite/statuses/:nsId          → update name
 *  PUT   /api/v1/netsuite/statuses/:nsId/activate    → set is_active = true
 *  PUT   /api/v1/netsuite/statuses/:nsId/inactivate  → set is_active = false
 *
 * Body for POST:  { "netsuiteInternalId": "123", "name": "Open" }
 * Body for PUT :  { "name": "Closed" }
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../config/database.js';
import { esStatus as status } from '../../../db/schema/index.js';
import { NotFoundError } from '../../../utils/errors.js';
import { invalidateDropdown } from '../../../utils/cache.js';

const CreateSchema = z.object({
  netsuiteInternalId: z.string().min(1),
  name: z.string().min(1).max(255),
  isActive: z.boolean().optional(),   // optional; defaults to true if omitted
});

const UpdateSchema = CreateSchema.omit({ netsuiteInternalId: true }).partial();

export default async function statusRoutes(app: FastifyInstance) {

  // LIST — active only
  app.get('/', async () =>
    getDb().select().from(status).where(eq(status.isActive, true)).orderBy(status.name),
  );

  // GET ONE
  app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
    const [row] = await getDb().select().from(status)
      .where(eq(status.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!row) throw new NotFoundError('Status', req.params.nsId);
    return row;
  });

  // CREATE (upsert on netsuiteInternalId)
  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: status.id }).from(status)
      .where(eq(status.netsuiteInternalId, body.netsuiteInternalId)).limit(1);
    if (existing) {
      const [upd] = await db.update(status)
        .set({ name: body.name, isActive: body.isActive, updatedAt: new Date() })
        .where(eq(status.id, existing.id)).returning();
      await invalidateDropdown('es_status');
      return reply.status(200).send({ ...upd, _action: 'updated' });
    }
    const [created] = await db.insert(status)
      .values({ ...body, source: 'netsuite', syncStatus: 'synced', syncedAt: new Date() }).returning();
    await invalidateDropdown('es_status');
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  // UPDATE
  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: status.id }).from(status)
      .where(eq(status.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('Status', req.params.nsId);
    const [updated] = await db.update(status)
      .set({ ...body, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(status.id, existing.id)).returning();
    await invalidateDropdown('es_status');
    return updated;
  });

  // ACTIVATE  → is_active = true
  app.put<{ Params: { nsId: string } }>('/:nsId/activate', async (req) =>
    setActive(req.params.nsId, true),
  );

  // INACTIVATE → is_active = false
  app.put<{ Params: { nsId: string } }>('/:nsId/inactivate', async (req) =>
    setActive(req.params.nsId, false),
  );
}

// Shared helper for activate / inactivate
async function setActive(nsId: string, isActive: boolean) {
  const db = getDb();
  const [existing] = await db.select({ id: status.id }).from(status)
    .where(eq(status.netsuiteInternalId, nsId)).limit(1);
  if (!existing) throw new NotFoundError('Status', nsId);
  const [updated] = await db.update(status)
    .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
    .where(eq(status.id, existing.id))
    .returning({ id: status.id, netsuiteInternalId: status.netsuiteInternalId, isActive: status.isActive });
  await invalidateDropdown('es_status');
  return updated;
}
