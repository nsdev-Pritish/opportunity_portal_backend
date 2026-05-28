/**
 * CLIENT PURSUIT ALTERNATIVE APIs
 *
 *  GET   /api/v1/netsuite/client-pursuit-alternatives
 *  GET   /api/v1/netsuite/client-pursuit-alternatives/:nsId
 *  POST  /api/v1/netsuite/client-pursuit-alternatives
 *  PUT   /api/v1/netsuite/client-pursuit-alternatives/:nsId
 *  PATCH /api/v1/netsuite/client-pursuit-alternatives/:nsId/status
 *
 * Body for POST/PUT:
 *  { "netsuiteInternalId": "1", "name": "Competitor A" }
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../config/database.js';
import { clientPursuitAlternatives } from '../../db/schema/index.js';
import { NotFoundError } from '../../utils/errors.js';
import { invalidateDropdown } from '../../utils/cache.js';

const CreateSchema = z.object({
  netsuiteInternalId: z.string().min(1),
  name              : z.string().min(1).max(255),
});

const UpdateSchema = CreateSchema.omit({ netsuiteInternalId: true }).partial();
const StatusSchema = z.object({ isActive: z.boolean() });

export default async function clientPursuitAlternativeRoutes(app: FastifyInstance) {

  app.get('/', async () =>
    getDb().select().from(clientPursuitAlternatives).where(eq(clientPursuitAlternatives.isActive, true)).orderBy(clientPursuitAlternatives.name),
  );

  app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
    const [row] = await getDb().select().from(clientPursuitAlternatives)
      .where(eq(clientPursuitAlternatives.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!row) throw new NotFoundError('ClientPursuitAlternative', req.params.nsId);
    return row;
  });

  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: clientPursuitAlternatives.id }).from(clientPursuitAlternatives)
      .where(eq(clientPursuitAlternatives.netsuiteInternalId, body.netsuiteInternalId)).limit(1);
    if (existing) {
      const [upd] = await db.update(clientPursuitAlternatives)
        .set({ name: body.name, updatedAt: new Date() })
        .where(eq(clientPursuitAlternatives.id, existing.id)).returning();
      await invalidateDropdown('client_pursuit_alternatives');
      return reply.status(200).send({ ...upd, _action: 'updated' });
    }
    const [created] = await db.insert(clientPursuitAlternatives)
      .values({ ...body, source: 'netsuite', syncStatus: 'synced', syncedAt: new Date() }).returning();
    await invalidateDropdown('client_pursuit_alternatives');
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: clientPursuitAlternatives.id }).from(clientPursuitAlternatives)
      .where(eq(clientPursuitAlternatives.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('ClientPursuitAlternative', req.params.nsId);
    const [updated] = await db.update(clientPursuitAlternatives)
      .set({ ...body, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(clientPursuitAlternatives.id, existing.id)).returning();
    await invalidateDropdown('client_pursuit_alternatives');
    return updated;
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
    const { isActive } = StatusSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: clientPursuitAlternatives.id }).from(clientPursuitAlternatives)
      .where(eq(clientPursuitAlternatives.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('ClientPursuitAlternative', req.params.nsId);
    const [updated] = await db.update(clientPursuitAlternatives)
      .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(clientPursuitAlternatives.id, existing.id))
      .returning({ id: clientPursuitAlternatives.id, netsuiteInternalId: clientPursuitAlternatives.netsuiteInternalId, isActive: clientPursuitAlternatives.isActive });
    await invalidateDropdown('client_pursuit_alternatives');
    return updated;
  });
}
