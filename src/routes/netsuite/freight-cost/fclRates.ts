/**
 * FCL RATE APIs
 *
 *  GET   /api/v1/netsuite/freight-cost/fcl-rates
 *  GET   /api/v1/netsuite/freight-cost/fcl-rates/:nsId
 *  POST  /api/v1/netsuite/freight-cost/fcl-rates
 *  PUT   /api/v1/netsuite/freight-cost/fcl-rates/:nsId
 *  PUT   /api/v1/netsuite/freight-cost/fcl-rates/:nsId/status
 *
 * POST/PUT body:
 * {
 *   "netsuiteInternalId": "201",
 *   "name": "FCL-SHPOL-LAPOD",
 *   "pol": "Shanghai",
 *   "pod": "Los Angeles",
 *   "container20": "1800.00",
 *   "container40": "2800.00"
 * }
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../config/database.js';
import { fclRates } from '../../../db/schema/index.js';
import { NotFoundError } from '../../../utils/errors.js';
import { invalidateDropdown } from '../../../utils/cache.js';

const CreateSchema = z.object({
  netsuiteInternalId : z.string().min(1),
  name               : z.string().min(1).max(255),
  pol                : z.string().max(255).optional().nullable(),
  pod                : z.string().max(255).optional().nullable(),
  container20        : z.string().optional().nullable(),
  container40        : z.string().optional().nullable(),
});

const UpdateSchema = CreateSchema.omit({ netsuiteInternalId: true }).partial();
const StatusSchema = z.object({ isActive: z.boolean() });

export default async function fclRateRoutes(app: FastifyInstance) {

  app.get('/', async () =>
    getDb().select().from(fclRates).where(eq(fclRates.isActive, true)).orderBy(fclRates.name),
  );

  app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
    const [row] = await getDb().select().from(fclRates)
      .where(eq(fclRates.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!row) throw new NotFoundError('FclRate', req.params.nsId);
    return row;
  });

  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: fclRates.id }).from(fclRates)
      .where(eq(fclRates.netsuiteInternalId, body.netsuiteInternalId)).limit(1);

    if (existing) {
      const [upd] = await db.update(fclRates)
        .set({
          name        : body.name,
          pol         : body.pol ?? null,
          pod         : body.pod ?? null,
          container20 : body.container20 ?? null,
          container40 : body.container40 ?? null,
          syncStatus  : 'synced',
          syncedAt    : new Date(),
          updatedAt   : new Date(),
        })
        .where(eq(fclRates.id, existing.id)).returning();
      await invalidateDropdown('fcl_rates');
      return reply.status(200).send({ ...upd, _action: 'updated' });
    }

    const [created] = await db.insert(fclRates).values({
      netsuiteInternalId : body.netsuiteInternalId,
      name               : body.name,
      pol                : body.pol ?? null,
      pod                : body.pod ?? null,
      container20        : body.container20 ?? null,
      container40        : body.container40 ?? null,
      source             : 'netsuite',
      syncStatus         : 'synced',
      syncedAt           : new Date(),
    }).returning();
    await invalidateDropdown('fcl_rates');
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: fclRates.id }).from(fclRates)
      .where(eq(fclRates.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('FclRate', req.params.nsId);
    const [updated] = await db.update(fclRates)
      .set({ ...body, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(fclRates.id, existing.id)).returning();
    await invalidateDropdown('fcl_rates');
    return updated;
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
    const { isActive } = StatusSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: fclRates.id }).from(fclRates)
      .where(eq(fclRates.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('FclRate', req.params.nsId);
    const [updated] = await db.update(fclRates)
      .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(fclRates.id, existing.id))
      .returning({ id: fclRates.id, netsuiteInternalId: fclRates.netsuiteInternalId, isActive: fclRates.isActive });
    await invalidateDropdown('fcl_rates');
    return updated;
  });
}
