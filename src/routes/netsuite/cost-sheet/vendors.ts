/**
 * COST SHEET — VENDOR APIs
 *
 *  GET   /api/v1/netsuite/cost-sheet/vendors
 *  GET   /api/v1/netsuite/cost-sheet/vendors/:nsId
 *  POST  /api/v1/netsuite/cost-sheet/vendors
 *  PUT   /api/v1/netsuite/cost-sheet/vendors/:nsId
 *  PATCH /api/v1/netsuite/cost-sheet/vendors/:nsId/status
 *
 * Body for POST/PUT:
 *  {
 *    "netsuiteInternalId": "1",
 *    "name": "V001 - Acme Mfg",
 *    "companyname": "Acme Manufacturing Ltd",
 *    "NSsubsidiary": "3",   ← NS internal id of Primary Subsidiary
 *    "NScurrency": "12"     ← NS internal id of Primary Currency
 *  }
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../config/database.js';
import { vendors, subsidiaries, currencies } from '../../../db/schema/index.js';
import { NotFoundError } from '../../../utils/errors.js';
import { invalidateDropdown } from '../../../utils/cache.js';

const CreateSchema = z.object({
  netsuiteInternalId: z.string().min(1),
  name              : z.string().min(1).max(255),
  companyname       : z.string().max(255).optional().nullable(),
  NSsubsidiary      : z.string().optional().nullable(),
  NScurrency        : z.string().optional().nullable(),
});

const UpdateSchema = CreateSchema.omit({ netsuiteInternalId: true }).partial();
const StatusSchema = z.object({ isActive: z.boolean() });

async function resolveFks(db: ReturnType<typeof getDb>, body: { NSsubsidiary?: string | null; NScurrency?: string | null }) {
  let subsidiaryId: number | null = null;
  let defaultCurrencyId: number | null = null;

  if (body.NSsubsidiary) {
    const [sub] = await db.select({ id: subsidiaries.id }).from(subsidiaries)
      .where(eq(subsidiaries.netsuiteInternalId, body.NSsubsidiary)).limit(1);
    subsidiaryId = sub?.id ?? null;
  }

  if (body.NScurrency) {
    const [cur] = await db.select({ id: currencies.id }).from(currencies)
      .where(eq(currencies.netsuiteInternalId, body.NScurrency)).limit(1);
    defaultCurrencyId = cur?.id ?? null;
  }

  return { subsidiaryId, defaultCurrencyId };
}

export default async function vendorCostSheetRoutes(app: FastifyInstance) {

  app.get('/', async () =>
    getDb().select().from(vendors).where(eq(vendors.isActive, true)).orderBy(vendors.name),
  );

  app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
    const [row] = await getDb().select().from(vendors)
      .where(eq(vendors.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!row) throw new NotFoundError('Vendor', req.params.nsId);
    return row;
  });

  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateSchema.parse(req.body);
    const db = getDb();
    const { subsidiaryId, defaultCurrencyId } = await resolveFks(db, body);

    const [existing] = await db.select({ id: vendors.id }).from(vendors)
      .where(eq(vendors.netsuiteInternalId, body.netsuiteInternalId)).limit(1);

    if (existing) {
      const [upd] = await db.update(vendors)
        .set({
          name             : body.name,
          companyName      : body.companyname,
          subsidiaryId,
          defaultCurrencyId,
          updatedAt        : new Date(),
        })
        .where(eq(vendors.id, existing.id)).returning();
      await invalidateDropdown('vendors');
      return reply.status(200).send({ ...upd, _action: 'updated' });
    }

    const [created] = await db.insert(vendors).values({
      netsuiteInternalId: body.netsuiteInternalId,
      name              : body.name,
      companyName       : body.companyname ?? null,
      subsidiaryId,
      defaultCurrencyId,
      source            : 'netsuite',
      syncStatus        : 'synced',
      syncedAt          : new Date(),
    }).returning();
    await invalidateDropdown('vendors');
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: vendors.id }).from(vendors)
      .where(eq(vendors.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('Vendor', req.params.nsId);

    const { subsidiaryId, defaultCurrencyId } = await resolveFks(db, body);

    const [updated] = await db.update(vendors)
      .set({
        name             : body.name,
        companyName      : body.companyname,
        subsidiaryId     : body.NSsubsidiary !== undefined ? subsidiaryId : undefined,
        defaultCurrencyId: body.NScurrency !== undefined ? defaultCurrencyId : undefined,
        syncStatus       : 'synced',
        syncedAt         : new Date(),
        updatedAt        : new Date(),
      })
      .where(eq(vendors.id, existing.id)).returning();
    await invalidateDropdown('vendors');
    return updated;
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
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
