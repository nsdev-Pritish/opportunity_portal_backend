import { eq, and, desc, asc, like, or, count, isNull } from 'drizzle-orm';
import { getDb } from '../config/database.js';
import {
  estimates, estimateLineItems, estimateFreightGroups,
  customers,
} from '../db/schema/index.js';
import { cacheDel, CacheKeys } from '../utils/cache.js';
import { NotFoundError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { syncEstimateToNetsuite } from './netsuiteSync.service.js';

type RawLineItem = Record<string, unknown> & { components?: Record<string, unknown>[] };

const CHUNK = 100;

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

// ── Get single (with nested line items) ─────────────────────────────────────

export async function getEstimate(id: number) {
  const db = getDb();
  const [row] = await db.select()
    .from(estimates)
    .leftJoin(customers, eq(estimates.customerId, customers.id))
    .where(and(eq(estimates.id, id), eq(estimates.isActive, true)))
    .limit(1);

  if (!row) throw new NotFoundError('Estimate', id);

  const [allLineItemRows, freightGroups] = await Promise.all([
    db.select()
      .from(estimateLineItems)
      .where(eq(estimateLineItems.estimateId, id))
      .orderBy(asc(estimateLineItems.lineNumber), asc(estimateLineItems.sortOrder)),
    db.select()
      .from(estimateFreightGroups)
      .where(eq(estimateFreightGroups.estimateId, id))
      .orderBy(asc(estimateFreightGroups.sortOrder)),
  ]);

  // Nest components under their parent
  const componentMap: Record<number, typeof allLineItemRows> = {};
  for (const r of allLineItemRows) {
    if (r.parentLineItemId !== null) {
      (componentMap[r.parentLineItemId!] ??= []).push(r);
    }
  }

  const lineItems = allLineItemRows
    .filter(r => r.parentLineItemId === null)
    .map(p => ({ ...p, components: componentMap[p.id] ?? [] }));

  return {
    ...row.estimates,
    customer: row.customers,
    lineItems,
    freightGroups,
  };
}

// ── Internal: two-pass insert (parents → components) ─────────────────────────

async function insertLineItemsWithComponents(
  tx: any,
  estimateId: number,
  items: RawLineItem[],
): Promise<{ parents: any[]; components: any[] }> {
  if (items.length === 0) return { parents: [], components: [] };

  // Pass 1: insert parent rows
  const parentValues = items.map((item, i) => {
    const { components: _c, ...rest } = item;
    return { ...rest, estimateId, lineNumber: i + 1, parentLineItemId: null, sortOrder: i };
  });

  const parents: any[] = [];
  for (let i = 0; i < parentValues.length; i += CHUNK) {
    const rows = await tx.insert(estimateLineItems)
      .values(parentValues.slice(i, i + CHUNK) as any)
      .returning();
    parents.push(...rows);
  }

  // Pass 2: insert components referencing their parent's DB id
  const componentValues: any[] = [];
  for (let i = 0; i < items.length; i++) {
    const comps = items[i].components ?? [];
    for (let j = 0; j < comps.length; j++) {
      componentValues.push({
        ...comps[j],
        estimateId,
        lineNumber: 0,
        parentLineItemId: parents[i].id,
        sortOrder: j,
      });
    }
  }

  const components: any[] = [];
  for (let i = 0; i < componentValues.length; i += CHUNK) {
    const rows = await tx.insert(estimateLineItems)
      .values(componentValues.slice(i, i + CHUNK) as any)
      .returning();
    components.push(...rows);
  }

  return { parents, components };
}

// ── Create estimate + cost sheet items atomically ───────────────────────────

export async function createEstimateWithItems(
  headerData: Record<string, unknown>,
  lineItems: RawLineItem[],
  freightGroups: Record<string, unknown>[] = [],
) {
  const db = getDb();
  const startTime = Date.now();
  logger.info({ itemCount: lineItems.length, groupCount: freightGroups.length }, 'Creating estimate with line items and freight groups');

  return db.transaction(async (tx) => {
    // 1. Insert estimate header
    const [estimate] = await tx.insert(estimates)
      .values({ ...headerData, source: 'portal', syncStatus: 'pending' } as any)
      .returning();

    // 2. Insert line items (parents first, then components)
    const { parents, components } = await insertLineItemsWithComponents(tx, estimate.id, lineItems);

    // 3. Insert freight groups
    const insertedGroups: any[] = [];
    if (freightGroups.length > 0) {
      const groupRows = freightGroups.map((g, idx) => ({
        ...g,
        estimateId: estimate.id,
        sortOrder: (g.sortOrder as number) ?? idx + 1,
        groupName: (g.groupName as string) ?? `Group ${idx + 1}`,
      }));
      for (let i = 0; i < groupRows.length; i += CHUNK) {
        const rows = await tx.insert(estimateFreightGroups).values(groupRows.slice(i, i + CHUNK) as any).returning();
        insertedGroups.push(...rows);
      }
    }

    const duration = Date.now() - startTime;
    logger.info(
      { estimateId: estimate.id, parentCount: parents.length, componentCount: components.length, groupCount: insertedGroups.length, durationMs: duration },
      'Estimate created',
    );

    return {
      estimate,
      lineItems: [...parents, ...components],
      freightGroups: insertedGroups,
      summary: { totalItems: parents.length, totalComponents: components.length, totalFreightGroups: insertedGroups.length },
    };
  }).then(async (result) => {
    await syncEstimateToNetsuite(result.estimate.id, 'create');
    return result;
  });
}

// ── Update header; optionally replace all line items atomically ─────────────

export async function updateEstimateWithItems(
  id: number,
  headerData: Record<string, unknown>,
  newLineItems?: RawLineItem[],
  newFreightGroups?: Record<string, unknown>[],
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

    // 2. Replace line items if provided
    let allLineItems: any[];
    if (newLineItems !== undefined) {
      // Delete all existing (cascade removes components automatically)
      await tx.delete(estimateLineItems).where(eq(estimateLineItems.estimateId, id));

      const { parents, components } = await insertLineItemsWithComponents(tx, id, newLineItems);
      allLineItems = [...parents, ...components];
    } else {
      allLineItems = await tx.select()
        .from(estimateLineItems)
        .where(eq(estimateLineItems.estimateId, id))
        .orderBy(asc(estimateLineItems.lineNumber), asc(estimateLineItems.sortOrder));
    }

    // 3. Replace freight groups if provided
    let freightGroups: any[];
    if (newFreightGroups !== undefined) {
      await tx.delete(estimateFreightGroups).where(eq(estimateFreightGroups.estimateId, id));

      freightGroups = [];
      if (newFreightGroups.length > 0) {
        const groupRows = newFreightGroups.map((g, idx) => ({
          ...g,
          estimateId: id,
          sortOrder: (g.sortOrder as number) ?? idx + 1,
          groupName: (g.groupName as string) ?? `Group ${idx + 1}`,
          updatedAt: new Date(),
        }));
        for (let i = 0; i < groupRows.length; i += CHUNK) {
          const rows = await tx.insert(estimateFreightGroups).values(groupRows.slice(i, i + CHUNK) as any).returning();
          freightGroups.push(...rows);
        }
      }
    } else {
      freightGroups = await tx.select()
        .from(estimateFreightGroups)
        .where(eq(estimateFreightGroups.estimateId, id))
        .orderBy(asc(estimateFreightGroups.sortOrder));
    }

    return { estimate: updated, lineItems: allLineItems, freightGroups };
  });

  await cacheDel(CacheKeys.estimate(id));

  const duration = Date.now() - startTime;
  logger.info(
    {
      estimateId: id,
      itemCount: result.lineItems.length,
      groupCount: result.freightGroups.length,
      replacedItems: newLineItems !== undefined,
      replacedGroups: newFreightGroups !== undefined,
      durationMs: duration,
    },
    'Estimate updated',
  );

  await syncEstimateToNetsuite(id, 'update');

  return {
    ...result,
    summary: { totalItems: result.lineItems.length, totalFreightGroups: result.freightGroups.length },
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
