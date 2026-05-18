/**
 * LIKELY TO CLOSE APIs
 *
 *  GET   /api/v1/netsuite/likely-to-close
 *  GET   /api/v1/netsuite/likely-to-close/:nsId
 *  POST  /api/v1/netsuite/likely-to-close
 *  PUT   /api/v1/netsuite/likely-to-close/:nsId
 *  PUT   /api/v1/netsuite/likely-to-close/:nsId/status
 *
 * Body for POST/PUT:
 *  { "netsuiteInternalId": "50", "label": "Hot" }
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../config/database.js';
import { likelyToClose } from '../../../db/schema/index.js';
import { NotFoundError } from '../../../utils/errors.js';
import { invalidateDropdown } from '../../../utils/cache.js';

const CreateSchema = z.object({
  netsuiteInternalId : z.string().min(1),
  label              : z.string().min(1).max(100),
});

const UpdateSchema = CreateSchema.omit({ netsuiteInternalId: true }).partial();
const StatusSchema = z.object({ isActive: z.boolean() });

export default async function likelyToCloseRoutes(app: FastifyInstance) {

  app.get('/', async () =>
    getDb().select().from(likelyToClose).where(eq(likelyToClose.isActive, true)),
  );

  app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
    const [row] = await getDb().select().from(likelyToClose)
      .where(eq(likelyToClose.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!row) throw new NotFoundError('LikelyToClose', req.params.nsId);
    return row;
  });

  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: likelyToClose.id }).from(likelyToClose)
      .where(eq(likelyToClose.netsuiteInternalId, body.netsuiteInternalId)).limit(1);
    if (existing) {
      const [upd] = await db.update(likelyToClose)
        .set({ label: body.label, updatedAt: new Date() })
        .where(eq(likelyToClose.id, existing.id)).returning();
      await invalidateDropdown('likely_to_close');
      return reply.status(200).send({ ...upd, _action: 'updated' });
    }
    const [created] = await db.insert(likelyToClose)
      .values({ ...body, source: 'netsuite', syncStatus: 'synced', syncedAt: new Date() }).returning();
    await invalidateDropdown('likely_to_close');
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: likelyToClose.id }).from(likelyToClose)
      .where(eq(likelyToClose.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('LikelyToClose', req.params.nsId);
    const [updated] = await db.update(likelyToClose)
      .set({ ...body, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(likelyToClose.id, existing.id)).returning();
    await invalidateDropdown('likely_to_close');
    return updated;
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
    const { isActive } = StatusSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: likelyToClose.id }).from(likelyToClose)
      .where(eq(likelyToClose.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('LikelyToClose', req.params.nsId);
    const [updated] = await db.update(likelyToClose)
      .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(likelyToClose.id, existing.id))
      .returning({ id: likelyToClose.id, netsuiteInternalId: likelyToClose.netsuiteInternalId, isActive: likelyToClose.isActive });
    await invalidateDropdown('likely_to_close');
    return updated;
  });
}
