/**
 * LINE ITEM (COST SHEET ROW) APIs
 *
 *  POST   /api/v1/netsuite/estimates/:nsId/line-items          → add one row
 *  POST   /api/v1/netsuite/estimates/:nsId/line-items/bulk     → add many rows (up to 400)
 *  PUT    /api/v1/netsuite/estimates/:nsId/line-items/:itemNsId → update a row
 *  DELETE /api/v1/netsuite/estimates/:nsId/line-items/:itemNsId → remove a row
 *  GET    /api/v1/netsuite/estimates/:nsId/line-items          → list all rows
 */

import { FastifyInstance } from 'fastify';
import { eq, and, asc, desc } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../config/database.js';
import { estimates, estimateLineItems } from '../../db/schema/index.js';
import { NotFoundError } from '../../utils/errors.js';

// ─── Validation ───────────────────────────────────────────────────

const LineItemSchema = z.object({
  netsuiteInternalId  : z.string().optional().nullable(),  // NS internalId of this line
  itemTypeId          : z.number().int().optional().nullable(),
  shortDescription    : z.string().max(500).optional().nullable(),
  vendorId            : z.number().int().optional().nullable(),
  quantity            : z.string().optional().nullable(),
  sellPricePerUnit    : z.string().optional().nullable(),
  description         : z.string().optional().nullable(),
  factoryId           : z.number().int().optional().nullable(),
  vendorCurrencyId    : z.number().int().optional().nullable(),
  factoryCostPerUnit  : z.string().optional().nullable(),
  packingCostPerUnit  : z.string().optional().nullable(),
  sampleFees          : z.string().optional().nullable(),
  otherPerUnit        : z.string().optional().nullable(),
  freightPerUnit      : z.string().optional().nullable(),
  dutyPct             : z.string().optional().nullable(),
  tariffPct           : z.string().optional().nullable(),
  tariffMuPct         : z.string().optional().nullable(),
  otherCostPct        : z.string().optional().nullable(),
  paddingPct          : z.string().optional().nullable(),
  productClassId      : z.number().int().optional().nullable(),
  sustainabilityId    : z.number().int().optional().nullable(),
  htsCode             : z.string().max(20).optional().nullable(),
  countryOfOrigin     : z.string().max(100).optional().nullable(),
  countryOfDest       : z.enum(['US','EU']).optional(),
  unitsPerCarton      : z.number().int().optional().nullable(),
  dimLCm              : z.string().optional().nullable(),
  dimWCm              : z.string().optional().nullable(),
  dimHCm              : z.string().optional().nullable(),
  weightKgPerCarton   : z.string().optional().nullable(),
  shippingGroupId     : z.number().int().optional().nullable(),
  exFactoryDate       : z.string().optional().nullable(),
  vendorIncotermsId   : z.number().int().optional().nullable(),
  shipToVendorId      : z.number().int().optional().nullable(),
  notes               : z.string().optional().nullable(),
  exclude             : z.boolean().optional(),
  pickupExwFob        : z.string().optional().nullable(),
  oceanDdp            : z.string().optional().nullable(),
  airDdp              : z.string().optional().nullable(),
});

// ─── Helper: find estimate by NS id ──────────────────────────────

async function getEstimateByNsId(nsId: string) {
  const db = getDb();
  const [est] = await db.select({ id: estimates.id }).from(estimates)
    .where(eq(estimates.netsuiteInternalId, nsId)).limit(1);
  if (!est) throw new NotFoundError('Estimate', nsId);
  return est;
}

// ─── Helper: next available line number ──────────────────────────

async function getNextLineNumber(estimateId: number): Promise<number> {
  const db = getDb();
  const [last] = await db
    .select({ lineNumber: estimateLineItems.lineNumber })
    .from(estimateLineItems)
    .where(eq(estimateLineItems.estimateId, estimateId))
    .orderBy(desc(estimateLineItems.lineNumber))
    .limit(1);
  return last ? last.lineNumber + 1 : 1;
}

// ─── Route handlers ───────────────────────────────────────────────

export default async function lineItemNsRoutes(app: FastifyInstance) {

  // ── GET /api/v1/netsuite/estimates/:nsId/line-items ────────────
  app.get<{ Params: { nsId: string } }>('/', async (req) => {
    const est = await getEstimateByNsId(req.params.nsId);
    return getDb()
      .select()
      .from(estimateLineItems)
      .where(eq(estimateLineItems.estimateId, est.id))
      .orderBy(asc(estimateLineItems.lineNumber));
  });

  // ── POST /api/v1/netsuite/estimates/:nsId/line-items ──────────
  // Add ONE cost sheet row.
  //
  // Example body:
  // {
  //   "netsuiteInternalId": "EST-001_L1",
  //   "shortDescription": "Custom Tote Bag",
  //   "vendorId": 5,
  //   "quantity": "1000",
  //   "sellPricePerUnit": "12.50",
  //   "factoryCostPerUnit": "4.20",
  //   "tariffPct": "10",
  //   "countryOfOrigin": "China"
  // }
  app.post<{ Params: { nsId: string }; Body: unknown }>('/', async (req, reply) => {
    const body = LineItemSchema.parse(req.body);
    const db = getDb();
    const est = await getEstimateByNsId(req.params.nsId);
    const lineNumber = await getNextLineNumber(est.id);
    const [item] = await db.insert(estimateLineItems)
      .values({ ...body, estimateId: est.id, lineNumber })
      .returning();
    return reply.status(201).send(item);
  });

  // ── POST /api/v1/netsuite/estimates/:nsId/line-items/bulk ──────
  // Add MANY rows at once (up to 400).
  //
  // Body: { "items": [ { row1 }, { row2 }, ... ] }
  app.post<{ Params: { nsId: string }; Body: { items: unknown[] } }>('/bulk', async (req, reply) => {
    const { items } = z.object({ items: z.array(LineItemSchema).max(400) }).parse(req.body);
    const db = getDb();
    const est = await getEstimateByNsId(req.params.nsId);
    let lineNumber = await getNextLineNumber(est.id);

    const insertedIds: number[] = [];
    const CHUNK = 100; // insert 100 at a time

    for (let i = 0; i < items.length; i += CHUNK) {
      const chunk = items.slice(i, i + CHUNK).map((item, offset) => ({
        ...item,
        estimateId : est.id,
        lineNumber : lineNumber + offset,
      }));
      lineNumber += chunk.length;
      const rows = await db.insert(estimateLineItems).values(chunk)
        .returning({ id: estimateLineItems.id });
      insertedIds.push(...rows.map((r) => r.id));
    }

    return reply.status(201).send({ inserted: insertedIds.length, estimatePortalId: est.id });
  });

  // ── PUT /api/v1/netsuite/estimates/:nsId/line-items/:itemNsId ─
  // Update a specific line item by its NS internalId.
  app.put<{ Params: { nsId: string; itemNsId: string }; Body: unknown }>('/:itemNsId', async (req) => {
    const body = LineItemSchema.partial().parse(req.body);
    const db = getDb();
    const est = await getEstimateByNsId(req.params.nsId);
    const [item] = await db.select({ id: estimateLineItems.id })
      .from(estimateLineItems)
      .where(and(
        eq(estimateLineItems.estimateId, est.id),
        eq(estimateLineItems.netsuiteInternalId, req.params.itemNsId),
      )).limit(1);
    if (!item) throw new NotFoundError('LineItem', req.params.itemNsId);
    const [updated] = await db.update(estimateLineItems)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(estimateLineItems.id, item.id))
      .returning();
    return updated;
  });

  // ── DELETE /api/v1/netsuite/estimates/:nsId/line-items/:itemNsId
  // Soft delete — sets exclude=true. Row is kept in DB.
  app.delete<{ Params: { nsId: string; itemNsId: string } }>('/:itemNsId', async (req) => {
    const db = getDb();
    const est = await getEstimateByNsId(req.params.nsId);
    await db.update(estimateLineItems)
      .set({ exclude: true, updatedAt: new Date() })
      .where(and(
        eq(estimateLineItems.estimateId, est.id),
        eq(estimateLineItems.netsuiteInternalId, req.params.itemNsId),
      ));
    return { deleted: true };
  });
}
