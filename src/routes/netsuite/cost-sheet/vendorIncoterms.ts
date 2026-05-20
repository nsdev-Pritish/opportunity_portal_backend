/**
 * VENDOR INCOTERMS APIs
 *
 *  GET   /api/v1/netsuite/cost-sheet/vendor-incoterms             → list all active vendor incoterms
 *  GET   /api/v1/netsuite/cost-sheet/vendor-incoterms/:nsId       → single vendor incoterm by NS ID
 *  POST  /api/v1/netsuite/cost-sheet/vendor-incoterms             → create / upsert vendor incoterm
 *  PUT   /api/v1/netsuite/cost-sheet/vendor-incoterms/:nsId       → update vendor incoterm
 *  PUT   /api/v1/netsuite/cost-sheet/vendor-incoterms/:nsId/status → activate / deactivate
 *
 * POST/PUT body:
 *  { "netsuiteInternalId": "1", "name": "Ex Works", "description": "EXW - Seller makes goods available at premises" }
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../config/database.js';
import { vendorIncoterms } from '../../../db/schema/index.js';
import { NotFoundError } from '../../../utils/errors.js';
import { invalidateDropdown } from '../../../utils/cache.js';

const CreateSchema = z.object({
  netsuiteInternalId : z.string().min(1),
  name               : z.string().min(1).max(255),
  description        : z.string().optional().nullable(),
});

const UpdateSchema = CreateSchema.omit({ netsuiteInternalId: true }).partial();
const StatusSchema = z.object({ isActive: z.boolean() });

export default async function vendorIncotermRoutes(app: FastifyInstance) {

  app.get('/', async () =>
    getDb().select().from(vendorIncoterms).where(eq(vendorIncoterms.isActive, true)).orderBy(vendorIncoterms.name),
  );

  app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
    const [row] = await getDb().select().from(vendorIncoterms)
      .where(eq(vendorIncoterms.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!row) throw new NotFoundError('VendorIncoterm', req.params.nsId);
    return row;
  });

  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: vendorIncoterms.id }).from(vendorIncoterms)
      .where(eq(vendorIncoterms.netsuiteInternalId, body.netsuiteInternalId)).limit(1);
    if (existing) {
      const [upd] = await db.update(vendorIncoterms)
        .set({ name: body.name, description: body.description, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
        .where(eq(vendorIncoterms.id, existing.id)).returning();
      await invalidateDropdown('vendor_incoterms');
      return reply.status(200).send({ ...upd, _action: 'updated' });
    }
    const [created] = await db.insert(vendorIncoterms)
      .values({ ...body, source: 'netsuite', syncStatus: 'synced', syncedAt: new Date() }).returning();
    await invalidateDropdown('vendor_incoterms');
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: vendorIncoterms.id }).from(vendorIncoterms)
      .where(eq(vendorIncoterms.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('VendorIncoterm', req.params.nsId);
    const [updated] = await db.update(vendorIncoterms)
      .set({ ...body, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(vendorIncoterms.id, existing.id)).returning();
    await invalidateDropdown('vendor_incoterms');
    return updated;
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
    const { isActive } = StatusSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: vendorIncoterms.id }).from(vendorIncoterms)
      .where(eq(vendorIncoterms.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('VendorIncoterm', req.params.nsId);
    const [updated] = await db.update(vendorIncoterms)
      .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(vendorIncoterms.id, existing.id))
      .returning({ id: vendorIncoterms.id, netsuiteInternalId: vendorIncoterms.netsuiteInternalId, isActive: vendorIncoterms.isActive });
    await invalidateDropdown('vendor_incoterms');
    return updated;
  });
}
