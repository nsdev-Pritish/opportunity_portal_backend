/**
 * COST SHEET — ITEM TYPE APIs
 *
 *  GET   /api/v1/netsuite/cost-sheet/items             → list all active items
 *  GET   /api/v1/netsuite/cost-sheet/items/:nsId       → single item by NS ID
 *  POST  /api/v1/netsuite/cost-sheet/items             → create / upsert item
 *  PUT   /api/v1/netsuite/cost-sheet/items/:nsId       → update item
 *  PUT   /api/v1/netsuite/cost-sheet/items/:nsId/status → activate / deactivate
 *
 * POST/PUT body:
 * {
 *   "netsuiteInternalId": "101",
 *   "itemName": "FEE-001",
 *   "NSsubsidiary": "3",
 *   "isFeeItem": true,
 *   "NScurrency": "12"
 * }
 */

import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../config/database.js';
import { csItems, subsidiaries, currencies } from '../../../db/schema/index.js';
import { NotFoundError } from '../../../utils/errors.js';
import { invalidateDropdown } from '../../../utils/cache.js';

const CreateSchema = z.object({
  netsuiteInternalId : z.string().min(1),
  itemName           : z.string().min(1).max(255),
  NSsubsidiary       : z.string().optional().nullable(),
  isFeeItem          : z.boolean().default(false),
  NScurrency         : z.string().optional().nullable(),
});

const UpdateSchema = CreateSchema.omit({ netsuiteInternalId: true }).partial();
const StatusSchema = z.object({ isActive: z.boolean() });

async function resolveFks(
  db: ReturnType<typeof getDb>,
  body: { NSsubsidiary?: string | null; NScurrency?: string | null },
) {
  let subsidiaryId: number | null = null;
  let currencyId: number | null = null;

  if (body.NSsubsidiary) {
    const [sub] = await db.select({ id: subsidiaries.id }).from(subsidiaries)
      .where(eq(subsidiaries.netsuiteInternalId, body.NSsubsidiary)).limit(1);
    subsidiaryId = sub?.id ?? null;
  }

  if (body.NScurrency) {
    const [cur] = await db.select({ id: currencies.id }).from(currencies)
      .where(eq(currencies.netsuiteInternalId, body.NScurrency)).limit(1);
    currencyId = cur?.id ?? null;
  }

  return { subsidiaryId, currencyId };
}

export default async function csItemRoutes(app: FastifyInstance) {

  // GET /  — list all active items with resolved subsidiary and currency NS IDs
  app.get('/', async () =>
    getDb().select().from(csItems).where(eq(csItems.isActive, true)).orderBy(csItems.itemName),
  );

  // GET /:nsId  — single item
  app.get<{ Params: { nsId: string } }>('/:nsId', async (req) => {
    const [row] = await getDb().select().from(csItems)
      .where(eq(csItems.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!row) throw new NotFoundError('CsItem', req.params.nsId);
    return row;
  });

  // POST /  — create or upsert
  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = CreateSchema.parse(req.body);
    const db = getDb();
    const { subsidiaryId, currencyId } = await resolveFks(db, body);

    const [existing] = await db.select({ id: csItems.id }).from(csItems)
      .where(eq(csItems.netsuiteInternalId, body.netsuiteInternalId)).limit(1);

    if (existing) {
      const [upd] = await db.update(csItems)
        .set({
          itemName     : body.itemName,
          subsidiaryId,
          isFeeItem    : body.isFeeItem ?? false,
          currencyId,
          syncStatus   : 'synced',
          syncedAt     : new Date(),
          updatedAt    : new Date(),
        })
        .where(eq(csItems.id, existing.id)).returning();
      await invalidateDropdown('cs_items');
      return reply.status(200).send({ ...upd, _action: 'updated' });
    }

    const [created] = await db.insert(csItems).values({
      netsuiteInternalId : body.netsuiteInternalId,
      itemName           : body.itemName,
      subsidiaryId,
      isFeeItem          : body.isFeeItem ?? false,
      currencyId,
      source             : 'netsuite',
      syncStatus         : 'synced',
      syncedAt           : new Date(),
    }).returning();
    await invalidateDropdown('cs_items');
    return reply.status(201).send({ ...created, _action: 'created' });
  });

  // PUT /:nsId  — update item
  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId', async (req) => {
    const body = UpdateSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: csItems.id }).from(csItems)
      .where(eq(csItems.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('CsItem', req.params.nsId);

    const { subsidiaryId, currencyId } = await resolveFks(db, body);

    const [updated] = await db.update(csItems)
      .set({
        itemName     : body.itemName,
        subsidiaryId : body.NSsubsidiary !== undefined ? subsidiaryId : undefined,
        isFeeItem    : body.isFeeItem,
        currencyId   : body.NScurrency !== undefined ? currencyId : undefined,
        syncStatus   : 'synced',
        syncedAt     : new Date(),
        updatedAt    : new Date(),
      })
      .where(eq(csItems.id, existing.id)).returning();
    await invalidateDropdown('cs_items');
    return updated;
  });

  // PUT /:nsId/status  — activate / deactivate
  app.put<{ Params: { nsId: string }; Body: unknown }>('/:nsId/status', async (req) => {
    const { isActive } = StatusSchema.parse(req.body);
    const db = getDb();
    const [existing] = await db.select({ id: csItems.id }).from(csItems)
      .where(eq(csItems.netsuiteInternalId, req.params.nsId)).limit(1);
    if (!existing) throw new NotFoundError('CsItem', req.params.nsId);
    const [updated] = await db.update(csItems)
      .set({ isActive, syncStatus: 'synced', syncedAt: new Date(), updatedAt: new Date() })
      .where(eq(csItems.id, existing.id))
      .returning({ id: csItems.id, netsuiteInternalId: csItems.netsuiteInternalId, isActive: csItems.isActive });
    await invalidateDropdown('cs_items');
    return updated;
  });
}
