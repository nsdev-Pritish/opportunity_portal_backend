/**
 * DRAYAGE APIs
 *
 *  GET   /api/v1/netsuite/freight-cost/drayage
 *  GET   /api/v1/netsuite/freight-cost/drayage/:nsId
 *  POST  /api/v1/netsuite/freight-cost/drayage
 *  PUT   /api/v1/netsuite/freight-cost/drayage/:nsId
 *  PUT   /api/v1/netsuite/freight-cost/drayage/:nsId/status
 *
 * POST/PUT body:
 * {
 *   "netsuiteInternalId": "301",   // recordid
 *   "name": "LA Drayage",
 *   "city": "Los Angeles",
 *   "state": "CA",
 *   "zipCode": "90001",
 *   "port": "Los Angeles",
 *   "total": "450.00"
 * }
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../config/database.js';
import { drayage } from '../../../db/schema/index.js';
import { NotFoundError } from '../../../utils/errors.js';
import { invalidateDropdown } from '../../../utils/cache.js';

const CreateSchema = z.object({
  netsuiteInternalId: z.string().min(1),
  name: z.string().min(1).max(255),
  city: z.string().max(255).optional().nullable(),
  state: z.string().max(255).optional().nullable(),
  zipCode: z.string().max(20).optional().nullable(),
  port: z.string().max(255).optional().nullable(),
  total: z.string().optional().nullable(),
});

const UpdateSchema = CreateSchema.omit({ netsuiteInternalId: true }).partial();
const StatusSchema = z.object({ isActive: z.boolean() });

export default async function drayageRoutes(app: FastifyInstance) {

  app.get('/', async () =>
    getDb().select().from(drayage).where(eq(drayage.isActive, true)).orderBy(drayage.name),
  );

  app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
    const [row] = await getDb().select().from(drayage)
      .where(eq(drayage.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!row) throw new NotFoundError('Drayage', req.params.nsId);
    return row;
  });

  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: drayage.id }).from(drayage)
      .where(eq(drayage.netsuiteInternalId, body.netsuiteInternalId)).limit(1);

    if (existing) {
      const [upd] = await db.update(drayage)
        .set({
          name: body.name,
          city: body.city ?? null,
          state: body.state ?? null,
          zipCode: body.zipCode ?? null,
          port: body.port ?? null,
          total: body.total ?? null,
          syncStatus: 'synced',
          syncedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(drayage.id, existing.id)).returning();
      await invalidateDropdown('drayage');
      return reply.status(200).send({ ...upd, _action: 'updated' });
    }

    const [created] = await db.insert(drayage).values({
      netsuiteInternalId: body.netsuiteInternalId,
      name: body.name,
      city: body.city ?? null,
      state: body.state ?? null,
      zipCode: body.zipCode ?? null,
      port: body.port ?? null,
      total: body.total ?? null,
      source: 'netsuite',
      syncStatus: 'synced',
      syncedAt: new Date(),
    }).returning();
    await invalidateDropdown('drayage');
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: drayage.id }).from(drayage)
      .where(eq(drayage.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('Drayage', req.params.nsId);
    const [updated] = await db.update(drayage)
      .set({ ...body, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(drayage.id, existing.id)).returning();
    await invalidateDropdown('drayage');
    return updated;
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
    const { isActive } = StatusSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: drayage.id }).from(drayage)
      .where(eq(drayage.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('Drayage', req.params.nsId);
    const [updated] = await db.update(drayage)
      .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(drayage.id, existing.id))
      .returning({ id: drayage.id, netsuiteInternalId: drayage.netsuiteInternalId, isActive: drayage.isActive });
    await invalidateDropdown('drayage');
    return updated;
  });
}
