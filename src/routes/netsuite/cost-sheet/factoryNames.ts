/**
 * COST SHEET — FACTORY NAME APIs
 *
 *  GET   /api/v1/netsuite/cost-sheet/factory-names
 *  GET   /api/v1/netsuite/cost-sheet/factory-names/:nsId
 *  POST  /api/v1/netsuite/cost-sheet/factory-names
 *  PUT   /api/v1/netsuite/cost-sheet/factory-names/:nsId
 *  PATCH /api/v1/netsuite/cost-sheet/factory-names/:nsId/status
 *
 * Body for POST/PUT:
 *  {
 *    "netsuiteInternalId": "1",
 *    "name": "ABC Factory",
 *    "custrecord_mw_factory_country": "China",
 *    "custrecord_mw_factory_vendor": "42"   ← NS internal id of the linked vendor
 *  }
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../config/database.js';
import { factories, vendors } from '../../../db/schema/index.js';
import { NotFoundError } from '../../../utils/errors.js';
import { invalidateDropdown } from '../../../utils/cache.js';

const CreateSchema = z.object({
  netsuiteInternalId            : z.string().min(1),
  name                          : z.string().min(1).max(255),
  custrecord_mw_factory_country : z.string().max(100).optional().nullable(),
  custrecord_mw_factory_vendor  : z.string().optional().nullable(),
});

const UpdateSchema = CreateSchema.omit({ netsuiteInternalId: true }).partial();
const StatusSchema = z.object({ isActive: z.boolean() });

async function resolveVendorId(db: ReturnType<typeof getDb>, nsVendorId?: string | null): Promise<number | null> {
  if (!nsVendorId) return null;
  const [v] = await db.select({ id: vendors.id }).from(vendors)
    .where(eq(vendors.netsuiteInternalId, nsVendorId)).limit(1);
  return v?.id ?? null;
}

export default async function factoryNameRoutes(app: FastifyInstance) {

  app.get('/', async () =>
    getDb().select().from(factories).where(eq(factories.isActive, true)).orderBy(factories.name),
  );

  app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
    const [row] = await getDb().select().from(factories)
      .where(eq(factories.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!row) throw new NotFoundError('Factory', req.params.nsId);
    return row;
  });

  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateSchema.parse(req.body);
    const db = getDb();
    const vendorId = await resolveVendorId(db, body.custrecord_mw_factory_vendor);

    const [existing] = await db.select({ id: factories.id }).from(factories)
      .where(eq(factories.netsuiteInternalId, body.netsuiteInternalId)).limit(1);

    if (existing) {
      const [upd] = await db.update(factories)
        .set({
          name     : body.name,
          country  : body.custrecord_mw_factory_country,
          vendorId : body.custrecord_mw_factory_vendor !== undefined ? vendorId : undefined,
          updatedAt: new Date(),
        })
        .where(eq(factories.id, existing.id)).returning();
      await invalidateDropdown('factories');
      return reply.status(200).send({ ...upd, _action: 'updated' });
    }

    const [created] = await db.insert(factories).values({
      netsuiteInternalId: body.netsuiteInternalId,
      name              : body.name,
      country           : body.custrecord_mw_factory_country ?? null,
      vendorId,
      source            : 'netsuite',
      syncStatus        : 'synced',
      syncedAt          : new Date(),
    }).returning();
    await invalidateDropdown('factories');
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: factories.id }).from(factories)
      .where(eq(factories.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('Factory', req.params.nsId);
    const vendorId = await resolveVendorId(db, body.custrecord_mw_factory_vendor);
    const [updated] = await db.update(factories)
      .set({
        name      : body.name,
        country   : body.custrecord_mw_factory_country,
        vendorId  : body.custrecord_mw_factory_vendor !== undefined ? vendorId : undefined,
        syncStatus: 'synced',
        syncedAt  : new Date(),
        updatedAt : new Date(),
      })
      .where(eq(factories.id, existing.id)).returning();
    await invalidateDropdown('factories');
    return updated;
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
    const { isActive } = StatusSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: factories.id }).from(factories)
      .where(eq(factories.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('Factory', req.params.nsId);
    const [updated] = await db.update(factories)
      .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(factories.id, existing.id))
      .returning({ id: factories.id, netsuiteInternalId: factories.netsuiteInternalId, isActive: factories.isActive });
    await invalidateDropdown('factories');
    return updated;
  });
}
