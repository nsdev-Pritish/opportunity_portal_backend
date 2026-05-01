/**
 * COMPLIANCE PARTNER APIs
 *
 *  GET   /api/v1/netsuite/compliance-partners
 *  GET   /api/v1/netsuite/compliance-partners/:nsId
 *  POST  /api/v1/netsuite/compliance-partners
 *  PUT   /api/v1/netsuite/compliance-partners/:nsId
 *  PATCH /api/v1/netsuite/compliance-partners/:nsId/status
 *
 * Body for POST/PUT:
 *  { "netsuiteInternalId": "80", "name": "SGS Global", "contactName": "Sara Chen", "certTypes": ["ISO","REACH"] }
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../config/database.js';
import { compliancePartners } from '../../db/schema/index.js';
import { NotFoundError } from '../../utils/errors.js';
import { invalidateDropdown } from '../../utils/cache.js';

const CreateSchema = z.object({
  netsuiteInternalId : z.string().min(1),
  name               : z.string().min(1).max(255),
  contactName        : z.string().max(255).optional().nullable(),
  certTypes          : z.array(z.string()).optional(),
});

const UpdateSchema = CreateSchema.omit({ netsuiteInternalId: true }).partial();
const StatusSchema = z.object({ isActive: z.boolean() });

export default async function compliancePartnerRoutes(app: FastifyInstance) {

  app.get('/', async () =>
    getDb().select().from(compliancePartners).where(eq(compliancePartners.isActive, true)).orderBy(compliancePartners.name),
  );

  app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
    const [row] = await getDb().select().from(compliancePartners)
      .where(eq(compliancePartners.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!row) throw new NotFoundError('CompliancePartner', req.params.nsId);
    return row;
  });

  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: compliancePartners.id }).from(compliancePartners)
      .where(eq(compliancePartners.netsuiteInternalId, body.netsuiteInternalId)).limit(1);
    if (existing) {
      const [upd] = await db.update(compliancePartners)
        .set({ name: body.name, contactName: body.contactName, certTypes: body.certTypes, updatedAt: new Date() })
        .where(eq(compliancePartners.id, existing.id)).returning();
      await invalidateDropdown('compliance_partners');
      return reply.status(200).send({ ...upd, _action: 'updated' });
    }
    const [created] = await db.insert(compliancePartners)
      .values({ ...body, source: 'netsuite', syncStatus: 'synced', syncedAt: new Date() }).returning();
    await invalidateDropdown('compliance_partners');
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: compliancePartners.id }).from(compliancePartners)
      .where(eq(compliancePartners.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('CompliancePartner', req.params.nsId);
    const [updated] = await db.update(compliancePartners)
      .set({ ...body, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(compliancePartners.id, existing.id)).returning();
    await invalidateDropdown('compliance_partners');
    return updated;
  });

  app.patch<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
    const { isActive } = StatusSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: compliancePartners.id }).from(compliancePartners)
      .where(eq(compliancePartners.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('CompliancePartner', req.params.nsId);
    const [updated] = await db.update(compliancePartners)
      .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(compliancePartners.id, existing.id))
      .returning({ id: compliancePartners.id, netsuiteInternalId: compliancePartners.netsuiteInternalId, isActive: compliancePartners.isActive });
    await invalidateDropdown('compliance_partners');
    return updated;
  });
}
