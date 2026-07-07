/**
 * COST SHEET — CLASS APIs (unified US + EU class master)
 *
 *  GET   /api/v1/netsuite/cost-sheet/classes
 *  GET   /api/v1/netsuite/cost-sheet/classes/:nsId
 *  POST  /api/v1/netsuite/cost-sheet/classes
 *  PUT   /api/v1/netsuite/cost-sheet/classes/:nsId
 *  PUT   /api/v1/netsuite/cost-sheet/classes/:nsId/status
 *
 * Body for POST/PUT accepts NetSuite custrecord_* field names for the fields whose
 * NS ids are known, and falls back to the plain camelCase DB prop for the rest.
 *  {
 *    "netsuiteInternalId": "1",
 *    "name": "Accessories",
 *    "custrecord_parentclass": "Soft Goods",
 *    "custrecord_ushts_code": "4202.92",
 *    "custrecord_chinaduty_rate": "20",
 *    "usDutyRate": "5",
 *    "euHtsCode": "4202.92.00",
 *    ...
 *  }
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../config/database.js';
import { classes } from '../../../db/schema/index.js';
import { NotFoundError } from '../../../utils/errors.js';
import { invalidateDropdown } from '../../../utils/cache.js';

const rateField = z.string().optional().nullable();
const textField = z.string().optional().nullable();

const CreateSchema = z.object({
  netsuiteInternalId            : z.string().min(1),
  name                          : z.string().min(1).max(255),

  // US / general — known NetSuite custrecord_* names
  custrecord_parentclass        : z.string().max(255).optional().nullable(),
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

  // Newer fields — NS custrecord names not yet known, accept camelCase DB props
  subsidiaries                  : textField,
  includeChildren               : z.boolean().optional().nullable(),
  usDutyRate                    : rateField,
  show                          : z.boolean().optional().nullable(),
  euHtsImport                   : z.string().max(255).optional().nullable(),
  euHtsExport                   : z.string().max(255).optional().nullable(),
  euDutyRate                    : rateField,
  notes                         : textField,
  classPlanningCategory         : z.string().max(255).optional().nullable(),
  nspbClassPlanningCategory     : z.string().max(255).optional().nullable(),
  isEu                          : z.string().max(50).optional().nullable(),
  euHtsCode                     : z.string().max(50).optional().nullable(),
  chinaDutyRateEu               : rateField,
  cambodiaDutyRateEu            : rateField,
  taiwanDutyRateEu              : rateField,
  thailandDutyRateEu            : rateField,
  vietnamDutyRateEu             : rateField,
});

const UpdateSchema = CreateSchema.omit({ netsuiteInternalId: true }).partial();
const StatusSchema = z.object({ isActive: z.boolean() });

function toDbFields(body: Partial<z.infer<typeof CreateSchema>>) {
  return {
    parentClass       : body.custrecord_parentclass,
    usHtsCode         : body.custrecord_ushts_code,
    chinaDutyRate     : body.custrecord_chinaduty_rate,
    cambodiaDutyRate  : body.custrecord_cambodiaduty_rate,
    taiwanDutyRate    : body.custrecord_taiwanduty_rate,
    thailandDutyRate  : body.custrecord_thailandduty_rate,
    vietnamDutyRate   : body.custrecord_vietnamduty_rate,
    chinaTariffRate   : body.custrecord_chinatariff_rate,
    hkTariffRate      : body.custrecord_hktariff_rate,
    taiwanTariffRate  : body.custrecord_taiwantariff_rate,
    vietnamTariffRate : body.custrecord_vietnamtariff_rate,
    cambodiaTariffRate: body.custrecord_cambodiatariff_rate,
    thailandTariffRate: body.custrecord_thailandtariff_rate,

    subsidiaries              : body.subsidiaries,
    includeChildren           : body.includeChildren,
    usDutyRate                : body.usDutyRate,
    show                      : body.show,
    euHtsImport               : body.euHtsImport,
    euHtsExport               : body.euHtsExport,
    euDutyRate                : body.euDutyRate,
    notes                     : body.notes,
    classPlanningCategory     : body.classPlanningCategory,
    nspbClassPlanningCategory : body.nspbClassPlanningCategory,
    isEu                      : body.isEu,
    euHtsCode                 : body.euHtsCode,
    chinaDutyRateEu           : body.chinaDutyRateEu,
    cambodiaDutyRateEu        : body.cambodiaDutyRateEu,
    taiwanDutyRateEu          : body.taiwanDutyRateEu,
    thailandDutyRateEu        : body.thailandDutyRateEu,
    vietnamDutyRateEu         : body.vietnamDutyRateEu,
  };
}

export default async function classCostSheetRoutes(app: FastifyInstance) {

  app.get('/', async () =>
    getDb().select().from(classes).where(eq(classes.isActive, true)).orderBy(classes.name),
  );

  app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
    const [row] = await getDb().select().from(classes)
      .where(eq(classes.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!row) throw new NotFoundError('Class', req.params.nsId);
    return row;
  });

  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateSchema.parse(req.body);
    const db = getDb();

    const [existing] = await db.select({ id: classes.id }).from(classes)
      .where(eq(classes.netsuiteInternalId, body.netsuiteInternalId)).limit(1);

    if (existing) {
      const [upd] = await db.update(classes)
        .set({ name: body.name, ...toDbFields(body), updatedAt: new Date() })
        .where(eq(classes.id, existing.id)).returning();
      await invalidateDropdown('classes');
      return reply.status(200).send({ ...upd, _action: 'updated' });
    }

    const [created] = await db.insert(classes).values({
      netsuiteInternalId: body.netsuiteInternalId,
      name      : body.name,
      ...toDbFields(body),
      source    : 'netsuite',
      syncStatus: 'synced',
      syncedAt  : new Date(),
    }).returning();
    await invalidateDropdown('classes');
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: classes.id }).from(classes)
      .where(eq(classes.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('Class', req.params.nsId);
    const [updated] = await db.update(classes)
      .set({ name: body.name, ...toDbFields(body), syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(classes.id, existing.id)).returning();
    await invalidateDropdown('classes');
    return updated;
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
    const { isActive } = StatusSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: classes.id }).from(classes)
      .where(eq(classes.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('Class', req.params.nsId);
    const [updated] = await db.update(classes)
      .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(classes.id, existing.id))
      .returning({ id: classes.id, netsuiteInternalId: classes.netsuiteInternalId, isActive: classes.isActive });
    await invalidateDropdown('classes');
    return updated;
  });
}
