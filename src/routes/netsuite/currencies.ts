/**
 * CURRENCY APIs
 *
 *  GET   /api/v1/netsuite/currencies
 *  GET   /api/v1/netsuite/currencies/:nsId
 *  POST  /api/v1/netsuite/currencies
 *  PUT   /api/v1/netsuite/currencies/:nsId
 *  PATCH /api/v1/netsuite/currencies/:nsId/status
 *
 * Body for POST/PUT:
 *  { "netsuiteInternalId": "3", "code": "USD", "name": "US Dollar", "symbol": "$", "exchangeRate": "1" }
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../config/database.js';
import { currencies } from '../../db/schema/index.js';
import { NotFoundError } from '../../utils/errors.js';
import { invalidateDropdown } from '../../utils/cache.js';

const CreateSchema = z.object({
  netsuiteInternalId : z.string().min(1),
  code               : z.string().length(3),
  name               : z.string().min(1).max(100),
  symbol             : z.string().max(10).optional().nullable(),
  exchangeRate       : z.string().optional().nullable(),
});

const UpdateSchema = CreateSchema.omit({ netsuiteInternalId: true }).partial();
const StatusSchema = z.object({ isActive: z.boolean() });

export default async function currencyRoutes(app: FastifyInstance) {

  app.get('/', async () =>
    getDb().select().from(currencies).where(eq(currencies.isActive, true)).orderBy(currencies.code),
  );

  app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
    const [row] = await getDb().select().from(currencies)
      .where(eq(currencies.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!row) throw new NotFoundError('Currency', req.params.nsId);
    return row;
  });

  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: currencies.id }).from(currencies)
      .where(eq(currencies.netsuiteInternalId, body.netsuiteInternalId)).limit(1);
    if (existing) {
      const [upd] = await db.update(currencies)
        .set({ code: body.code, name: body.name, symbol: body.symbol, exchangeRate: body.exchangeRate, updatedAt: new Date() })
        .where(eq(currencies.id, existing.id)).returning();
      await invalidateDropdown('currencies');
      return reply.status(200).send({ ...upd, _action: 'updated' });
    }
    const [created] = await db.insert(currencies)
      .values({ ...body, source: 'netsuite', syncStatus: 'synced', syncedAt: new Date() }).returning();
    await invalidateDropdown('currencies');
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: currencies.id }).from(currencies)
      .where(eq(currencies.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('Currency', req.params.nsId);
    const [updated] = await db.update(currencies)
      .set({ ...body, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(currencies.id, existing.id)).returning();
    await invalidateDropdown('currencies');
    return updated;
  });

  app.patch<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
    const { isActive } = StatusSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: currencies.id }).from(currencies)
      .where(eq(currencies.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('Currency', req.params.nsId);
    const [updated] = await db.update(currencies)
      .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(currencies.id, existing.id))
      .returning({ id: currencies.id, netsuiteInternalId: currencies.netsuiteInternalId, isActive: currencies.isActive });
    await invalidateDropdown('currencies');
    return updated;
  });
}
