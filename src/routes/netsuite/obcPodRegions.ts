/**
 * OBC POD REGION APIs
 * Called by NetSuite SuiteScript when an OBC POD Region is created or changed.
 *
 *  GET   /api/v1/netsuite/obc-pod-regions
 *  GET   /api/v1/netsuite/obc-pod-regions/:nsId
 *  POST  /api/v1/netsuite/obc-pod-regions
 *  PUT   /api/v1/netsuite/obc-pod-regions/:nsId
 *  PUT   /api/v1/netsuite/obc-pod-regions/:nsId/status
 *
 * Body for POST/PUT:
 *  { "netsuiteInternalId": "30", "name": "APAC" }
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../config/database.js';
import { obcPodRegions } from '../../db/schema/index.js';
import { NotFoundError } from '../../utils/errors.js';
import { invalidateDropdown } from '../../utils/cache.js';

const CreateSchema = z.object({
  netsuiteInternalId: z.string().min(1),
  name: z.string().min(1).max(255),
});

const UpdateSchema = CreateSchema.omit({ netsuiteInternalId: true }).partial();
const StatusSchema = z.object({ isActive: z.boolean() });

export default async function obcPodRegionRoutes(app: FastifyInstance) {

  // ── GET /api/v1/netsuite/obc-pod-regions ── list active regions
  app.get('/', async () =>
    getDb().select().from(obcPodRegions).where(eq(obcPodRegions.isActive, true)).orderBy(obcPodRegions.name),
  );

  // ── GET /api/v1/netsuite/obc-pod-regions/:nsId ── single region by NS internalId
  app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
    const [row] = await getDb().select().from(obcPodRegions)
      .where(eq(obcPodRegions.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!row) throw new NotFoundError('ObcPodRegion', req.params.nsId);
    return row;
  });

  // ── POST /api/v1/netsuite/obc-pod-regions ── create (idempotent on NS id)
  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: obcPodRegions.id }).from(obcPodRegions)
      .where(eq(obcPodRegions.netsuiteInternalId, body.netsuiteInternalId)).limit(1);
    if (existing) {
      const [upd] = await db.update(obcPodRegions)
        .set({ name: body.name, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
        .where(eq(obcPodRegions.id, existing.id)).returning();
      await invalidateDropdown('obc_pod_regions');
      return reply.status(200).send({ ...upd, _action: 'updated' });
    }
    const [created] = await db.insert(obcPodRegions)
      .values({ ...body, source: 'netsuite', syncStatus: 'synced', syncedAt: new Date() }).returning();
    await invalidateDropdown('obc_pod_regions');
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  // ── PUT /api/v1/netsuite/obc-pod-regions/:nsId ── update existing region
  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: obcPodRegions.id }).from(obcPodRegions)
      .where(eq(obcPodRegions.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('ObcPodRegion', req.params.nsId);
    const [updated] = await db.update(obcPodRegions)
      .set({ ...body, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(obcPodRegions.id, existing.id)).returning();
    await invalidateDropdown('obc_pod_regions');
    return updated;
  });

  // ── PUT /api/v1/netsuite/obc-pod-regions/:nsId/status ── activate / deactivate
  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
    const { isActive } = StatusSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: obcPodRegions.id }).from(obcPodRegions)
      .where(eq(obcPodRegions.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('ObcPodRegion', req.params.nsId);
    const [updated] = await db.update(obcPodRegions)
      .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(obcPodRegions.id, existing.id))
      .returning({ id: obcPodRegions.id, netsuiteInternalId: obcPodRegions.netsuiteInternalId, isActive: obcPodRegions.isActive });
    await invalidateDropdown('obc_pod_regions');
    return updated;
  });
}
