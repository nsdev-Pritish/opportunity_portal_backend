/**
 * FORECAST STATUS LIST APIs
 *
 *  GET   /api/v1/netsuite/list/forecast-statuses
 *  GET   /api/v1/netsuite/list/forecast-statuses/:nsId
 *  POST  /api/v1/netsuite/list/forecast-statuses
 *  PUT   /api/v1/netsuite/list/forecast-statuses/:nsId
 *  PUT   /api/v1/netsuite/list/forecast-statuses/:nsId/status   (activate / deactivate)
 *
 * Body for POST/PUT:
 *  { "netsuiteInternalId": "1", "name": "Committed" }
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../config/database.js';
import { forecastStatuses } from '../../../db/schema/index.js';
import { NotFoundError } from '../../../utils/errors.js';
import { invalidateDropdown } from '../../../utils/cache.js';

const CreateSchema = z.object({
  netsuiteInternalId: z.string().min(1),
  name              : z.string().min(1).max(255),
});

const UpdateSchema = CreateSchema.omit({ netsuiteInternalId: true }).partial();
const StatusSchema = z.object({ isActive: z.boolean() });

export default async function forecastStatusRoutes(app: FastifyInstance) {

  app.get('/', async () =>
    getDb().select().from(forecastStatuses).where(eq(forecastStatuses.isActive, true)).orderBy(forecastStatuses.name),
  );

  app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
    const [row] = await getDb().select().from(forecastStatuses)
      .where(eq(forecastStatuses.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!row) throw new NotFoundError('ForecastStatus', req.params.nsId);
    return row;
  });

  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: forecastStatuses.id }).from(forecastStatuses)
      .where(eq(forecastStatuses.netsuiteInternalId, body.netsuiteInternalId)).limit(1);
    if (existing) {
      const [upd] = await db.update(forecastStatuses)
        .set({ name: body.name, updatedAt: new Date() })
        .where(eq(forecastStatuses.id, existing.id)).returning();
      await invalidateDropdown('forecast_statuses');
      return reply.status(200).send({ ...upd, _action: 'updated' });
    }
    const [created] = await db.insert(forecastStatuses)
      .values({ ...body, source: 'netsuite', syncStatus: 'synced', syncedAt: new Date() }).returning();
    await invalidateDropdown('forecast_statuses');
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: forecastStatuses.id }).from(forecastStatuses)
      .where(eq(forecastStatuses.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('ForecastStatus', req.params.nsId);
    const [updated] = await db.update(forecastStatuses)
      .set({ ...body, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(forecastStatuses.id, existing.id)).returning();
    await invalidateDropdown('forecast_statuses');
    return updated;
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
    const { isActive } = StatusSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: forecastStatuses.id }).from(forecastStatuses)
      .where(eq(forecastStatuses.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('ForecastStatus', req.params.nsId);
    const [updated] = await db.update(forecastStatuses)
      .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(forecastStatuses.id, existing.id))
      .returning({ id: forecastStatuses.id, netsuiteInternalId: forecastStatuses.netsuiteInternalId, isActive: forecastStatuses.isActive });
    await invalidateDropdown('forecast_statuses');
    return updated;
  });
}
