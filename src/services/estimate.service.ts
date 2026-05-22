import { eq, and, desc, asc, like, or, count } from 'drizzle-orm';
import { getDb } from '../config/database.js';
import {
  estimates, estimateLineItems,
  customers,
} from '../db/schema/index.js';
import { cacheDel, CacheKeys } from '../utils/cache.js';
import { NotFoundError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

// ── List ────────────────────────────────────────────────────────────────────

export async function listEstimates(opts: {
  page: number;
  limit: number;
  search?: string;
  status?: string;
  customerId?: number;
}) {
  const db = getDb();
  const offset = (opts.page - 1) * opts.limit;
  const conditions: any[] = [eq(estimates.isActive, true)];
  if (opts.status)     conditions.push(eq(estimates.status, opts.status as any));
  if (opts.customerId) conditions.push(eq(estimates.customerId, opts.customerId));
  if (opts.search)     conditions.push(or(
    like(estimates.projectName, `%${opts.search}%`),
    like(estimates.customerPo, `%${opts.search}%`),
  )!);

  const [rows, [{ total }]] = await Promise.all([
    db.select({
      id: estimates.id,
      netsuiteInternalId: estimates.netsuiteInternalId,
      projectNameId: estimates.projectNameId,
      projectName: estimates.projectName,
      status: estimates.status,
      customerPo: estimates.customerPo,
      projectedTotalAmt: estimates.projectedTotalAmt,
      expectedCloseDate: estimates.expectedCloseDate,
      createdAt: estimates.createdAt,
      updatedAt: estimates.updatedAt,
      customerName: customers.name,
    })
      .from(estimates)
      .leftJoin(customers, eq(estimates.customerId, customers.id))
      .where(and(...conditions))
      .orderBy(desc(estimates.updatedAt))
      .limit(opts.limit)
      .offset(offset),
    db.select({ total: count() }).from(estimates).where(and(...conditions)),
  ]);

  return { data: rows, pagination: { page: opts.page, limit: opts.limit, total: Number(total) } };
}

// ── Get single (with line items) ────────────────────────────────────────────

export async function getEstimate(id: number) {
  const db = getDb();
  const [row] = await db.select()
    .from(estimates)
    .leftJoin(customers, eq(estimates.customerId, customers.id))
    .where(and(eq(estimates.id, id), eq(estimates.isActive, true)))
    .limit(1);

  if (!row) throw new NotFoundError('Estimate', id);

  const lineItems = await db.select()
    .from(estimateLineItems)
    .where(eq(estimateLineItems.estimateId, id))
    .orderBy(asc(estimateLineItems.lineNumber));

  return {
    ...row.estimates,
    customer: row.customers,
    lineItems,
  };
}

// ── Create estimate + cost sheet items atomically ───────────────────────────

export async function createEstimateWithItems(
  headerData: Record<string, unknown>,
  lineItems: Record<string, unknown>[],
) {
  const db = getDb();
  const startTime = Date.now();
  logger.info({ itemCount: lineItems.length }, 'Creating estimate with line items');

  return db.transaction(async (tx) => {
    // 1. Insert estimate header
    const [estimate] = await tx.insert(estimates)
      .values({ ...headerData, source: 'portal', syncStatus: 'pending' } as any)
      .returning();

    // 2. Bulk insert line items in chunks of 100
    const inserted: any[] = [];
    if (lineItems.length > 0) {
      const CHUNK = 100;
      for (let i = 0; i < lineItems.length; i += CHUNK) {
        const chunk = lineItems.slice(i, i + CHUNK).map((item, offset) => ({
          ...item,
          estimateId: estimate.id,
          lineNumber: i + offset + 1,
        }));
        const rows = await tx.insert(estimateLineItems).values(chunk as any).returning();
        inserted.push(...rows);
      }
    }

    const duration = Date.now() - startTime;
    logger.info(
      { estimateId: estimate.id, itemCount: inserted.length, durationMs: duration },
      'Estimate created',
    );

    return {
      estimate,
      lineItems: inserted,
      summary: { totalItems: inserted.length },
    };
  });
}

// ── Update header; optionally replace all line items atomically ─────────────

export async function updateEstimateWithItems(
  id: number,
  headerData: Record<string, unknown>,
  newLineItems?: Record<string, unknown>[],
) {
  const db = getDb();
  const startTime = Date.now();

  const result = await db.transaction(async (tx) => {
    // 1. Update estimate header
    const [updated] = await tx.update(estimates)
      .set({ ...headerData as any, syncStatus: 'dirty', updatedAt: new Date() })
      .where(and(eq(estimates.id, id), eq(estimates.isActive, true)))
      .returning();

    if (!updated) throw new NotFoundError('Estimate', id);

    // 2. If lineItems provided → hard-replace the entire cost sheet atomically
    let lineItems: any[];
    if (newLineItems !== undefined) {
      await tx.delete(estimateLineItems).where(eq(estimateLineItems.estimateId, id));

      lineItems = [];
      if (newLineItems.length > 0) {
        const CHUNK = 100;
        for (let i = 0; i < newLineItems.length; i += CHUNK) {
          const chunk = newLineItems.slice(i, i + CHUNK).map((item, offset) => ({
            ...item,
            estimateId: id,
            lineNumber: i + offset + 1,
          }));
          const rows = await tx.insert(estimateLineItems).values(chunk as any).returning();
          lineItems.push(...rows);
        }
      }
    } else {
      // Return existing items unchanged
      lineItems = await tx.select()
        .from(estimateLineItems)
        .where(eq(estimateLineItems.estimateId, id))
        .orderBy(asc(estimateLineItems.lineNumber));
    }

    return { estimate: updated, lineItems };
  });

  await cacheDel(CacheKeys.estimate(id));

  const duration = Date.now() - startTime;
  logger.info(
    { estimateId: id, itemCount: result.lineItems.length, replaced: newLineItems !== undefined, durationMs: duration },
    'Estimate updated',
  );

  return {
    ...result,
    summary: { totalItems: result.lineItems.length },
  };
}

// ── Deactivate ───────────────────────────────────────────────────────────────

export async function deactivateEstimate(id: number) {
  const db = getDb();
  await db.update(estimates)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(estimates.id, id));
  await cacheDel(CacheKeys.estimate(id));
  return { id, isActive: false };
}
