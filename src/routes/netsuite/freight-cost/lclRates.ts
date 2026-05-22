/**
 * LCL RATE APIs
 *
 *  GET   /api/v1/netsuite/freight-cost/lcl-rates
 *  GET   /api/v1/netsuite/freight-cost/lcl-rates/:nsId
 *  POST  /api/v1/netsuite/freight-cost/lcl-rates
 *  PUT   /api/v1/netsuite/freight-cost/lcl-rates/:nsId
 *  PUT   /api/v1/netsuite/freight-cost/lcl-rates/:nsId/status
 *
 * POST/PUT body:
 * {
 *   "netsuiteInternalId": "101",
 *   "name": "LCL-SHPOL-LAPOD",
 *   "pol": "Shanghai",
 *   "pod": "Los Angeles",
 *   "pricePerCbm": "45.00",
 *   "minFlatRate": "150.00"
 * }
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../config/database.js';
import { lclRates } from '../../../db/schema/index.js';
import { NotFoundError } from '../../../utils/errors.js';
import { invalidateDropdown } from '../../../utils/cache.js';

const CreateSchema = z.object({
  netsuiteInternalId : z.string().min(1),
  name               : z.string().min(1).max(255),
  pol                : z.string().max(255).optional().nullable(),
  pod                : z.string().max(255).optional().nullable(),
  pricePerCbm        : z.string().optional().nullable(),
  minFlatRate        : z.string().optional().nullable(),
});

const UpdateSchema = CreateSchema.omit({ netsuiteInternalId: true }).partial();
const StatusSchema = z.object({ isActive: z.boolean() });

export default async function lclRateRoutes(app: FastifyInstance) {

  app.get('/', async () =>
    getDb().select().from(lclRates).where(eq(lclRates.isActive, true)).orderBy(lclRates.name),
  );

  app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
    const [row] = await getDb().select().from(lclRates)
      .where(eq(lclRates.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!row) throw new NotFoundError('LclRate', req.params.nsId);
    return row;
  });

  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: lclRates.id }).from(lclRates)
      .where(eq(lclRates.netsuiteInternalId, body.netsuiteInternalId)).limit(1);

    if (existing) {
      const [upd] = await db.update(lclRates)
        .set({
          name        : body.name,
          pol         : body.pol ?? null,
          pod         : body.pod ?? null,
          pricePerCbm : body.pricePerCbm ?? null,
          minFlatRate : body.minFlatRate ?? null,
          syncStatus  : 'synced',
          syncedAt    : new Date(),
          updatedAt   : new Date(),
        })
        .where(eq(lclRates.id, existing.id)).returning();
      await invalidateDropdown('lcl_rates');
      return reply.status(200).send({ ...upd, _action: 'updated' });
    }

    const [created] = await db.insert(lclRates).values({
      netsuiteInternalId : body.netsuiteInternalId,
      name               : body.name,
      pol                : body.pol ?? null,
      pod                : body.pod ?? null,
      pricePerCbm        : body.pricePerCbm ?? null,
      minFlatRate        : body.minFlatRate ?? null,
      source             : 'netsuite',
      syncStatus         : 'synced',
      syncedAt           : new Date(),
    }).returning();
    await invalidateDropdown('lcl_rates');
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: lclRates.id }).from(lclRates)
      .where(eq(lclRates.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('LclRate', req.params.nsId);
    const [updated] = await db.update(lclRates)
      .set({ ...body, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(lclRates.id, existing.id)).returning();
    await invalidateDropdown('lcl_rates');
    return updated;
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
    const { isActive } = StatusSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: lclRates.id }).from(lclRates)
      .where(eq(lclRates.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('LclRate', req.params.nsId);
    const [updated] = await db.update(lclRates)
      .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(lclRates.id, existing.id))
      .returning({ id: lclRates.id, netsuiteInternalId: lclRates.netsuiteInternalId, isActive: lclRates.isActive });
    await invalidateDropdown('lcl_rates');
    return updated;
  });
}
