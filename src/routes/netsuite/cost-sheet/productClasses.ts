/**
 * COST SHEET — PRODUCT CLASS APIs
 *
 *  GET   /api/v1/netsuite/cost-sheet/product-classes
 *  GET   /api/v1/netsuite/cost-sheet/product-classes/:nsId
 *  POST  /api/v1/netsuite/cost-sheet/product-classes
 *  PUT   /api/v1/netsuite/cost-sheet/product-classes/:nsId
 *  PATCH /api/v1/netsuite/cost-sheet/product-classes/:nsId/status
 *
 * Body for POST/PUT:
 *  {
 *    "netsuiteInternalId": "1",
 *    "name": "Bags",
 *    "custrecord_parentclass": "Soft Goods",
 *    "custrecord_class": "Bags & Packs",
 *    "custrecord_ushts_code": "4202.92",
 *    "custrecord_chinaduty_rate": "20",
 *    "custrecord_chinatariff_rate": "25",
 *    ...
 *  }
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../config/database.js';
import { productClasses } from '../../../db/schema/index.js';
import { NotFoundError } from '../../../utils/errors.js';
import { invalidateDropdown } from '../../../utils/cache.js';

const rateField = z.string().optional().nullable();

const CreateSchema = z.object({
  netsuiteInternalId            : z.string().min(1),
  name                          : z.string().min(1).max(255),
  custrecord_parentclass        : z.string().max(255).optional().nullable(),
  custrecord_class              : z.string().max(255).optional().nullable(),
  custrecord_ushts_code         : z.string().max(50).optional().nullable(),
  custrecord_chinaduty_rate     : rateField,
  custrecord_cambodiaduty_rate  : rateField,
  custrecord_taiwanduty_rate    : rateField,
  custrecord_thailandduty_rate  : rateField,
  custrecord_vietnamduty_rate   : rateField,
  custrecord_chinatariff_rate   : rateField,
  custrecord_hktariff_rate      : rateField,
  custrecord_taiwantariff_rate  : rateField,
  custrecord_vietnamtariff_rate : rateField,
  custrecord_cambodiatariff_rate: rateField,
  custrecord_thailandtariff_rate: rateField,
});

const UpdateSchema = CreateSchema.omit({ netsuiteInternalId: true }).partial();
const StatusSchema = z.object({ isActive: z.boolean() });

function toDbFields(body: Partial<z.infer<typeof CreateSchema>>) {
  return {
    parentClass      : body.custrecord_parentclass,
    classCode        : body.custrecord_class,
    usHtsCode        : body.custrecord_ushts_code,
    chinaDutyRate    : body.custrecord_chinaduty_rate,
    cambodiaDutyRate : body.custrecord_cambodiaduty_rate,
    taiwanDutyRate   : body.custrecord_taiwanduty_rate,
    thailandDutyRate : body.custrecord_thailandduty_rate,
    vietnamDutyRate  : body.custrecord_vietnamduty_rate,
    chinaTariffRate  : body.custrecord_chinatariff_rate,
    hkTariffRate     : body.custrecord_hktariff_rate,
    taiwanTariffRate : body.custrecord_taiwantariff_rate,
    vietnamTariffRate: body.custrecord_vietnamtariff_rate,
    cambodiaTariffRate: body.custrecord_cambodiatariff_rate,
    thailandTariffRate: body.custrecord_thailandtariff_rate,
  };
}

export default async function productClassCostSheetRoutes(app: FastifyInstance) {

  app.get('/', async () =>
    getDb().select().from(productClasses).where(eq(productClasses.isActive, true)).orderBy(productClasses.name),
  );

  app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
    const [row] = await getDb().select().from(productClasses)
      .where(eq(productClasses.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!row) throw new NotFoundError('ProductClass', req.params.nsId);
    return row;
  });

  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateSchema.parse(req.body);
    const db = getDb();

    const [existing] = await db.select({ id: productClasses.id }).from(productClasses)
      .where(eq(productClasses.netsuiteInternalId, body.netsuiteInternalId)).limit(1);

    if (existing) {
      const [upd] = await db.update(productClasses)
        .set({ name: body.name, ...toDbFields(body), updatedAt: new Date() })
        .where(eq(productClasses.id, existing.id)).returning();
      await invalidateDropdown('product_classes');
      return reply.status(200).send({ ...upd, _action: 'updated' });
    }

    const [created] = await db.insert(productClasses).values({
      netsuiteInternalId: body.netsuiteInternalId,
      name      : body.name,
      ...toDbFields(body),
      source    : 'netsuite',
      syncStatus: 'synced',
      syncedAt  : new Date(),
    }).returning();
    await invalidateDropdown('product_classes');
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateSchema.parse(req.body);
    console.log('Updating ProductClass with NS ID:', req.params.nsId, 'and body:', body);
    const db = getDb();
    const [existing] = await db.select({ id: productClasses.id }).from(productClasses)
      .where(eq(productClasses.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('ProductClass', req.params.nsId);
    const [updated] = await db.update(productClasses)
      .set({ name: body.name, ...toDbFields(body), syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(productClasses.id, existing.id)).returning();
    await invalidateDropdown('product_classes');
    return updated;
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
    const { isActive } = StatusSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: productClasses.id }).from(productClasses)
      .where(eq(productClasses.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('ProductClass', req.params.nsId);
    const [updated] = await db.update(productClasses)
      .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(productClasses.id, existing.id))
      .returning({ id: productClasses.id, netsuiteInternalId: productClasses.netsuiteInternalId, isActive: productClasses.isActive });
    await invalidateDropdown('product_classes');
    return updated;
  });
}
