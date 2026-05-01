/**
 * SUBSIDIARY APIs
 *
 *  GET   /api/v1/netsuite/subsidiaries
 *  GET   /api/v1/netsuite/subsidiaries/:nsId
 *  POST  /api/v1/netsuite/subsidiaries
 *  PUT   /api/v1/netsuite/subsidiaries/:nsId
 *  PATCH /api/v1/netsuite/subsidiaries/:nsId/status
 *
 * Body for POST/PUT:
 *  { "netsuiteInternalId": "1", "name": "US Subsidiary", "code": "US", "country": "United States", "currency": "USD", "isDefault": true }
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../config/database.js';
import { subsidiaries } from '../../db/schema/index.js';
import { NotFoundError } from '../../utils/errors.js';
import { invalidateDropdown } from '../../utils/cache.js';

const CreateSchema = z.object({
  netsuiteInternalId : z.string().min(1),
  name               : z.string().min(1).max(255),
  code               : z.string().max(50).optional().nullable(),
  country            : z.string().max(100).optional().nullable(),
  currency           : z.string().max(3).optional().nullable(),
  isDefault          : z.boolean().optional(),
});

const UpdateSchema = CreateSchema.omit({ netsuiteInternalId: true }).partial();
const StatusSchema = z.object({ isActive: z.boolean() });

export default async function subsidiaryRoutes(app: FastifyInstance) {

  app.get('/', async () =>
    getDb().select().from(subsidiaries).where(eq(subsidiaries.isActive, true)).orderBy(subsidiaries.name),
  );

  app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
    const [row] = await getDb().select().from(subsidiaries)
      .where(eq(subsidiaries.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!row) throw new NotFoundError('Subsidiary', req.params.nsId);
    return row;
  });

  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: subsidiaries.id }).from(subsidiaries)
      .where(eq(subsidiaries.netsuiteInternalId, body.netsuiteInternalId)).limit(1);
    if (existing) {
      const [upd] = await db.update(subsidiaries)
        .set({ name: body.name, code: body.code, country: body.country, currency: body.currency, isDefault: body.isDefault, updatedAt: new Date() })
        .where(eq(subsidiaries.id, existing.id)).returning();
      await invalidateDropdown('subsidiaries');
      return reply.status(200).send({ ...upd, _action: 'updated' });
    }
    const [created] = await db.insert(subsidiaries)
      .values({ ...body, source: 'netsuite', syncStatus: 'synced', syncedAt: new Date() }).returning();
    await invalidateDropdown('subsidiaries');
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: subsidiaries.id }).from(subsidiaries)
      .where(eq(subsidiaries.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('Subsidiary', req.params.nsId);
    const [updated] = await db.update(subsidiaries)
      .set({ ...body, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(subsidiaries.id, existing.id)).returning();
    await invalidateDropdown('subsidiaries');
    return updated;
  });

  app.patch<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
    const { isActive } = StatusSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: subsidiaries.id }).from(subsidiaries)
      .where(eq(subsidiaries.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('Subsidiary', req.params.nsId);
    const [updated] = await db.update(subsidiaries)
      .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(subsidiaries.id, existing.id))
      .returning({ id: subsidiaries.id, netsuiteInternalId: subsidiaries.netsuiteInternalId, isActive: subsidiaries.isActive });
    await invalidateDropdown('subsidiaries');
    return updated;
  });
}
