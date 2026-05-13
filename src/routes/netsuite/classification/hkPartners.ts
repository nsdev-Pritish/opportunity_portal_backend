/**
 * HK PARTNER APIs
 *
 *  GET   /api/v1/netsuite/hk-partners
 *  GET   /api/v1/netsuite/hk-partners/:nsId
 *  POST  /api/v1/netsuite/hk-partners
 *  PUT   /api/v1/netsuite/hk-partners/:nsId
 *  PUT   /api/v1/netsuite/hk-partners/:nsId/status
 *
 * Body for POST/PUT:
 *  { "netsuiteInternalId": "60", "name": "HK Trading Co" }
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../config/database.js';
import { hkPartners } from '../../../db/schema/index.js';
import { NotFoundError } from '../../../utils/errors.js';
import { invalidateDropdown } from '../../../utils/cache.js';

const CreateSchema = z.object({
  netsuiteInternalId: z.string().min(1),
  name: z.string().min(1).max(255),
});

const UpdateSchema = CreateSchema.omit({ netsuiteInternalId: true }).partial();
const StatusSchema = z.object({ isActive: z.boolean() });

export default async function hkPartnerRoutes(app: FastifyInstance) {

  app.get('/', async () =>
    getDb().select().from(hkPartners).where(eq(hkPartners.isActive, true)).orderBy(hkPartners.name),
  );

  app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
    const [row] = await getDb().select().from(hkPartners)
      .where(eq(hkPartners.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!row) throw new NotFoundError('HKPartner', req.params.nsId);
    return row;
  });

  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: hkPartners.id }).from(hkPartners)
      .where(eq(hkPartners.netsuiteInternalId, body.netsuiteInternalId)).limit(1);
    if (existing) {
      const [upd] = await db.update(hkPartners)
        .set({ name: body.name, updatedAt: new Date() })
        .where(eq(hkPartners.id, existing.id)).returning();
      await invalidateDropdown('hk_partners');
      return reply.status(200).send({ ...upd, _action: 'updated' });
    }
    const [created] = await db.insert(hkPartners)
      .values({ ...body, source: 'netsuite', syncStatus: 'synced', syncedAt: new Date() }).returning();
    await invalidateDropdown('hk_partners');
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: hkPartners.id }).from(hkPartners)
      .where(eq(hkPartners.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('HKPartner', req.params.nsId);
    const [updated] = await db.update(hkPartners)
      .set({ ...body, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(hkPartners.id, existing.id)).returning();
    await invalidateDropdown('hk_partners');
    return updated;
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
    const { isActive } = StatusSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: hkPartners.id }).from(hkPartners)
      .where(eq(hkPartners.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('HKPartner', req.params.nsId);
    const [updated] = await db.update(hkPartners)
      .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(hkPartners.id, existing.id))
      .returning({ id: hkPartners.id, netsuiteInternalId: hkPartners.netsuiteInternalId, isActive: hkPartners.isActive });
    await invalidateDropdown('hk_partners');
    return updated;
  });
}
