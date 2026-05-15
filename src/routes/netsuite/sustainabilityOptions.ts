/**
 * SUSTAINABILITY OPTION APIs
 *
 *  GET   /api/v1/netsuite/sustainability-options
 *  GET   /api/v1/netsuite/sustainability-options/:nsId
 *  POST  /api/v1/netsuite/sustainability-options
 *  PUT   /api/v1/netsuite/sustainability-options/:nsId
 *  PATCH /api/v1/netsuite/sustainability-options/:nsId/status
 *
 * Body for POST/PUT:
 *  { "netsuiteInternalId": "1", "name": "Organic Cotton", "certBody": "GOTS" }
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../config/database.js';
import { sustainabilityOptions } from '../../db/schema/index.js';
import { NotFoundError } from '../../utils/errors.js';
import { invalidateDropdown } from '../../utils/cache.js';

const CreateSchema = z.object({
  netsuiteInternalId : z.string().min(1),
  name               : z.string().min(1).max(255),
});

const UpdateSchema = CreateSchema.omit({ netsuiteInternalId: true }).partial();
const StatusSchema = z.object({ isActive: z.boolean() });

export default async function sustainabilityRoutes(app: FastifyInstance) {

  app.get('/', async () =>
    getDb().select().from(sustainabilityOptions).where(eq(sustainabilityOptions.isActive, true)).orderBy(sustainabilityOptions.name),
  );

  app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
    const [row] = await getDb().select().from(sustainabilityOptions)
      .where(eq(sustainabilityOptions.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!row) throw new NotFoundError('SustainabilityOption', req.params.nsId);
    return row;
  });

  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: sustainabilityOptions.id }).from(sustainabilityOptions)
      .where(eq(sustainabilityOptions.netsuiteInternalId, body.netsuiteInternalId)).limit(1);
    if (existing) {
      const [upd] = await db.update(sustainabilityOptions)
        .set({ name: body.name, updatedAt: new Date() })
        .where(eq(sustainabilityOptions.id, existing.id)).returning();
      await invalidateDropdown('sustainability_options');
      return reply.status(200).send({ ...upd, _action: 'updated' });
    }
    const [created] = await db.insert(sustainabilityOptions)
      .values({ ...body, source: 'netsuite', syncStatus: 'synced', syncedAt: new Date() }).returning();
    await invalidateDropdown('sustainability_options');
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: sustainabilityOptions.id }).from(sustainabilityOptions)
      .where(eq(sustainabilityOptions.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('SustainabilityOption', req.params.nsId);
    const [updated] = await db.update(sustainabilityOptions)
      .set({ ...body, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(sustainabilityOptions.id, existing.id)).returning();
    await invalidateDropdown('sustainability_options');
    return updated;
  });

  app.patch<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
    const { isActive } = StatusSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: sustainabilityOptions.id }).from(sustainabilityOptions)
      .where(eq(sustainabilityOptions.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('SustainabilityOption', req.params.nsId);
    const [updated] = await db.update(sustainabilityOptions)
      .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(sustainabilityOptions.id, existing.id))
      .returning({ id: sustainabilityOptions.id, netsuiteInternalId: sustainabilityOptions.netsuiteInternalId, isActive: sustainabilityOptions.isActive });
    await invalidateDropdown('sustainability_options');
    return updated;
  });
}
