/**
 * Shared route builder for the Wrike request master lists.
 *
 * Every list has the same shape (id + name + syncCols), so each record file just
 * calls buildWrikeListRoutes(table, label, cacheKey) and gets the full set:
 *
 *   GET   /                    → list active records
 *   GET   /:nsId               → one record by NetSuite internal id
 *   POST  /                    → create (upsert on netsuiteInternalId)
 *   PUT   /:nsId               → update
 *   PUT   /:nsId/activate      → is_active = true
 *   PUT   /:nsId/inactivate    → is_active = false
 *   PUT   /:nsId/status        → is_active from body { "isActive": bool }
 *
 * `extra` adds table-specific fields to the create/update body (requestors → wrikeId).
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../config/database.js';
import { NotFoundError } from '../../../utils/errors.js';
import { invalidateDropdown } from '../../../utils/cache.js';

const StatusSchema = z.object({ isActive: z.boolean() });

export function buildWrikeListRoutes(
  table: any,
  label: string,
  cacheKey: string,
  extra: z.ZodRawShape = {},
) {
  const CreateSchema = z.object({
    netsuiteInternalId: z.string().min(1),
    name              : z.string().min(1).max(255),
    isActive          : z.boolean().optional(),   // defaults to true when omitted
    ...extra,
  });
  const UpdateSchema = CreateSchema.omit({ netsuiteInternalId: true }).partial();

  // Look the row up by NetSuite internal id — every write path starts here.
  async function findByNsId(nsId: string) {
    const [row] = await getDb().select({ id: table.id }).from(table)
      .where(eq(table.netsuiteInternalId, nsId)).limit(1);
    if (!row) throw new NotFoundError(label, nsId);
    return row;
  }

  async function setActive(nsId: string, isActive: boolean) {
    const existing = await findByNsId(nsId);
    const [updated] = await getDb().update(table)
      .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(table.id, existing.id))
      .returning({ id: table.id, netsuiteInternalId: table.netsuiteInternalId, isActive: table.isActive });
    await invalidateDropdown(cacheKey);
    return updated;
  }

  return async function (app: FastifyInstance) {

    // LIST — active only
    app.get('/', async () =>
      getDb().select().from(table).where(eq(table.isActive, true)).orderBy(table.name),
    );

    // GET ONE
    app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
      const [row] = await getDb().select().from(table)
        .where(eq(table.netsuiteInternalId, req.params.nsId)).limit(1);
      if (!row) throw new NotFoundError(label, req.params.nsId);
      return row;
    });

    // CREATE — upsert on netsuiteInternalId so NetSuite can replay safely
    app.post<{ Body: unknown }>('/', async (req, reply) => {
      const { netsuiteInternalId, ...body } = CreateSchema.parse(req.body);
      const db = getDb();
      const [existing] = await db.select({ id: table.id }).from(table)
        .where(eq(table.netsuiteInternalId, netsuiteInternalId)).limit(1);

      if (existing) {
        const [upd] = await db.update(table)
          .set({ ...body, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
          .where(eq(table.id, existing.id)).returning();
        await invalidateDropdown(cacheKey);
        return reply.status(200).send({ ...upd, _action: 'updated' });
      }

      const [created] = await db.insert(table)
        .values({ netsuiteInternalId, ...body, source: 'netsuite', syncStatus: 'synced', syncedAt: new Date() })
        .returning();
      await invalidateDropdown(cacheKey);
      return reply.status(201).send({ ...created, _action: 'created' });
    });

    // UPDATE
    app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
      const body = UpdateSchema.parse(req.body);
      const existing = await findByNsId(req.params.nsId);
      const [updated] = await getDb().update(table)
        .set({ ...body, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
        .where(eq(table.id, existing.id)).returning();
      await invalidateDropdown(cacheKey);
      return updated;
    });

    // ACTIVATE / INACTIVATE
    app.put<{ Params: { nsId: string } }>('/:nsId/activate', async (req) =>
      setActive(req.params.nsId, true),
    );

    app.put<{ Params: { nsId: string } }>('/:nsId/inactivate', async (req) =>
      setActive(req.params.nsId, false),
    );

    // STATUS — same thing driven by the body, for callers that send a flag
    app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
      const { isActive } = StatusSchema.parse(req.body);
      return setActive(req.params.nsId, isActive);
    });
  };
}