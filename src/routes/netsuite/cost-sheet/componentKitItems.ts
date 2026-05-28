/**
 * COST SHEET — COMPONENT KIT ITEMS APIs
 *
 *  GET   /api/v1/netsuite/cost-sheet/component-kit-items
 *  GET   /api/v1/netsuite/cost-sheet/component-kit-items/:nsId
 *  POST  /api/v1/netsuite/cost-sheet/component-kit-items
 *  PUT   /api/v1/netsuite/cost-sheet/component-kit-items/:nsId
 *  PUT   /api/v1/netsuite/cost-sheet/component-kit-items/:nsId/status
 *
 * Body for POST/PUT:
 *  { "netsuiteInternalId": "1", "name": "Component Kit Item Name" }
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../config/database.js';
import { componentKitItems } from '../../../db/schema/index.js';
import { NotFoundError } from '../../../utils/errors.js';
import { invalidateDropdown } from '../../../utils/cache.js';

const CreateSchema = z.object({
  netsuiteInternalId: z.string().min(1),
  name              : z.string().min(1).max(255),
});

const UpdateSchema = CreateSchema.omit({ netsuiteInternalId: true }).partial();
const StatusSchema = z.object({ isActive: z.boolean() });

export default async function componentKitItemRoutes(app: FastifyInstance) {

  app.get('/', async () =>
    getDb().select().from(componentKitItems).where(eq(componentKitItems.isActive, true)).orderBy(componentKitItems.name),
  );

  app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
    const [row] = await getDb().select().from(componentKitItems)
      .where(eq(componentKitItems.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!row) throw new NotFoundError('ComponentKitItem', req.params.nsId);
    return row;
  });

  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateSchema.parse(req.body);
    const db = getDb();

    const [existing] = await db.select({ id: componentKitItems.id }).from(componentKitItems)
      .where(eq(componentKitItems.netsuiteInternalId, body.netsuiteInternalId)).limit(1);

    if (existing) {
      const [upd] = await db.update(componentKitItems)
        .set({ name: body.name, updatedAt: new Date() })
        .where(eq(componentKitItems.id, existing.id)).returning();
      await invalidateDropdown('component_kit_items');
      return reply.status(200).send({ ...upd, _action: 'updated' });
    }

    const [created] = await db.insert(componentKitItems).values({
      netsuiteInternalId: body.netsuiteInternalId,
      name              : body.name,
      source            : 'netsuite',
      syncStatus        : 'synced',
      syncedAt          : new Date(),
    }).returning();
    await invalidateDropdown('component_kit_items');
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: componentKitItems.id }).from(componentKitItems)
      .where(eq(componentKitItems.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('ComponentKitItem', req.params.nsId);
    const [updated] = await db.update(componentKitItems)
      .set({ ...body, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(componentKitItems.id, existing.id)).returning();
    await invalidateDropdown('component_kit_items');
    return updated;
  });

  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
    const { isActive } = StatusSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: componentKitItems.id }).from(componentKitItems)
      .where(eq(componentKitItems.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('ComponentKitItem', req.params.nsId);
    const [updated] = await db.update(componentKitItems)
      .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(componentKitItems.id, existing.id))
      .returning({ id: componentKitItems.id, netsuiteInternalId: componentKitItems.netsuiteInternalId, isActive: componentKitItems.isActive });
    await invalidateDropdown('component_kit_items');
    return updated;
  });
}
