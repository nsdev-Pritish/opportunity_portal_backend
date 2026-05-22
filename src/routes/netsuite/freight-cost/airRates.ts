/**
 * AIR RATE APIs
 *
 *  GET   /api/v1/netsuite/freight-cost/air-rates
 *  GET   /api/v1/netsuite/freight-cost/air-rates/:nsId
 *  POST  /api/v1/netsuite/freight-cost/air-rates
 *  PUT   /api/v1/netsuite/freight-cost/air-rates/:nsId
 *  PUT   /api/v1/netsuite/freight-cost/air-rates/:nsId/status
 *
 * POST/PUT body:
 * {
 *   "netsuiteInternalId": "301",
 *   "name": "AIR-PVGPOL-LAXPOD",
 *   "pol": "PVG",
 *   "pod": "LAX",
 *   "pricePerKg": "3.50"
 * }
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../config/database.js';
import { airRates } from '../../../db/schema/index.js';
import { NotFoundError } from '../../../utils/errors.js';
import { invalidateDropdown } from '../../../utils/cache.js';

const CreateSchema = z.object({
  netsuiteInternalId : z.string().min(1),
  name               : z.string().min(1).max(255),
  pol                : z.string().max(255).optional().nullable(),
  pod                : z.string().max(255).optional().nullable(),
  pricePerKg         : z.string().optional().nullable(),
});

const UpdateSchema = CreateSchema.omit({ netsuiteInternalId: true }).partial();
const StatusSchema = z.object({ isActive: z.boolean() });

export default async function airRateRoutes(app: FastifyInstance) {

  app.get('/', async () =>
    getDb().select().from(airRates).where(eq(airRates.isActive, true)).orderBy(airRates.name),
  );

  app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
    const [row] = await getDb().select().from(airRates)
      .where(eq(airRates.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!row) throw new NotFoundError('AirRate', req.params.nsId);
    return row;
  });

  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: airRates.id }).from(airRates)
      .where(eq(airRates.netsuiteInternalId, body.netsuiteInternalId)).limit(1);

    if (existing) {
      const [upd] = await db.update(airRates)
        .set({
          name       : body.name,
          pol        : body.pol ?? null,
          pod        : body.pod ?? null,
          pricePerKg : body.pricePerKg ?? null,
          syncStatus : 'synced',
          syncedAt   : new Date(),
          updatedAt  : new Date(),
        })
        .where(eq(airRates.id, existing.id)).returning();
      await invalidateDropdown('air_rates');
      return reply.status(200).send({ ...upd, _action: 'updated' });
    }

    const [created] = await db.insert(airRates).values({
      netsuiteInternalId : body.netsuiteInternalId,
      name               : body.name,
      pol                : body.pol ?? null,
      pod                : body.pod ?? null,
      pricePerKg         : body.pricePerKg ?? null,
      source             : 'netsuite',
      syncStatus         : 'synced',
      syncedAt           : new Date(),
    }).returning();
    await invalidateDropdown('air_rates');
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: airRates.id }).from(airRates)
      .where(eq(airRates.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('AirRate', req.params.nsId);
    const [updated] = await db.update(airRates)
      .set({ ...body, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(airRates.id, existing.id)).returning();
    await invalidateDropdown('air_rates');
    return updated;
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
    const { isActive } = StatusSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: airRates.id }).from(airRates)
      .where(eq(airRates.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('AirRate', req.params.nsId);
    const [updated] = await db.update(airRates)
      .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(airRates.id, existing.id))
      .returning({ id: airRates.id, netsuiteInternalId: airRates.netsuiteInternalId, isActive: airRates.isActive });
    await invalidateDropdown('air_rates');
    return updated;
  });
}
