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
 *  { "netsuiteInternalId": "1", "name": "ABC Factory", "custrecord_mw_factory_country": "China" }
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../config/database.js';
import { factories } from '../../../db/schema/index.js';
import { NotFoundError } from '../../../utils/errors.js';
import { invalidateDropdown } from '../../../utils/cache.js';

const CreateSchema = z.object({
  netsuiteInternalId           : z.string().min(1),
  name                         : z.string().min(1).max(255),
  custrecord_mw_factory_country: z.string().max(100).optional().nullable(),
});

const UpdateSchema = CreateSchema.omit({ netsuiteInternalId: true }).partial();
const StatusSchema = z.object({ isActive: z.boolean() });

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

    const [existing] = await db.select({ id: factories.id }).from(factories)
      .where(eq(factories.netsuiteInternalId, body.netsuiteInternalId)).limit(1);

    if (existing) {
      const [upd] = await db.update(factories)
        .set({ name: body.name, country: body.custrecord_mw_factory_country, updatedAt: new Date() })
        .where(eq(factories.id, existing.id)).returning();
      await invalidateDropdown('factories');
      return reply.status(200).send({ ...upd, _action: 'updated' });
    }

    const [created] = await db.insert(factories).values({
      netsuiteInternalId: body.netsuiteInternalId,
      name              : body.name,
      country           : body.custrecord_mw_factory_country ?? null,
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
    const [updated] = await db.update(factories)
      .set({
        name      : body.name,
        country   : body.custrecord_mw_factory_country,
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
