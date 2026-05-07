/**
 * PRODUCT DEVELOPER APIs
 *
 *  GET   /api/v1/netsuite/product-developers
 *  GET   /api/v1/netsuite/product-developers/:nsId
 *  POST  /api/v1/netsuite/product-developers
 *  PUT   /api/v1/netsuite/product-developers/:nsId
 *  PATCH /api/v1/netsuite/product-developers/:nsId/status
 *
 * Body for POST/PUT:
 *  { "netsuiteInternalId": "456", "name": "Jane Smith" }
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../config/database.js';
import { productDevelopers } from '../../../db/schema/index.js';
import { NotFoundError } from '../../../utils/errors.js';
import { invalidateDropdown } from '../../../utils/cache.js';

const CreateSchema = z.object({
  netsuiteInternalId: z.string().min(1),
  name: z.string().min(1).max(255),
});

const UpdateSchema = CreateSchema.omit({ netsuiteInternalId: true }).partial();
const StatusSchema = z.object({ isActive: z.boolean() });

export default async function productDeveloperRoutes(app: FastifyInstance) {

  app.get('/', async () =>
    getDb().select().from(productDevelopers).where(eq(productDevelopers.isActive, true)).orderBy(productDevelopers.name),
  );

  app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
    const [row] = await getDb().select().from(productDevelopers)
      .where(eq(productDevelopers.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!row) throw new NotFoundError('ProductDeveloper', req.params.nsId);
    return row;
  });

  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: productDevelopers.id }).from(productDevelopers)
      .where(eq(productDevelopers.netsuiteInternalId, body.netsuiteInternalId)).limit(1);
    if (existing) {
      const [upd] = await db.update(productDevelopers)
        .set({ name: body.name, updatedAt: new Date() })
        .where(eq(productDevelopers.id, existing.id)).returning();
      await invalidateDropdown('product_developers');
      return reply.status(200).send({ ...upd, _action: 'updated' });
    }
    const [created] = await db.insert(productDevelopers)
      .values({ ...body, source: 'netsuite', syncStatus: 'synced', syncedAt: new Date() }).returning();
    await invalidateDropdown('product_developers');
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: productDevelopers.id }).from(productDevelopers)
      .where(eq(productDevelopers.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('ProductDeveloper', req.params.nsId);
    const [updated] = await db.update(productDevelopers)
      .set({ ...body, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(productDevelopers.id, existing.id)).returning();
    await invalidateDropdown('product_developers');
    return updated;
  });

  app.patch<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
    const { isActive } = StatusSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: productDevelopers.id }).from(productDevelopers)
      .where(eq(productDevelopers.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('ProductDeveloper', req.params.nsId);
    const [updated] = await db.update(productDevelopers)
      .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(productDevelopers.id, existing.id))
      .returning({ id: productDevelopers.id, netsuiteInternalId: productDevelopers.netsuiteInternalId, isActive: productDevelopers.isActive });
    await invalidateDropdown('product_developers');
    return updated;
  });
}
