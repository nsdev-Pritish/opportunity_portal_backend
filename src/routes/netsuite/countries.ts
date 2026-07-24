/**
 * COUNTRY APIs
 * Called by NetSuite SuiteScript when a Country is created or changed.
 *
 *  GET   /api/v1/netsuite/countries
 *  GET   /api/v1/netsuite/countries/:nsId
 *  POST  /api/v1/netsuite/countries
 *  PUT   /api/v1/netsuite/countries/:nsId
 *  PUT   /api/v1/netsuite/countries/:nsId/status
 *
 * Body for POST/PUT:
 *  { "netsuiteInternalId": "1", "name": "United States", "code": "US" }
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../config/database.js';
import { countries } from '../../db/schema/index.js';
import { NotFoundError } from '../../utils/errors.js';
import { invalidateDropdown } from '../../utils/cache.js';

const CreateSchema = z.object({
  netsuiteInternalId: z.string().min(1),
  name: z.string().min(1).max(255),
  code: z.string().max(10).optional().nullable(),
});

const UpdateSchema = CreateSchema.omit({ netsuiteInternalId: true }).partial();
const StatusSchema = z.object({ isActive: z.boolean() });

export default async function countryRoutes(app: FastifyInstance) {

  // ── GET /api/v1/netsuite/countries ── list active countries
  app.get('/', async () =>
    getDb().select().from(countries).where(eq(countries.isActive, true)).orderBy(countries.name),
  );

  // ── GET /api/v1/netsuite/countries/:nsId ── single country by NS internalId
  app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
    const [row] = await getDb().select().from(countries)
      .where(eq(countries.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!row) throw new NotFoundError('Country', req.params.nsId);
    return row;
  });

  // ── POST /api/v1/netsuite/countries ── create (idempotent on NS id)
  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: countries.id }).from(countries)
      .where(eq(countries.netsuiteInternalId, body.netsuiteInternalId)).limit(1);
    if (existing) {
      const [upd] = await db.update(countries)
        .set({ name: body.name, code: body.code, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
        .where(eq(countries.id, existing.id)).returning();
      await invalidateDropdown('countries');
      return reply.status(200).send({ ...upd, _action: 'updated' });
    }
    const [created] = await db.insert(countries)
      .values({ ...body, source: 'netsuite', syncStatus: 'synced', syncedAt: new Date() }).returning();
    await invalidateDropdown('countries');
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  // ── PUT /api/v1/netsuite/countries/:nsId ── update existing country
  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: countries.id }).from(countries)
      .where(eq(countries.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('Country', req.params.nsId);
    const [updated] = await db.update(countries)
      .set({ ...body, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(countries.id, existing.id)).returning();
    await invalidateDropdown('countries');
    return updated;
  });

  // ── PUT /api/v1/netsuite/countries/:nsId/status ── activate / deactivate
  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
    const { isActive } = StatusSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: countries.id }).from(countries)
      .where(eq(countries.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('Country', req.params.nsId);
    const [updated] = await db.update(countries)
      .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(countries.id, existing.id))
      .returning({ id: countries.id, netsuiteInternalId: countries.netsuiteInternalId, isActive: countries.isActive });
    await invalidateDropdown('countries');
    return updated;
  });
}
