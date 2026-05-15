/**
 * VENDOR APIs
 *
 *  POST  /api/v1/netsuite/vendors          → create vendor
 *  PUT   /api/v1/netsuite/vendors/:nsId    → update vendor
 *  PATCH /api/v1/netsuite/vendors/:nsId/status → activate / deactivate
 *  GET   /api/v1/netsuite/vendors          → list all active vendors
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../config/database.js';
import { vendors } from '../../db/schema/index.js';
import { NotFoundError } from '../../utils/errors.js';
import { invalidateDropdown } from '../../utils/cache.js';

const CreateVendorSchema = z.object({
  netsuiteInternalId : z.string().min(1),
  name               : z.string().min(1).max(255),
});

const UpdateVendorSchema = CreateVendorSchema.omit({ netsuiteInternalId: true }).partial();
const StatusSchema = z.object({ isActive: z.boolean() });

export default async function vendorRoutes(app: FastifyInstance) {

  app.get('/', async () => {
    return getDb().select().from(vendors).where(eq(vendors.isActive, true)).orderBy(vendors.name);
  });

  // POST /api/v1/netsuite/vendors
  // Body: { netsuiteInternalId, name, email, paymentTerms }
  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateVendorSchema.parse(req.body);
    const db = getDb();

    const [existing] = await db.select({ id: vendors.id }).from(vendors)
      .where(eq(vendors.netsuiteInternalId, body.netsuiteInternalId)).limit(1);

    if (existing) {
      const [updated] = await db.update(vendors)
        .set({ name: body.name, updatedAt: new Date() })
        .where(eq(vendors.id, existing.id)).returning();
      await invalidateDropdown('vendors');
      return reply.status(200).send({ ...updated, _action: 'updated' });
    }

    const [created] = await db.insert(vendors).values({
      ...body, source: 'netsuite', syncStatus: 'synced', syncedAt: new Date(),
    }).returning();

    await invalidateDropdown('vendors');
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  // PUT /api/v1/netsuite/vendors/:nsId
  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateVendorSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: vendors.id }).from(vendors)
      .where(eq(vendors.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('Vendor', req.params.nsId);
    const [updated] = await db.update(vendors)
      .set({ ...body, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(vendors.id, existing.id)).returning();
    await invalidateDropdown('vendors');
    return updated;
  });

  // PATCH /api/v1/netsuite/vendors/:nsId/status
  app.patch<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
    const { isActive } = StatusSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: vendors.id }).from(vendors)
      .where(eq(vendors.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('Vendor', req.params.nsId);
    const [updated] = await db.update(vendors)
      .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(vendors.id, existing.id))
      .returning({ id: vendors.id, netsuiteInternalId: vendors.netsuiteInternalId, isActive: vendors.isActive });
    await invalidateDropdown('vendors');
    return updated;
  });
}
