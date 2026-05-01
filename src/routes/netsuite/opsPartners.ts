/**
 * OPS PARTNER APIs
 *
 *  GET   /api/v1/netsuite/ops-partners
 *  GET   /api/v1/netsuite/ops-partners/:nsId
 *  POST  /api/v1/netsuite/ops-partners
 *  PUT   /api/v1/netsuite/ops-partners/:nsId
 *  PATCH /api/v1/netsuite/ops-partners/:nsId/status
 *
 * Body for POST/PUT:
 *  { "netsuiteInternalId": "70", "name": "OPS Asia", "contactName": "Amy Tan", "region": "APAC" }
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../config/database.js';
import { opsPartners } from '../../db/schema/index.js';
import { NotFoundError } from '../../utils/errors.js';
import { invalidateDropdown } from '../../utils/cache.js';

const CreateSchema = z.object({
  netsuiteInternalId : z.string().min(1),
  name               : z.string().min(1).max(255),
  contactName        : z.string().max(255).optional().nullable(),
  region             : z.string().max(100).optional().nullable(),
});

const UpdateSchema = CreateSchema.omit({ netsuiteInternalId: true }).partial();
const StatusSchema = z.object({ isActive: z.boolean() });

export default async function opsPartnerRoutes(app: FastifyInstance) {

  app.get('/', async () =>
    getDb().select().from(opsPartners).where(eq(opsPartners.isActive, true)).orderBy(opsPartners.name),
  );

  app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
    const [row] = await getDb().select().from(opsPartners)
      .where(eq(opsPartners.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!row) throw new NotFoundError('OpsPartner', req.params.nsId);
    return row;
  });

  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: opsPartners.id }).from(opsPartners)
      .where(eq(opsPartners.netsuiteInternalId, body.netsuiteInternalId)).limit(1);
    if (existing) {
      const [upd] = await db.update(opsPartners)
        .set({ name: body.name, contactName: body.contactName, region: body.region, updatedAt: new Date() })
        .where(eq(opsPartners.id, existing.id)).returning();
      await invalidateDropdown('ops_partners');
      return reply.status(200).send({ ...upd, _action: 'updated' });
    }
    const [created] = await db.insert(opsPartners)
      .values({ ...body, source: 'netsuite', syncStatus: 'synced', syncedAt: new Date() }).returning();
    await invalidateDropdown('ops_partners');
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: opsPartners.id }).from(opsPartners)
      .where(eq(opsPartners.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('OpsPartner', req.params.nsId);
    const [updated] = await db.update(opsPartners)
      .set({ ...body, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(opsPartners.id, existing.id)).returning();
    await invalidateDropdown('ops_partners');
    return updated;
  });

  app.patch<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
    const { isActive } = StatusSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: opsPartners.id }).from(opsPartners)
      .where(eq(opsPartners.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('OpsPartner', req.params.nsId);
    const [updated] = await db.update(opsPartners)
      .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(opsPartners.id, existing.id))
      .returning({ id: opsPartners.id, netsuiteInternalId: opsPartners.netsuiteInternalId, isActive: opsPartners.isActive });
    await invalidateDropdown('ops_partners');
    return updated;
  });
}
