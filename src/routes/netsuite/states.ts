/**
 * STATE APIs
 * Called by NetSuite SuiteScript when a State is created or changed.
 *
 *  GET   /api/v1/netsuite/states
 *  GET   /api/v1/netsuite/states/:nsId
 *  POST  /api/v1/netsuite/states
 *  PUT   /api/v1/netsuite/states/:nsId
 *  PUT   /api/v1/netsuite/states/:nsId/status
 *
 * Body for POST/PUT:
 *  { "netsuiteInternalId": "10", "name": "California", "code": "CA", "countryNsId": "1" }
 *
 * `countryNsId` is the NetSuite internal id of the parent country; it is resolved
 * to the local countries.id FK. Unknown / omitted → country_id left null.
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../config/database.js';
import { states, countries } from '../../db/schema/index.js';
import { NotFoundError } from '../../utils/errors.js';
import { invalidateDropdown } from '../../utils/cache.js';

const CreateSchema = z.object({
  netsuiteInternalId: z.string().min(1),
  name: z.string().min(1).max(255),
  code: z.string().max(20).optional().nullable(),
  countryNsId: z.string().optional().nullable(),
});

const UpdateSchema = CreateSchema.omit({ netsuiteInternalId: true }).partial();
const StatusSchema = z.object({ isActive: z.boolean() });

// Resolve a country's NetSuite internal id → local countries.id (null when unknown).
async function resolveCountryId(countryNsId?: string | null): Promise<number | null> {
  if (!countryNsId) return null;
  const [row] = await getDb().select({ id: countries.id }).from(countries)
    .where(eq(countries.netsuiteInternalId, countryNsId)).limit(1);
  return row?.id ?? null;
}

export default async function stateRoutes(app: FastifyInstance) {

  // ── GET /api/v1/netsuite/states ── list active states
  app.get('/', async () =>
    getDb().select().from(states).where(eq(states.isActive, true)).orderBy(states.name),
  );

  // ── GET /api/v1/netsuite/states/:nsId ── single state by NS internalId
  app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
    const [row] = await getDb().select().from(states)
      .where(eq(states.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!row) throw new NotFoundError('State', req.params.nsId);
    return row;
  });

  // ── POST /api/v1/netsuite/states ── create (idempotent on NS id)
  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const { countryNsId, ...body } = CreateSchema.parse(req.body);
    const db = getDb();
    const countryId = await resolveCountryId(countryNsId);
    const [existing] = await db.select({ id: states.id }).from(states)
      .where(eq(states.netsuiteInternalId, body.netsuiteInternalId)).limit(1);
    if (existing) {
      const [upd] = await db.update(states)
        .set({ name: body.name, code: body.code, countryId, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
        .where(eq(states.id, existing.id)).returning();
      await invalidateDropdown('states');
      return reply.status(200).send({ ...upd, _action: 'updated' });
    }
    const [created] = await db.insert(states)
      .values({ ...body, countryId, source: 'netsuite', syncStatus: 'synced', syncedAt: new Date() }).returning();
    await invalidateDropdown('states');
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  // ── PUT /api/v1/netsuite/states/:nsId ── update existing state
  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const { countryNsId, ...body } = UpdateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: states.id }).from(states)
      .where(eq(states.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('State', req.params.nsId);
    // Only touch country_id when a countryNsId was supplied in the body.
    const countryPatch = countryNsId === undefined ? {} : { countryId: await resolveCountryId(countryNsId) };
    const [updated] = await db.update(states)
      .set({ ...body, ...countryPatch, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(states.id, existing.id)).returning();
    await invalidateDropdown('states');
    return updated;
  });

  // ── PUT /api/v1/netsuite/states/:nsId/status ── activate / deactivate
  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
    const { isActive } = StatusSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: states.id }).from(states)
      .where(eq(states.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('State', req.params.nsId);
    const [updated] = await db.update(states)
      .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(states.id, existing.id))
      .returning({ id: states.id, netsuiteInternalId: states.netsuiteInternalId, isActive: states.isActive });
    await invalidateDropdown('states');
    return updated;
  });
}
