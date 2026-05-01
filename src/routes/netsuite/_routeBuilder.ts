/**
 * Shared route builder for simple dropdown tables.
 * Each record-specific file calls buildDropdownRoutes(table, label)
 * and gets POST / PUT / PATCH-status / GET for free.
 *
 * All files that use this are in src/routes/netsuite/
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../config/database.js';
import { invalidateDropdown } from '../../utils/cache.js';
import { NotFoundError } from '../../utils/errors.js';

export const BaseCreateSchema = z.object({
  netsuiteInternalId : z.string().min(1),
  name               : z.string().min(1).max(255),
  description        : z.string().optional().nullable(),
});

export const StatusSchema = z.object({ isActive: z.boolean() });

export function buildDropdownRoutes(table: any, cacheLabel: string) {
  return async function (app: FastifyInstance) {

    // GET / — list all active records
    app.get('/', async () =>
      getDb()
        .select()
        .from(table)
        .where(eq(table.isActive, true))
        .orderBy(table.name),
    );

    // GET /:nsId — single record
    app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
      const db = getDb();
      const [row] = await db.select().from(table)
        .where(eq(table.netsuiteInternalId, req.params.nsId)).limit(1);
      if (!row) throw new NotFoundError(cacheLabel, req.params.nsId);
      return row;
    });

    // POST / — create (idempotent on netsuiteInternalId)
    app.post<{ Body: unknown }>('/', async (req, reply) => {
      const body = BaseCreateSchema.parse(req.body);
      const db = getDb();

      const [existing] = await db
        .select({ id: table.id })
        .from(table)
        .where(eq(table.netsuiteInternalId, body.netsuiteInternalId))
        .limit(1);

      if (existing) {
        const [upd] = await db.update(table)
          .set({ name: body.name, description: body.description, updatedAt: new Date() })
          .where(eq(table.id, existing.id))
          .returning();
        await invalidateDropdown(cacheLabel);
        return reply.status(200).send({ ...upd, _action: 'updated' });
      }

      const [created] = await db.insert(table)
        .values({ ...body, source: 'netsuite', syncStatus: 'synced', syncedAt: new Date() })
        .returning();
      await invalidateDropdown(cacheLabel);
      return reply.status(201).send({ ...created, _action: 'created' });
    });

    // PUT /:nsId — update by NS internalId
    app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
      const body = BaseCreateSchema.omit({ netsuiteInternalId: true }).partial().parse(req.body);
      const db = getDb();
      const [existing] = await db.select({ id: table.id }).from(table)
        .where(eq(table.netsuiteInternalId, req.params.nsId)).limit(1);
      if (!existing) throw new NotFoundError(cacheLabel, req.params.nsId);
      const [updated] = await db.update(table)
        .set({ ...body, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
        .where(eq(table.id, existing.id))
        .returning();
      await invalidateDropdown(cacheLabel);
      return updated;
    });

    // PATCH /:nsId/status — activate or deactivate
    app.patch<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
      const { isActive } = StatusSchema.parse(req.body);
      const db = getDb();
      const [existing] = await db.select({ id: table.id }).from(table)
        .where(eq(table.netsuiteInternalId, req.params.nsId)).limit(1);
      if (!existing) throw new NotFoundError(cacheLabel, req.params.nsId);
      const [updated] = await db.update(table)
        .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
        .where(eq(table.id, existing.id))
        .returning({ id: table.id, netsuiteInternalId: table.netsuiteInternalId, isActive: table.isActive });
      await invalidateDropdown(cacheLabel);
      return updated;
    });
  };
}
