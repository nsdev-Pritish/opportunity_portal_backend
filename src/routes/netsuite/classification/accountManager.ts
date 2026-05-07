/**
 * ACCOUNT MANAGER APIs
 *
 *  GET   /api/v1/netsuite/account-managers
 *  GET   /api/v1/netsuite/account-managers/:nsId
 *  POST  /api/v1/netsuite/account-managers
 *  PUT   /api/v1/netsuite/account-managers/:nsId
 *  PATCH /api/v1/netsuite/account-managers/:nsId/status
 *
 * Body for POST/PUT:
 *  { "netsuiteInternalId": "123", "name": "John Doe" }
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../config/database.js';
import { accountManagers } from '../../../db/schema/index.js';
import { NotFoundError } from '../../../utils/errors.js';
import { invalidateDropdown } from '../../../utils/cache.js';

const CreateSchema = z.object({
  netsuiteInternalId: z.string().min(1),
  name: z.string().min(1).max(255),
});

const UpdateSchema = CreateSchema.omit({ netsuiteInternalId: true }).partial();
const StatusSchema = z.object({ isActive: z.boolean() });

export default async function accountManagerRoutes(app: FastifyInstance) {

  app.get('/', async () =>
    getDb().select().from(accountManagers).where(eq(accountManagers.isActive, true)).orderBy(accountManagers.name),
  );

  app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
    const [row] = await getDb().select().from(accountManagers)
      .where(eq(accountManagers.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!row) throw new NotFoundError('AccountManager', req.params.nsId);
    return row;
  });

  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: accountManagers.id }).from(accountManagers)
      .where(eq(accountManagers.netsuiteInternalId, body.netsuiteInternalId)).limit(1);
    if (existing) {
      const [upd] = await db.update(accountManagers)
        .set({ name: body.name, updatedAt: new Date() })
        .where(eq(accountManagers.id, existing.id)).returning();
      await invalidateDropdown('account_managers');
      return reply.status(200).send({ ...upd, _action: 'updated' });
    }
    const [created] = await db.insert(accountManagers)
      .values({ ...body, source: 'netsuite', syncStatus: 'synced', syncedAt: new Date() }).returning();
    await invalidateDropdown('account_managers');
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: accountManagers.id }).from(accountManagers)
      .where(eq(accountManagers.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('AccountManager', req.params.nsId);
    const [updated] = await db.update(accountManagers)
      .set({ ...body, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(accountManagers.id, existing.id)).returning();
    await invalidateDropdown('account_managers');
    return updated;
  });

  app.patch<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
    const { isActive } = StatusSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: accountManagers.id }).from(accountManagers)
      .where(eq(accountManagers.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('AccountManager', req.params.nsId);
    const [updated] = await db.update(accountManagers)
      .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(accountManagers.id, existing.id))
      .returning({ id: accountManagers.id, netsuiteInternalId: accountManagers.netsuiteInternalId, isActive: accountManagers.isActive });
    await invalidateDropdown('account_managers');
    return updated;
  });
}
