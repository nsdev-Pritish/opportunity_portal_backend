/**
 * COST SHEET — PRODUCT CLASS EU APIs
 *
 *  GET   /api/v1/netsuite/cost-sheet/product-classes-eu
 *  GET   /api/v1/netsuite/cost-sheet/product-classes-eu/:nsId
 *  POST  /api/v1/netsuite/cost-sheet/product-classes-eu
 *  PUT   /api/v1/netsuite/cost-sheet/product-classes-eu/:nsId
 *  PATCH /api/v1/netsuite/cost-sheet/product-classes-eu/:nsId/status
 *
 * Body for POST/PUT:
 *  {
 *    "netsuiteInternalId": "1",
 *    "name": "Bags EU",
 *    "custrecord_parentclass_eu": "Soft Goods",
 *    "custrecord_class_eu": "Bags & Packs",
 *    "custrecord_euhts_code_eu": "4202.92",
 *    "custrecord_chinaduty_rate_eu": "20",
 *    "custrecord_cambodiaduty_rate_eu": "15",
 *    "custrecord_taiwanduty_rate_eu": "10",
 *    "custrecord_thailandduty_rate_eu": "12",
 *    "custrecord_vietnamduty_rate_eu": "8"
 *  }
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../config/database.js';
import { productClassesEu } from '../../../db/schema/index.js';
import { NotFoundError } from '../../../utils/errors.js';
import { invalidateDropdown } from '../../../utils/cache.js';

const rateField = z.string().optional().nullable();

const CreateSchema = z.object({
  netsuiteInternalId              : z.string().min(1),
  name                            : z.string().min(1).max(255),
  custrecord_parentclass_eu       : z.string().max(255).optional().nullable(),
  custrecord_class_eu             : z.string().max(255).optional().nullable(),
  custrecord_euhts_code_eu        : z.string().max(50).optional().nullable(),
  custrecord_chinaduty_rate_eu    : rateField,
  custrecord_cambodiaduty_rate_eu : rateField,
  custrecord_taiwanduty_rate_eu   : rateField,
  custrecord_thailandduty_rate_eu : rateField,
  custrecord_vietnamduty_rate_eu  : rateField,
});

const UpdateSchema = CreateSchema.omit({ netsuiteInternalId: true }).partial();
const StatusSchema = z.object({ isActive: z.boolean() });

function toDbFields(body: Partial<z.infer<typeof CreateSchema>>) {
  return {
    parentClass     : body.custrecord_parentclass_eu,
    classCode       : body.custrecord_class_eu,
    euHtsCode       : body.custrecord_euhts_code_eu,
    chinaDutyRate   : body.custrecord_chinaduty_rate_eu,
    cambodiaDutyRate: body.custrecord_cambodiaduty_rate_eu,
    taiwanDutyRate  : body.custrecord_taiwanduty_rate_eu,
    thailandDutyRate: body.custrecord_thailandduty_rate_eu,
    vietnamDutyRate : body.custrecord_vietnamduty_rate_eu,
  };
}

export default async function productClassEuRoutes(app: FastifyInstance) {

  app.get('/', async () =>
    getDb().select().from(productClassesEu).where(eq(productClassesEu.isActive, true)).orderBy(productClassesEu.name),
  );

  app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
    const [row] = await getDb().select().from(productClassesEu)
      .where(eq(productClassesEu.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!row) throw new NotFoundError('ProductClassEu', req.params.nsId);
    return row;
  });

  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateSchema.parse(req.body);
    const db = getDb();

    const [existing] = await db.select({ id: productClassesEu.id }).from(productClassesEu)
      .where(eq(productClassesEu.netsuiteInternalId, body.netsuiteInternalId)).limit(1);

    if (existing) {
      const [upd] = await db.update(productClassesEu)
        .set({ name: body.name, ...toDbFields(body), updatedAt: new Date() })
        .where(eq(productClassesEu.id, existing.id)).returning();
      await invalidateDropdown('product_classes_eu');
      return reply.status(200).send({ ...upd, _action: 'updated' });
    }

    const [created] = await db.insert(productClassesEu).values({
      netsuiteInternalId: body.netsuiteInternalId,
      name      : body.name,
      ...toDbFields(body),
      source    : 'netsuite',
      syncStatus: 'synced',
      syncedAt  : new Date(),
    }).returning();
    await invalidateDropdown('product_classes_eu');
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: productClassesEu.id }).from(productClassesEu)
      .where(eq(productClassesEu.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('ProductClassEu', req.params.nsId);
    const [updated] = await db.update(productClassesEu)
      .set({ name: body.name, ...toDbFields(body), syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(productClassesEu.id, existing.id)).returning();
    await invalidateDropdown('product_classes_eu');
    return updated;
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
    const { isActive } = StatusSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: productClassesEu.id }).from(productClassesEu)
      .where(eq(productClassesEu.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('ProductClassEu', req.params.nsId);
    const [updated] = await db.update(productClassesEu)
      .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(productClassesEu.id, existing.id))
      .returning({ id: productClassesEu.id, netsuiteInternalId: productClassesEu.netsuiteInternalId, isActive: productClassesEu.isActive });
    await invalidateDropdown('product_classes_eu');
    return updated;
  });
}
