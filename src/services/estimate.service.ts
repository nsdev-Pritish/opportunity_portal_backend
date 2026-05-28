import { eq, and, desc, asc, like, ilike, or, count, isNull, gte, lte, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { getDb } from '../config/database.js';
import {
  estimates, estimateLineItems, estimateFreightGroups,
  customers, departments, businessVerticals, accountManagers,
  likelyToClose, opsPartners, productDevelopers,
} from '../db/schema/index.js';
import { cacheDel, CacheKeys } from '../utils/cache.js';
import { NotFoundError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { syncEstimateToNetsuite } from './netsuiteSync.service.js';

type RawLineItem = Record<string, unknown> & { components?: Record<string, unknown>[] };

const CHUNK = 100;

// ── Shared filter helper ─────────────────────────────────────────────────────

type EstimateFilterOpts = {
  customerId?: number;
  customerName?: string;
  salesRepId?: number;
  salesRepName?: string;
  opsPartnerId?: number;
  opsPartnerName?: string;
  businessVerticalId?: number;
  businessVerticalName?: string;
  departmentId?: number;
  departmentName?: string;
  projectNameId?: number;
  projectName?: string;
  statuses?: string[];
  productDeveloperId?: number;
  productDeveloperName?: string;
  likelyToCloseId?: number;
  likelyToCloseName?: string;
  expectedCloseDateFrom?: string;
  expectedCloseDateTo?: string;
  dateOfEntryFrom?: string;
  dateOfEntryTo?: string;
};

function buildConditions(
  opts: EstimateFilterOpts & { estimateId?: number; documentNumber?: string },
  op1: any,
  op2: any,
): any[] {
  const conds: any[] = [eq(estimates.isActive, true)];

  if (opts.estimateId)          conds.push(eq(estimates.id, opts.estimateId));
  if (opts.documentNumber)      conds.push(ilike(estimates.documentNumber!, `%${opts.documentNumber}%`));
  if (opts.customerId)          conds.push(eq(estimates.customerId, opts.customerId));
  if (opts.customerName)        conds.push(ilike(customers.name, `%${opts.customerName}%`));
  if (opts.salesRepId)          conds.push(eq(estimates.acctManagerId, opts.salesRepId));
  if (opts.salesRepName)        conds.push(ilike(accountManagers.name, `%${opts.salesRepName}%`));
  if (opts.opsPartnerId)        conds.push(or(eq(estimates.opsPartner1Id, opts.opsPartnerId), eq(estimates.opsPartner2Id, opts.opsPartnerId))!);
  if (opts.opsPartnerName)      conds.push(or(ilike(op1.name, `%${opts.opsPartnerName}%`), ilike(op2.name, `%${opts.opsPartnerName}%`))!);
  if (opts.businessVerticalId)  conds.push(eq(estimates.businessVerticalId, opts.businessVerticalId));
  if (opts.businessVerticalName) conds.push(ilike(businessVerticals.name, `%${opts.businessVerticalName}%`));
  if (opts.departmentId)        conds.push(eq(estimates.departmentId, opts.departmentId));
  if (opts.departmentName)      conds.push(ilike(departments.name, `%${opts.departmentName}%`));
  if (opts.projectNameId)       conds.push(eq(estimates.projectNameId, opts.projectNameId));
  if (opts.projectName)         conds.push(ilike(estimates.projectName!, `%${opts.projectName}%`));
  if (opts.statuses?.length) {
    conds.push(opts.statuses.length === 1
      ? eq(estimates.status, opts.statuses[0] as any)
      : inArray(estimates.status, opts.statuses as any[]));
  }
  if (opts.productDeveloperId)  conds.push(sql`${opts.productDeveloperId} = ANY(${estimates.productDeveloperIds})`);
  if (opts.productDeveloperName) conds.push(sql`EXISTS (SELECT 1 FROM product_developers pd WHERE pd.id = ANY(${estimates.productDeveloperIds}) AND pd.name ILIKE ${'%' + opts.productDeveloperName + '%'})`);
  if (opts.likelyToCloseId)     conds.push(eq(estimates.likelyToCloseId, opts.likelyToCloseId));
  if (opts.likelyToCloseName)   conds.push(ilike(likelyToClose.name, `%${opts.likelyToCloseName}%`));
  if (opts.expectedCloseDateFrom) conds.push(gte(estimates.expectedCloseDate, opts.expectedCloseDateFrom));
  if (opts.expectedCloseDateTo)   conds.push(lte(estimates.expectedCloseDate, opts.expectedCloseDateTo));
  if (opts.dateOfEntryFrom)     conds.push(gte(estimates.createdAt, new Date(opts.dateOfEntryFrom)));
  if (opts.dateOfEntryTo)       conds.push(lte(estimates.createdAt, new Date(opts.dateOfEntryTo)));

  return conds;
}

function buildBaseQuery(db: ReturnType<typeof getDb>, op1: any, op2: any) {
  return db.select({
    id: estimates.id,
    documentNumber: estimates.documentNumber,
    netsuiteInternalId: estimates.netsuiteInternalId,
    projectNameId: estimates.projectNameId,
    projectName: estimates.projectName,
    status: estimates.status,
    customerPo: estimates.customerPo,
    projectedTotalAmt: estimates.projectedTotalAmt,
    expectedCloseDate: estimates.expectedCloseDate,
    promiseDate: estimates.promiseDate,
    likelyToCloseId: estimates.likelyToCloseId,
    departmentId: estimates.departmentId,
    businessVerticalId: estimates.businessVerticalId,
    opsPartner1Id: estimates.opsPartner1Id,
    opsPartner2Id: estimates.opsPartner2Id,
    acctManagerId: estimates.acctManagerId,
    productDeveloperIds: estimates.productDeveloperIds,
    createdAt: estimates.createdAt,
    updatedAt: estimates.updatedAt,
    customerId: estimates.customerId,
    customerName: customers.name,
    departmentName: departments.name,
    businessVerticalName: businessVerticals.name,
    salesRepName: accountManagers.name,
    likelyToCloseName: likelyToClose.name,
    opsPartner1Name: op1.name,
    opsPartner2Name: op2.name,
  })
    .from(estimates)
    .leftJoin(customers,         eq(estimates.customerId,        customers.id))
    .leftJoin(departments,       eq(estimates.departmentId,      departments.id))
    .leftJoin(businessVerticals, eq(estimates.businessVerticalId, businessVerticals.id))
    .leftJoin(accountManagers,   eq(estimates.acctManagerId,     accountManagers.id))
    .leftJoin(likelyToClose,     eq(estimates.likelyToCloseId,   likelyToClose.id))
    .leftJoin(op1,               eq(estimates.opsPartner1Id,     op1.id))
    .leftJoin(op2,               eq(estimates.opsPartner2Id,     op2.id));
}

function buildCountQuery(db: ReturnType<typeof getDb>, op1: any, op2: any) {
  return db.select({ total: count() })
    .from(estimates)
    .leftJoin(customers,         eq(estimates.customerId,        customers.id))
    .leftJoin(departments,       eq(estimates.departmentId,      departments.id))
    .leftJoin(businessVerticals, eq(estimates.businessVerticalId, businessVerticals.id))
    .leftJoin(accountManagers,   eq(estimates.acctManagerId,     accountManagers.id))
    .leftJoin(likelyToClose,     eq(estimates.likelyToCloseId,   likelyToClose.id))
    .leftJoin(op1,               eq(estimates.opsPartner1Id,     op1.id))
    .leftJoin(op2,               eq(estimates.opsPartner2Id,     op2.id));
}

// ── Document-number dropdown ─────────────────────────────────────────────────

export async function listDocumentNumbers(opts: EstimateFilterOpts) {
  const db = getDb();
  const op1 = alias(opsPartners, 'op1');
  const op2 = alias(opsPartners, 'op2');
  const conds = buildConditions(opts, op1, op2);

  const rows = await db.select({
    id: estimates.id,
    documentNumber: estimates.documentNumber,
    projectName: estimates.projectName,
    customerName: customers.name,
    status: estimates.status,
  })
    .from(estimates)
    .leftJoin(customers,         eq(estimates.customerId,        customers.id))
    .leftJoin(departments,       eq(estimates.departmentId,      departments.id))
    .leftJoin(businessVerticals, eq(estimates.businessVerticalId, businessVerticals.id))
    .leftJoin(accountManagers,   eq(estimates.acctManagerId,     accountManagers.id))
    .leftJoin(likelyToClose,     eq(estimates.likelyToCloseId,   likelyToClose.id))
    .leftJoin(op1,               eq(estimates.opsPartner1Id,     op1.id))
    .leftJoin(op2,               eq(estimates.opsPartner2Id,     op2.id))
    .where(and(...conds))
    .orderBy(asc(estimates.documentNumber), desc(estimates.createdAt))
    .limit(500);

  return rows;
}

// ── Advanced search (all UI filters) ────────────────────────────────────────

export async function searchEstimatesAdvanced(opts: EstimateFilterOpts & {
  page: number;
  limit: number;
  estimateId?: number;
  documentNumber?: string;
}) {
  const db = getDb();
  const op1 = alias(opsPartners, 'op1');
  const op2 = alias(opsPartners, 'op2');
  const offset = (opts.page - 1) * opts.limit;
  const conds = buildConditions(opts, op1, op2);
  const whereClause = and(...conds);

  const [rows, [{ total }]] = await Promise.all([
    buildBaseQuery(db, op1, op2)
      .where(whereClause)
      .orderBy(desc(estimates.updatedAt))
      .limit(opts.limit)
      .offset(offset),
    buildCountQuery(db, op1, op2)
      .where(whereClause),
  ]);

  // Fetch all line items for the returned estimates in one batch query
  const estimateIds = rows.map(r => r.id);
  let lineItemsByEstimate: Record<number, any[]> = {};

  if (estimateIds.length > 0) {
    const allLineItems = await db.select()
      .from(estimateLineItems)
      .where(inArray(estimateLineItems.estimateId, estimateIds))
      .orderBy(asc(estimateLineItems.estimateId), asc(estimateLineItems.lineNumber), asc(estimateLineItems.sortOrder));

    // Nest components under their parent, group by estimateId
    for (const li of allLineItems) {
      if (!lineItemsByEstimate[li.estimateId]) lineItemsByEstimate[li.estimateId] = [];
      if (li.parentLineItemId === null) {
        lineItemsByEstimate[li.estimateId].push({ ...li, components: [] });
      }
    }
    for (const li of allLineItems) {
      if (li.parentLineItemId !== null) {
        const parent = lineItemsByEstimate[li.estimateId]?.find((p: any) => p.id === li.parentLineItemId);
        if (parent) parent.components.push(li);
      }
    }
  }

  const data = rows.map(r => ({ ...r, lineItems: lineItemsByEstimate[r.id] ?? [] }));

  return { data, pagination: { page: opts.page, limit: opts.limit, total: Number(total) } };
}

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
  // Continue lineNumber sequence after parents to satisfy the unique (estimateId, lineNumber) constraint
  let lineCounter = parentValues.length + 1;
  const componentValues: any[] = [];
  for (let i = 0; i < items.length; i++) {
    const comps = items[i].components ?? [];
    for (let j = 0; j < comps.length; j++) {
      componentValues.push({
        ...comps[j],
        estimateId,
        lineNumber: lineCounter++,
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
  logger.info('Creating estimate');

  return db.transaction(async (tx) => {
    // Step 1: Insert estimate header
    const [estimate] = await tx.insert(estimates)
      .values({ ...headerData, source: 'portal', syncStatus: 'pending' } as any)
      .returning();

    // Step 2 – Line items
    const { parents, components } = await insertLineItemsWithComponents(tx, estimate.id, lineItems);

    // Step 3 – Freight groups (Phase 3: uncomment when ready):
    // const insertedGroups: any[] = [];
    // if (freightGroups.length > 0) {
    //   const groupRows = freightGroups.map((g, idx) => ({
    //     ...g,
    //     estimateId: estimate.id,
    //     sortOrder: (g.sortOrder as number) ?? idx + 1,
    //     groupName: (g.groupName as string) ?? `Group ${idx + 1}`,
    //   }));
    //   for (let i = 0; i < groupRows.length; i += CHUNK) {
    //     const rows = await tx.insert(estimateFreightGroups).values(groupRows.slice(i, i + CHUNK) as any).returning();
    //     insertedGroups.push(...rows);
    //   }
    // }

    const duration = Date.now() - startTime;
    logger.info({ estimateId: estimate.id, lineItemCount: parents.length + components.length, durationMs: duration }, 'Estimate created');

    return { estimate, lineItems: [...parents, ...components] };
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

    // Step 2 – Line items
    let allLineItems: any[];
    if (newLineItems !== undefined) {
      await tx.delete(estimateLineItems).where(eq(estimateLineItems.estimateId, id));
      const { parents, components } = await insertLineItemsWithComponents(tx, id, newLineItems);
      allLineItems = [...parents, ...components];
    } else {
      allLineItems = await tx.select()
        .from(estimateLineItems)
        .where(eq(estimateLineItems.estimateId, id))
        .orderBy(asc(estimateLineItems.lineNumber), asc(estimateLineItems.sortOrder));
    }

    // Step 3 – Freight groups (Phase 3: uncomment when ready):
    // if (newFreightGroups !== undefined) {
    //   await tx.delete(estimateFreightGroups).where(eq(estimateFreightGroups.estimateId, id));
    //   const freightGroupRows: any[] = [];
    //   if (newFreightGroups.length > 0) {
    //     const groupRows = newFreightGroups.map((g, idx) => ({
    //       ...g, estimateId: id,
    //       sortOrder: (g.sortOrder as number) ?? idx + 1,
    //       groupName: (g.groupName as string) ?? `Group ${idx + 1}`,
    //       updatedAt: new Date(),
    //     }));
    //     for (let i = 0; i < groupRows.length; i += CHUNK) {
    //       const rows = await tx.insert(estimateFreightGroups).values(groupRows.slice(i, i + CHUNK) as any).returning();
    //       freightGroupRows.push(...rows);
    //     }
    //   }
    // }

    return { estimate: updated, lineItems: allLineItems };
  });

  await cacheDel(CacheKeys.estimate(id));

  const duration = Date.now() - startTime;
  logger.info({ estimateId: id, durationMs: duration }, 'Estimate updated');

  await syncEstimateToNetsuite(id, 'update');

  return result;
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
