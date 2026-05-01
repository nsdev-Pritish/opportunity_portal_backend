/**
 * INCOTERM APIs
 * Has extra fields: code (3-char) and rulesVersion.
 *
 *  GET   /api/v1/netsuite/incoterms
 *  GET   /api/v1/netsuite/incoterms/:nsId
 *  POST  /api/v1/netsuite/incoterms
 *  PUT   /api/v1/netsuite/incoterms/:nsId
 *  PATCH /api/v1/netsuite/incoterms/:nsId/status
 *
 * Body for POST/PUT:
 *  { "netsuiteInternalId": "1", "code": "EXW", "fullName": "Ex Works", "rulesVersion": "2020" }
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../config/database.js';
import { incoterms } from '../../db/schema/index.js';
import { NotFoundError } from '../../utils/errors.js';
import { invalidateDropdown } from '../../utils/cache.js';

const CreateSchema = z.object({
  netsuiteInternalId : z.string().min(1),
  code               : z.string().min(2).max(10),
  fullName           : z.string().min(1).max(255),
  rulesVersion       : z.string().max(10).optional().nullable(),
});

const UpdateSchema = CreateSchema.omit({ netsuiteInternalId: true }).partial();
const StatusSchema = z.object({ isActive: z.boolean() });

export default async function incotermRoutes(app: FastifyInstance) {

  app.get('/', async () =>
    getDb().select().from(incoterms).where(eq(incoterms.isActive, true)).orderBy(incoterms.code),
  );

  app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
    const [row] = await getDb().select().from(incoterms)
      .where(eq(incoterms.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!row) throw new NotFoundError('Incoterm', req.params.nsId);
    return row;
  });

  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: incoterms.id }).from(incoterms)
      .where(eq(incoterms.netsuiteInternalId, body.netsuiteInternalId)).limit(1);
    if (existing) {
      const [upd] = await db.update(incoterms)
        .set({ code: body.code, fullName: body.fullName, rulesVersion: body.rulesVersion, updatedAt: new Date() })
        .where(eq(incoterms.id, existing.id)).returning();
      await invalidateDropdown('incoterms');
      return reply.status(200).send({ ...upd, _action: 'updated' });
    }
    const [created] = await db.insert(incoterms)
      .values({ ...body, source: 'netsuite', syncStatus: 'synced', syncedAt: new Date() }).returning();
    await invalidateDropdown('incoterms');
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: incoterms.id }).from(incoterms)
      .where(eq(incoterms.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('Incoterm', req.params.nsId);
    const [updated] = await db.update(incoterms)
      .set({ ...body, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(incoterms.id, existing.id)).returning();
    await invalidateDropdown('incoterms');
    return updated;
  });

  app.patch<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
    const { isActive } = StatusSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: incoterms.id }).from(incoterms)
      .where(eq(incoterms.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('Incoterm', req.params.nsId);
    const [updated] = await db.update(incoterms)
      .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(incoterms.id, existing.id))
      .returning({ id: incoterms.id, netsuiteInternalId: incoterms.netsuiteInternalId, isActive: incoterms.isActive });
    await invalidateDropdown('incoterms');
    return updated;
  });
}
