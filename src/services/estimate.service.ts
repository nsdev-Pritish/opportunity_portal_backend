import { eq, and, desc, asc, like, ilike, or, count, isNull, isNotNull, gte, lte, inArray, sql, getTableColumns } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { getDb } from '../config/database.js';
import {
  estimates, estimateLineItems, estimateFreightGroups, estimateQuotes,
  customers, departments, businessVerticals, accountManagers,
  likelyToClose, opsPartners, productDevelopers,
  projectTypes, currencies, salesChannels, esStatus,
} from '../db/schema/index.js';
import { cacheDel, CacheKeys } from '../utils/cache.js';
import { NotFoundError, AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { syncEstimateToNetsuite, deactivateLinesInNetsuite } from './netsuiteSync.service.js';
import {
  saveCreativeRequests,
  getCreativeRequestsForEstimate,
  getCreativeRequestsForEstimates,
  type CreativeRequestsInput,
  type CreativeRequestResult,
} from './creativeRequest.service.js';

type RawLineItem = Record<string, unknown> & { components?: Record<string, unknown>[] };

const CHUNK = 100;

// ── Shared filter helper ─────────────────────────────────────────────────────

type EstimateFilterOpts = {
  search?: string;                 // general free-text search across visible columns
  customerId?: number[];
  customerName?: string;
  salesRepId?: number[];
  salesRepName?: string;
  opsPartnerId?: number[];
  opsPartnerName?: string;
  businessVerticalId?: number[];
  businessVerticalName?: string;
  departmentId?: number[];
  departmentName?: string;
  projectNameId?: number[];
  projectName?: string;
  statuses?: string[];
  productDeveloperId?: number[];
  productDeveloperName?: string;
  likelyToCloseId?: number[];
  likelyToCloseName?: string;
  esStatusId?: number[];
  expectedCloseDateFrom?: string;
  expectedCloseDateTo?: string;
  dateOfEntryFrom?: string;
  dateOfEntryTo?: string;
};

function buildConditions(
  opts: EstimateFilterOpts & { estimateId?: number; documentNumber?: string[] },
  op1: any,
  op2: any,
): any[] {
  const conds: any[] = [eq(estimates.isActive, true)];

  // Multi-value filters: single value → eq, multiple → inArray
  const oneOrMany = <T>(col: any, arr: T[]) =>
    arr.length === 1 ? eq(col, arr[0]) : inArray(col, arr);

  if (opts.estimateId)          conds.push(eq(estimates.id, opts.estimateId));
  if (opts.documentNumber?.length) conds.push(oneOrMany(estimates.documentNumber, opts.documentNumber)); // exact match
  if (opts.customerId?.length)  conds.push(oneOrMany(estimates.customerId, opts.customerId));
  if (opts.customerName)        conds.push(ilike(customers.name, `%${opts.customerName}%`));
  if (opts.salesRepId?.length)  conds.push(oneOrMany(estimates.acctManagerId, opts.salesRepId));
  if (opts.salesRepName)        conds.push(ilike(accountManagers.name, `%${opts.salesRepName}%`));
  if (opts.opsPartnerId?.length) conds.push(or(inArray(estimates.opsPartner1Id, opts.opsPartnerId), inArray(estimates.opsPartner2Id, opts.opsPartnerId))!);
  if (opts.opsPartnerName)      conds.push(or(ilike(op1.name, `%${opts.opsPartnerName}%`), ilike(op2.name, `%${opts.opsPartnerName}%`))!);
  if (opts.businessVerticalId?.length) conds.push(oneOrMany(estimates.businessVerticalId, opts.businessVerticalId));
  if (opts.businessVerticalName) conds.push(ilike(businessVerticals.name, `%${opts.businessVerticalName}%`));
  if (opts.departmentId?.length) conds.push(oneOrMany(estimates.departmentId, opts.departmentId));
  if (opts.departmentName)      conds.push(ilike(departments.name, `%${opts.departmentName}%`));
  if (opts.projectNameId?.length) conds.push(oneOrMany(estimates.projectNameId, opts.projectNameId));
  if (opts.projectName)         conds.push(ilike(estimates.projectName!, `%${opts.projectName}%`));
  if (opts.statuses?.length) {
    // The `statuses` param is the ES Status filter — it carries es_status ids and
    // must ONLY match estimates.es_status_id (the es_status lookup table), never the
    // workflow-status text enum. Filtering the enum with a numeric id errors (500).
    const esIds = opts.statuses.map(Number).filter(n => Number.isInteger(n));
    if (esIds.length) conds.push(oneOrMany(estimates.esStatusId, esIds));
  }
  if (opts.productDeveloperId?.length) conds.push(or(...opts.productDeveloperId.map(id => sql`${id} = ANY(${estimates.productDeveloperIds})`))!); // match any of the developers
  if (opts.productDeveloperName) conds.push(sql`EXISTS (SELECT 1 FROM product_developers pd WHERE pd.id = ANY(${estimates.productDeveloperIds}) AND pd.name ILIKE ${'%' + opts.productDeveloperName + '%'})`);
  if (opts.likelyToCloseId?.length) conds.push(oneOrMany(estimates.likelyToCloseId, opts.likelyToCloseId));
  if (opts.likelyToCloseName)   conds.push(ilike(likelyToClose.name, `%${opts.likelyToCloseName}%`));
  if (opts.esStatusId?.length)  conds.push(oneOrMany(estimates.esStatusId, opts.esStatusId));
  if (opts.expectedCloseDateFrom) conds.push(gte(estimates.expectedCloseDate, opts.expectedCloseDateFrom));
  if (opts.expectedCloseDateTo)   conds.push(lte(estimates.expectedCloseDate, opts.expectedCloseDateTo));
  if (opts.dateOfEntryFrom)     conds.push(gte(estimates.createdAt, new Date(opts.dateOfEntryFrom)));
  if (opts.dateOfEntryTo)       conds.push(lte(estimates.createdAt, new Date(opts.dateOfEntryTo)));

  // General search — one box, type anything. The input is split into tokens by
  // COMMA ONLY (spaces are kept, so a multi-word phrase stays one token); a row
  // matches if ANY token is found in ANY column below (text/names, status, and
  // numeric fields cast to text). So "In Progress" matches the whole phrase
  // "In Progress", while "Saks,draft,2354" returns rows matching Saks OR draft OR 2354.
  if (opts.search) {
    const tokens = opts.search.split(',').map(t => t.trim()).filter(Boolean);
    const matchToken = (t: string) => {
      const term = `%${t}%`;
      return or(
        // Whole estimate row cast to text — matches ANY column on the estimates table
        // (document number, project name, PO, status, dates, amounts, flags, memo,
        //  ship_to/bill_to, adjusted_pipeline, and any future column).
        sql`CAST(${estimates} AS TEXT) ILIKE ${term}`,
        // Joined related-table names (NOT on the estimates row — kept explicit)
        ilike(customers.name,            term),
        ilike(departments.name,          term),
        ilike(businessVerticals.name,    term),
        ilike(accountManagers.name,      term),
        ilike(likelyToClose.name,        term),
        ilike(op1.name,                  term),
        ilike(op2.name,                  term),
        ilike(projectTypes.name,         term),
        ilike(currencies.code,           term),
        ilike(salesChannels.name,        term),
        ilike(esStatus.name,             term),   // ES Status name (e.g. "In Progress")
      );
    };
    if (tokens.length) conds.push(or(...tokens.map(matchToken))!);
  }

  return conds;
}

function buildBaseQuery(db: ReturnType<typeof getDb>, op1: any, op2: any) {
  return db.select({
    // Return the full estimate row so search results carry every column the
    // detail endpoint (getEstimate) returns — keeps the two response shapes in
    // sync so no field shows empty in search but populated in detail.
    ...getTableColumns(estimates),
    // Resolved names from the joined lookup tables (kept identical to before).
    projectTypeName: projectTypes.name,
    currencyCode: currencies.code,
    currencyName: currencies.name,
    salesChannelName: salesChannels.name,
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
    .leftJoin(op2,               eq(estimates.opsPartner2Id,     op2.id))
    .leftJoin(projectTypes,      eq(estimates.projectTypeId,     projectTypes.id))
    .leftJoin(currencies,        eq(estimates.sellCurrencyId,    currencies.id))
    .leftJoin(salesChannels,     eq(estimates.salesChannelId,    salesChannels.id))
    .leftJoin(esStatus,          eq(estimates.esStatusId,        esStatus.id));
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
    .leftJoin(op2,               eq(estimates.opsPartner2Id,     op2.id))
    .leftJoin(projectTypes,      eq(estimates.projectTypeId,     projectTypes.id))
    .leftJoin(currencies,        eq(estimates.sellCurrencyId,    currencies.id))
    .leftJoin(salesChannels,     eq(estimates.salesChannelId,    salesChannels.id))
    .leftJoin(esStatus,          eq(estimates.esStatusId,        esStatus.id));
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
    .orderBy(asc(estimates.documentNumber), desc(estimates.createdAt));

  return rows;
}

// ── Advanced search (all UI filters) ────────────────────────────────────────

export async function searchEstimatesAdvanced(opts: EstimateFilterOpts & {
  page: number;
  limit: number;
  estimateId?: number;
  documentNumber?: string[];
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

  // Fetch all line items + freight groups for the returned estimates in batch queries
  const estimateIds = rows.map(r => r.id);
  let lineItemsByEstimate: Record<number, any[]> = {};
  let freightGroupsByEstimate: Record<number, any[]> = {};
  let creativeRequestsByEstimate: Record<number, any[]> = {};

  if (estimateIds.length > 0) {
    const [allLineItems, allFreightGroups, crByEstimate] = await Promise.all([
      db.select()
        .from(estimateLineItems)
        .where(and(
          inArray(estimateLineItems.estimateId, estimateIds),
          eq(estimateLineItems.isActive, true),
        ))
        .orderBy(asc(estimateLineItems.estimateId), asc(estimateLineItems.lineNumber), asc(estimateLineItems.sortOrder)),
      db.select()
        .from(estimateFreightGroups)
        .where(and(
          inArray(estimateFreightGroups.estimateId, estimateIds),
          eq(estimateFreightGroups.isActive, true),
        ))
        .orderBy(asc(estimateFreightGroups.estimateId), asc(estimateFreightGroups.id)),
      // Batched the same way as line items/freight groups above — one query set for the
      // whole page, not one getCreativeRequestsForEstimate() call per row.
      getCreativeRequestsForEstimates(db as any, estimateIds),
    ]);
    creativeRequestsByEstimate = crByEstimate;

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

    // Group freight groups by estimateId
    for (const g of allFreightGroups) {
      (freightGroupsByEstimate[g.estimateId] ??= []).push(g);
    }
  }

  const data = rows.map(r => ({
    ...r,
    lineItems: lineItemsByEstimate[r.id] ?? [],
    freightGroups: freightGroupsByEstimate[r.id] ?? [],
    creativeRequests: creativeRequestsByEstimate[r.id] ?? [],
  }));

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
      statusId: estimates.statusId,
      customerPo: estimates.customerPo,
      projectedTotalAmt: estimates.projectedTotalAmt,
      expectedCloseDate: estimates.expectedCloseDate,
      syncStatus: estimates.syncStatus,
      syncError: estimates.syncError,
      syncedAt: estimates.syncedAt,
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

// ── Resolve portal ID from either portal integer ID or NS internal ID ────────
// Allows routes to accept both /estimates/29 (portal) and /estimates/403846 (NS)

export async function resolveEstimatePortalId(ref: string): Promise<number> {
  const db = getDb();
  const asInt = parseInt(ref, 10);

  // Try portal ID first (fast path — exact PK lookup)
  if (!isNaN(asInt)) {
    const [byPortalId] = await db
      .select({ id: estimates.id })
      .from(estimates)
      .where(and(eq(estimates.id, asInt), eq(estimates.isActive, true)))
      .limit(1);
    if (byPortalId) return byPortalId.id;
  }

  // Fallback: treat ref as NS internal ID string
  const [byNsId] = await db
    .select({ id: estimates.id })
    .from(estimates)
    .where(and(eq(estimates.netsuiteInternalId, ref), eq(estimates.isActive, true)))
    .limit(1);
  if (byNsId) return byNsId.id;

  throw new NotFoundError('Estimate', ref);
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

  const [allLineItemRows, freightGroups, quoteRows, creativeRequests] = await Promise.all([
    db.select()
      .from(estimateLineItems)
      .where(and(
        eq(estimateLineItems.estimateId, id),
        eq(estimateLineItems.isActive, true),
      ))
      .orderBy(asc(estimateLineItems.lineNumber), asc(estimateLineItems.sortOrder)),
    db.select()
      .from(estimateFreightGroups)
      .where(and(
        eq(estimateFreightGroups.estimateId, id),
        eq(estimateFreightGroups.isActive, true),
      ))
      .orderBy(asc(estimateFreightGroups.id)),
    // Every quote this estimate has been converted to, newest first — an estimate holds one
    // per batch of newly-added lines. Rows NetSuite hasn't numbered yet (convert still
    // syncing, or failed) are skipped so the lists never carry nulls.
    db.select({
      quoteNetsuiteInternalId: estimateQuotes.quoteNetsuiteInternalId,
      quoteDocumentNumber    : estimateQuotes.quoteDocumentNumber,
    })
      .from(estimateQuotes)
      .where(and(
        eq(estimateQuotes.estimateId, id),
        isNotNull(estimateQuotes.quoteDocumentNumber),
      ))
      .orderBy(desc(estimateQuotes.createdAt)),
    // Creative requests with their detail row, selected assets, scope of work and
    // attachments. Without this the attachments written during a save were unreadable —
    // the detail endpoint returned nothing about creative requests at all.
    getCreativeRequestsForEstimate(db as any, id),
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
    creativeRequests,
    // Parallel lists in the same order, so index i of one pairs with index i of the other.
    quoteDocumentNumber     : quoteRows.map(q => q.quoteDocumentNumber),
    quoteNetsuiteInternalId : quoteRows.map(q => q.quoteNetsuiteInternalId),
  };
}

// ── Internal: two-pass insert for CREATE (parents → components) ──────────────

async function insertLineItemsWithComponents(
  tx: any,
  estimateId: number,
  items: RawLineItem[],
): Promise<{ parents: any[]; components: any[] }> {
  if (items.length === 0) return { parents: [], components: [] };

  // Flattened line numbering: each parent is immediately followed by its own components,
  // then the next item — e.g. kit(1), comp(2), comp(3), quote(4). This keeps the stored
  // order matching the on-screen structure and makes NetSuite's lineComponentsNS point to
  // the contiguous lines right after the kit (e.g. [2,3]) instead of trailing numbers.
  const parentLineNo: number[] = [];
  const compLineNo: number[][] = [];
  let lineNo = 1;
  for (let i = 0; i < items.length; i++) {
    parentLineNo[i] = lineNo++;
    compLineNo[i] = (items[i].components ?? []).map(() => lineNo++);
  }

  const parentValues = items.map((item, i) => {
    const { components: _c, ...rest } = item;
    return { ...rest, estimateId, lineNumber: parentLineNo[i], parentLineItemId: null, sortOrder: i };
  });

  const parents: any[] = [];
  for (let i = 0; i < parentValues.length; i += CHUNK) {
    const rows = await tx.insert(estimateLineItems)
      .values(parentValues.slice(i, i + CHUNK) as any)
      .returning();
    parents.push(...rows);
  }

  const componentValues: any[] = [];
  for (let i = 0; i < items.length; i++) {
    const comps = items[i].components ?? [];
    for (let j = 0; j < comps.length; j++) {
      componentValues.push({
        ...comps[j],
        estimateId,
        lineNumber: compLineNo[i][j],
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

// ── Internal: persist freight groups + line-item back-references ──────────────
// Position-diff strategy: the Nth incoming group is matched to the Nth EXISTING group
// (ordered by id) and UPDATED in place, so its row id (and created_at) survive the edit.
// Extra incoming groups are INSERTed; surplus existing groups are DELETEd. This preserves
// stable freight-group ids across an update instead of churning them on every save.
//   • matched group (idx < existing) → UPDATE in place (row id preserved)
//   • new group      (idx ≥ existing) → INSERT (fresh id)
//   • surplus group  (existing > incoming) → DELETE
// Position matching assumes the frontend keeps group order and appends new groups at the
// end; a UI that REORDERS groups will shuffle which id maps to which group.
//
// Membership contract: each incoming group.itemIds entry is the 0-based index of a parent
// line item in the request's lineItems array. We translate those indices to the inserted/
// updated DB row ids (via `parents`, which is in lineItems order), store the resolved ids on
// the group, and set freight_group_id on each member line so the link exists both ways.
//
// NOTE: an UPDATE only writes the columns present in the payload (same columns the INSERT
// wrote). The freight edit form sends the full group object, so this is behaviour-identical
// to the old delete+recreate — except the id is now preserved.
async function persistFreightGroups(
  tx: any,
  estimateId: number,
  groups: Record<string, unknown>[] | undefined,
  parents: any[],
): Promise<any[]> {
  // Clear existing membership links; they are re-established below from incoming membership.
  await tx.update(estimateLineItems)
    .set({ freightGroupId: null })
    .where(eq(estimateLineItems.estimateId, estimateId));

  // Existing ACTIVE groups in stable (id) order, for positional matching.
  const existing = await tx
    .select({ id: estimateFreightGroups.id })
    .from(estimateFreightGroups)
    .where(and(
      eq(estimateFreightGroups.estimateId, estimateId),
      eq(estimateFreightGroups.isActive, true),
    ))
    .orderBy(asc(estimateFreightGroups.id));

  if (!groups || groups.length === 0) {
    // No groups sent → soft-delete any active ones (deactivate, keep the rows + ids).
    if (existing.length > 0) {
      await tx.update(estimateFreightGroups)
        .set({ isActive: false, updatedAt: new Date() })
        .where(and(
          eq(estimateFreightGroups.estimateId, estimateId),
          eq(estimateFreightGroups.isActive, true),
        ));
    }
    return [];
  }

  const persisted: any[] = [];
  for (let idx = 0; idx < groups.length; idx++) {
    const { itemIds: rawIdx, ...rest } = groups[idx] as Record<string, unknown>;

    // index → DB id; defensively skip out-of-range indices.
    const memberIds: number[] = Array.isArray(rawIdx)
      ? (rawIdx as number[])
          .map((i) => parents[i]?.id)
          .filter((v): v is number => typeof v === 'number')
      : [];

    const values = {
      ...rest,
      estimateId,
      groupName: (rest.groupName as string) ?? `Group ${idx + 1}`,
      itemIds: memberIds,
      numItems: (rest.numItems as number) ?? memberIds.length,
      updatedAt: new Date(),
    };

    let group: any;
    if (idx < existing.length) {
      // Position match → UPDATE in place, preserving the existing row id + created_at.
      [group] = await tx.update(estimateFreightGroups)
        .set(values as any)
        .where(eq(estimateFreightGroups.id, existing[idx].id))
        .returning();
    } else {
      // No existing group at this position → new group (fresh id).
      [group] = await tx.insert(estimateFreightGroups)
        .values(values as any)
        .returning();
    }
    persisted.push(group);

    if (memberIds.length > 0) {
      await tx.update(estimateLineItems)
        .set({ freightGroupId: group.id })
        .where(inArray(estimateLineItems.id, memberIds));
    }
  }

  // Soft-delete surplus existing groups beyond the incoming count (keep the rows + ids).
  if (existing.length > groups.length) {
    const surplusIds = existing.slice(groups.length).map((r: any) => r.id);
    await tx.update(estimateFreightGroups)
      .set({ isActive: false, updatedAt: new Date() })
      .where(inArray(estimateFreightGroups.id, surplusIds));
  }

  return persisted;
}

// ── Internal: in-place diff upsert for UPDATE ─────────────────────────────────
// Instead of deleting + re-inserting every line, we diff the incoming lines against
// the existing ACTIVE rows and apply the minimum changes:
//   • matched line  → UPDATE in place (row id + netsuite_internal_id are NEVER touched,
//                     so the NS line id survives and NetSuite updates the same line)
//   • new line      → INSERT
//   • removed line  → SOFT-DELETE (is_active=false). The row + its netsuite_internal_id
//                     are kept so the NS line can be deactivated afterwards (delete-mode
//                     sync). The returned `deletedIds` are handed to that NS sync.
//
// Matching, per incoming line: 1) by `id` when the payload carries a known id;
// 2) otherwise by POSITION — the Nth incoming parent maps to the Nth old parent, and
// each parent's Nth component maps to that old parent's Nth component. Position matching
// assumes the frontend keeps line order and appends new lines at the end; a UI that
// REORDERS lines must send each line's real `id` to stay correct.
//
// lineNumber is unique per estimate among active rows, so before renumbering we shift the
// survivors' lineNumber out of the target range to avoid transient unique-index collisions.
const LINE_NUMBER_PARK = 1_000_000;

async function upsertLineItemsWithComponents(
  tx: any,
  estimateId: number,
  items: RawLineItem[],
): Promise<{ parents: any[]; components: any[]; deletedIds: number[] }> {
  // Only ACTIVE rows take part in the diff. Soft-deleted rows (is_active = false) are left
  // untouched so their row + netsuite_internal_id survive for later NetSuite deactivation.
  const activeOnly = and(
    eq(estimateLineItems.estimateId, estimateId),
    eq(estimateLineItems.isActive, true),
  );

  if (items.length === 0) {
    // Every line removed: soft-delete all currently-active rows (keep them for NS deactivation).
    const removed = await tx.select({ id: estimateLineItems.id })
      .from(estimateLineItems).where(activeOnly);
    if (removed.length > 0) {
      await tx.update(estimateLineItems)
        .set({ isActive: false, updatedAt: new Date() })
        .where(activeOnly);
    }
    return { parents: [], components: [], deletedIds: removed.map((r: any) => r.id) };
  }

  // Snapshot existing ACTIVE rows (ids + ordering) so we can match incoming lines to them.
  const existing = await tx
    .select({
      id              : estimateLineItems.id,
      lineNumber      : estimateLineItems.lineNumber,
      parentLineItemId: estimateLineItems.parentLineItemId,
    })
    .from(estimateLineItems)
    .where(activeOnly);
  const existingIds = new Set<number>(existing.map((r: any) => r.id));

  // Old parents in order + each old parent's components in order, for position matching.
  const oldParents: any[] = existing
    .filter((r: any) => r.parentLineItemId === null)
    .sort((a: any, b: any) => a.lineNumber - b.lineNumber);
  const oldCompsByParent = new Map<number, any[]>();
  for (const r of existing as any[]) {
    if (r.parentLineItemId !== null) {
      const arr = oldCompsByParent.get(r.parentLineItemId) ?? [];
      arr.push(r);
      oldCompsByParent.set(r.parentLineItemId, arr);
    }
  }
  for (const arr of oldCompsByParent.values()) arr.sort((a, b) => a.lineNumber - b.lineNumber);

  // ── Phase 1: build the match plan (no DB writes yet) ────────────────────────
  // `used` prevents two incoming lines from claiming the same old row. Seed it with every
  // explicit id-match so position matching can never steal an id-matched row.
  const used = new Set<number>();
  for (const it of items as any[]) {
    if (it.id && existingIds.has(it.id)) used.add(it.id);
    for (const c of (it.components ?? [])) if (c.id && existingIds.has(c.id)) used.add(c.id);
  }

  type Plan = { oldId: number | null; data: Record<string, unknown> };
  const parentPlan: (Plan & { components: any[] })[] = [];
  for (const item of items as any[]) {
    const { components, id: itemId, ...data } = item;
    let oldId: number | null = null;
    if (itemId && existingIds.has(itemId)) {
      oldId = itemId;                                   // explicit id-match (already in `used`)
    } else {
      const cand = oldParents[parentPlan.length];       // position match by parent index
      if (cand && !used.has(cand.id)) { oldId = cand.id; used.add(cand.id); }
    }
    parentPlan.push({ oldId, data, components: components ?? [] });
  }

  const compPlan: (Plan & { parentIdx: number; sortOrder: number })[] = [];
  parentPlan.forEach((p, parentIdx) => {
    const oldComps = p.oldId != null ? (oldCompsByParent.get(p.oldId) ?? []) : [];
    p.components.forEach((comp: any, j: number) => {
      const { id: compId, ...data } = comp;
      let oldId: number | null = null;
      if (compId && existingIds.has(compId)) {
        oldId = compId;
      } else {
        const cand = oldComps[j];
        if (cand && !used.has(cand.id)) { oldId = cand.id; used.add(cand.id); }
      }
      compPlan.push({ oldId, data, parentIdx, sortOrder: j });
    });
  });

  const keptIds = new Set<number>([...parentPlan, ...compPlan].filter(p => p.oldId != null).map(p => p.oldId!));

  logger.info({
    estimateId,
    existingActiveIds: [...existingIds],
    incomingParentIds: (items as any[]).map(it => it.id ?? null),
    kept             : [...keptIds],
    toDelete         : existing.filter((r: any) => !keptIds.has(r.id)).map((r: any) => r.id),
  }, 'upsertLineItems: in-place diff (update kept, insert new, delete removed)');

  // ── Phase 2: soft-delete removed lines ──────────────────────────────────────
  // Flip is_active=false instead of hard-deleting, so the row + its netsuite_internal_id
  // survive for later NetSuite deactivation (delete-mode sync). `existing` already holds
  // BOTH parents and components, so an orphaned component of a removed kit parent is
  // captured here too. The partial unique index (is_active=true) excludes these rows, so
  // their old line_number can't collide with the kept rows we renumber below.
  const toDelete = existing.filter((r: any) => !keptIds.has(r.id)).map((r: any) => r.id);
  if (toDelete.length > 0) {
    await tx.update(estimateLineItems)
      .set({ isActive: false, updatedAt: new Date() })
      .where(inArray(estimateLineItems.id, toDelete));
  }

  // ── Phase 3: park survivors' lineNumber out of the target range ─────────────
  // Avoids transient collisions on the (estimateId, lineNumber) partial-unique index while
  // we renumber kept rows into their new 1..N slots.
  if (keptIds.size > 0) {
    await tx.update(estimateLineItems)
      .set({ lineNumber: sql`${estimateLineItems.lineNumber} + ${LINE_NUMBER_PARK}` })
      .where(activeOnly);
  }

  // ── Flattened line numbering ────────────────────────────────────────────────
  // Each parent is immediately followed by its own components, then the next item —
  // e.g. kit(1), comp(2), comp(3), quote(4) — so the stored order matches the on-screen
  // structure and NetSuite's lineComponentsNS references the contiguous lines after the
  // kit. Computed up-front from the plan; the park step above guarantees these final
  // numbers can't transiently collide with survivors' parked numbers.
  const compIdxByParent = new Map<number, number[]>();
  compPlan.forEach((c, ci) => {
    const arr = compIdxByParent.get(c.parentIdx) ?? [];
    arr.push(ci);
    compIdxByParent.set(c.parentIdx, arr);
  });
  const parentLineNumber: number[] = [];
  const compLineNumber: number[] = [];   // indexed by compPlan index
  let lineNo = 1;
  for (let i = 0; i < parentPlan.length; i++) {
    parentLineNumber[i] = lineNo++;
    for (const ci of (compIdxByParent.get(i) ?? [])) compLineNumber[ci] = lineNo++;
  }

  // ── Phase 4: parents — UPDATE kept rows in place, INSERT new ones ───────────
  const parents: any[] = [];
  const parentFinalId: number[] = [];
  for (let i = 0; i < parentPlan.length; i++) {
    const p = parentPlan[i];
    const common = { lineNumber: parentLineNumber[i], sortOrder: i, parentLineItemId: null };
    let row: any;
    if (p.oldId != null) {
      [row] = await tx.update(estimateLineItems)
        .set({ ...p.data, ...common, updatedAt: new Date() } as any)
        .where(eq(estimateLineItems.id, p.oldId))
        .returning();
    } else {
      [row] = await tx.insert(estimateLineItems)
        .values({ ...p.data, ...common, estimateId } as any)
        .returning();
    }
    parents.push(row);
    parentFinalId[i] = row.id;
  }

  // ── Phase 5: components — UPDATE kept rows in place, INSERT new ones ─────────
  const components: any[] = [];
  for (let ci = 0; ci < compPlan.length; ci++) {
    const c = compPlan[ci];
    const common = { lineNumber: compLineNumber[ci], sortOrder: c.sortOrder, parentLineItemId: parentFinalId[c.parentIdx] };
    let row: any;
    if (c.oldId != null) {
      [row] = await tx.update(estimateLineItems)
        .set({ ...c.data, ...common, updatedAt: new Date() } as any)
        .where(eq(estimateLineItems.id, c.oldId))
        .returning();
    } else {
      [row] = await tx.insert(estimateLineItems)
        .values({ ...c.data, ...common, estimateId } as any)
        .returning();
    }
    components.push(row);
  }

  return { parents, components, deletedIds: toDelete };
}

// ── Create estimate + cost sheet items atomically ───────────────────────────

// Default ES Status applied to newly created estimates when the caller doesn't set one.
const DEFAULT_ES_STATUS_NAME = 'In Progress';

// Resolve the es_status row id for the default status name. Returns null if the
// master row is missing so a create never fails just because the seed data isn't there.
async function getDefaultEsStatusId(): Promise<number | null> {
  const db = getDb();
  const [row] = await db
    .select({ id: esStatus.id })
    .from(esStatus)
    .where(and(eq(esStatus.name, DEFAULT_ES_STATUS_NAME), eq(esStatus.isActive, true)))
    .limit(1);
  return row?.id ?? null;
}

export async function createEstimateWithItems(
  headerData: Record<string, unknown>,
  lineItems: RawLineItem[],
  freightGroups: Record<string, unknown>[] = [],
  creativeRequests?: CreativeRequestsInput,
  submittedByUserId?: number | null,
) {
  const db = getDb();
  const startTime = Date.now();
  logger.info('Creating estimate');

  // Default es_status → "In Progress" when the caller didn't specify one.
  if (headerData.esStatusId === undefined || headerData.esStatusId === null) {
    const defaultEsStatusId = await getDefaultEsStatusId();
    if (defaultEsStatusId !== null) {
      headerData = { ...headerData, esStatusId: defaultEsStatusId };
    } else {
      logger.warn({ name: DEFAULT_ES_STATUS_NAME }, 'Default es_status not found — estimate created without one');
    }
  }

  return db.transaction(async (tx) => {
    // Step 1: Insert estimate header.
    // trandate is intentionally left unset here — NetSuite is the source of truth
    // for the transaction date. It's written back from the `trandateNS` key on the
    // NS create/update response (see syncEstimateToNetsuite).
    const [estimate] = await tx.insert(estimates)
      .values({
        ...headerData,
        source: 'portal',
        syncStatus: 'pending',
      } as any)
      .returning();

    // Step 2 – Line items
    const { parents, components } = await insertLineItemsWithComponents(tx, estimate.id, lineItems);

    // Step 3 – Freight groups (links resolved against the inserted parents)
    const insertedGroups = await persistFreightGroups(tx, estimate.id, freightGroups, parents);

    // Step 4 – Creative Requests (up to 4 independent toggles).
    // Runs inside the same transaction as the rest of the save; each toggle gets its own
    // savepoint internally, so one toggle failing never rolls back the estimate or its
    // sibling toggles. Per-toggle outcomes come back for the response.
    const creativeRequestResults = await saveCreativeRequests(
      tx, estimate.id, submittedByUserId ?? null, creativeRequests,
    );

    const duration = Date.now() - startTime;
    logger.info({ estimateId: estimate.id, lineItemCount: parents.length + components.length, freightGroupCount: insertedGroups.length, creativeRequestCount: creativeRequestResults.length, durationMs: duration }, 'Estimate created');

    return { estimate, lineItems: [...parents, ...components], freightGroups: insertedGroups, creativeRequests: creativeRequestResults };
  }).then((result) => {
    // Fire-and-forget: NS sync errors are caught inside syncEstimateToNetsuite;
    // the portal response must not block on or fail due to NS availability.
    // Creative requests are included in this same payload — no separate push.
    syncEstimateToNetsuite(result.estimate.id, 'create').catch(() => {/* already logged + recorded */});
    return result;
  });
}

// ── Update header; optionally replace all line items atomically ─────────────

export async function updateEstimateWithItems(
  id: number,
  headerData: Record<string, unknown>,
  newLineItems?: RawLineItem[],
  newFreightGroups?: Record<string, unknown>[],
  creativeRequests?: CreativeRequestsInput,
  submittedByUserId?: number | null,
  opts?: { awaitSync?: boolean },
) {
  const db = getDb();
  const startTime = Date.now();

  // Ids of lines the diff soft-deleted this update — deactivated in NetSuite after commit.
  let deletedLineIds: number[] = [];

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
      const { parents, components, deletedIds } = await upsertLineItemsWithComponents(tx, id, newLineItems);
      allLineItems = [...parents, ...components];
      deletedLineIds = deletedIds;
    } else {
      allLineItems = await tx.select()
        .from(estimateLineItems)
        .where(and(
          eq(estimateLineItems.estimateId, id),
          eq(estimateLineItems.isActive, true),
        ))
        .orderBy(asc(estimateLineItems.lineNumber), asc(estimateLineItems.sortOrder));
    }

    // Step 3 – Freight groups. Only reconcile when the caller actually sent freightGroups;
    // a header-only / line-only update leaves existing groups untouched (backward compatible).
    // Index resolution uses the parent line items in lineNumber order.
    if (newFreightGroups !== undefined) {
      const parents = allLineItems.filter((r: any) => r.parentLineItemId === null);
      await persistFreightGroups(tx, id, newFreightGroups, parents);
    }

    // Step 4 – Creative Requests. Insert-only: this creates requests for toggles that have
    // none yet, and leaves any existing request completely untouched. Skipped entirely when
    // the caller didn't send creativeRequests, so a header-only / line-only update does no
    // needless work.
    const creativeRequestResults = creativeRequests !== undefined
      ? await saveCreativeRequests(tx, id, submittedByUserId ?? null, creativeRequests)
      : [];

    return { estimate: updated, lineItems: allLineItems, creativeRequests: creativeRequestResults };
  });

  await cacheDel(CacheKeys.estimate(id));

  const duration = Date.now() - startTime;
  logger.info({ estimateId: id, durationMs: duration }, 'Estimate updated');

  // NS sync. When lines were soft-deleted this update, run the two NS writes in sequence —
  // first push the header + surviving active lines, then deactivate the removed lines —
  // so NetSuite never receives two concurrent edits to the same record.
  const runSync = async () => {
    await syncEstimateToNetsuite(id, 'update');
    if (deletedLineIds.length > 0) {
      await deactivateLinesInNetsuite(id, { lineItemIds: deletedLineIds });
    }
  };

  if (opts?.awaitSync) {
    // Caller (e.g. convert-to-quote) needs NetSuite to actually hold the new lines
    // before proceeding, so await the sync and surface failure instead of swallowing it.
    await runSync();
    const [refreshed] = await db.select({ syncStatus: estimates.syncStatus, syncError: estimates.syncError })
      .from(estimates).where(eq(estimates.id, id)).limit(1);
    if (refreshed?.syncStatus === 'failed') {
      throw new AppError(
        `Failed to sync line items to NetSuite: ${refreshed.syncError ?? 'unknown error'}`,
        502, 'NS_SYNC_FAILED',
      );
    }
  } else {
    runSync().catch(() => {/* already logged + recorded */});
  }

  return result;
}

// ── Bulk pipeline-grid update ─────────────────────────────────────────────────
// Lightweight, header-only update for the inline Pipeline grid. Updates only the
// narrow set of cells edited in the grid across many estimates in one request —
// does NOT touch line items / freight groups (unlike updateEstimateWithItems).
// Each row is updated independently so one bad row does not sink the whole batch;
// per-row outcomes are returned. Cache is invalidated and NS sync fired per updated row.
type PipelineUpdateItem = { id: number } & Record<string, unknown>;

export async function updateEstimatesPipelineFields(items: PipelineUpdateItem[]) {
  const db = getDb();
  const startTime = Date.now();
  const results: Array<{ id: number; success: boolean; error?: string }> = [];
  const updatedIds: number[] = [];

  for (const { id, ...fields } of items) {
    // Skip rows that carry an id but no editable cells.
    if (Object.keys(fields).length === 0) {
      results.push({ id, success: false, error: 'No fields to update' });
      continue;
    }
    try {
      const [updated] = await db.update(estimates)
        .set({ ...fields as any, syncStatus: 'dirty', updatedAt: new Date() })
        .where(and(eq(estimates.id, id), eq(estimates.isActive, true)))
        .returning({ id: estimates.id });

      if (!updated) {
        results.push({ id, success: false, error: 'Estimate not found or inactive' });
        continue;
      }
      updatedIds.push(id);
      results.push({ id, success: true });
    } catch (err) {
      logger.error({ estimateId: id, err }, 'Pipeline field update failed');
      results.push({ id, success: false, error: err instanceof Error ? err.message : 'Update failed' });
    }
  }

  // Invalidate cache + fire-and-forget NS sync for each successfully updated row.
  await Promise.all(updatedIds.map(id => cacheDel(CacheKeys.estimate(id))));
  for (const id of updatedIds) {
    syncEstimateToNetsuite(id, 'update').catch(() => {/* already logged + recorded */});
  }

  logger.info({ updated: updatedIds.length, total: items.length, durationMs: Date.now() - startTime },
    'Pipeline fields bulk-updated');

  return { updated: updatedIds.length, results };
}

// ── List estimates with failed NS sync ───────────────────────────────────────

export async function listFailedSyncs() {
  return getDb()
    .select({
      id             : estimates.id,
      documentNumber : estimates.documentNumber,
      syncStatus     : estimates.syncStatus,
      syncError      : estimates.syncError,
      syncedAt       : estimates.syncedAt,
      updatedAt      : estimates.updatedAt,
    })
    .from(estimates)
    .where(eq(estimates.syncStatus as any, 'failed'))
    .orderBy(desc(estimates.updatedAt));
}

// ── Manually re-trigger NS sync for a single estimate ────────────────────────

export async function resyncEstimate(id: number) {
  const db = getDb();

  const [est] = await db
    .select({ id: estimates.id, netsuiteInternalId: estimates.netsuiteInternalId })
    .from(estimates)
    .where(and(eq(estimates.id, id), eq(estimates.isActive, true)))
    .limit(1);

  if (!est) throw new NotFoundError('Estimate', String(id));

  // Reset to pending so the UI knows a sync attempt is in flight — including the
  // estimate's line items + freight groups, which the sync run will re-stamp.
  await Promise.all([
    db.update(estimates)
      .set({ syncStatus: 'pending', syncError: null } as any)
      .where(eq(estimates.id, id)),
    db.update(estimateLineItems)
      .set({ syncStatus: 'pending', syncError: null } as any)
      .where(and(eq(estimateLineItems.estimateId, id), eq(estimateLineItems.isActive, true))),
    db.update(estimateFreightGroups)
      .set({ syncStatus: 'pending', syncError: null } as any)
      .where(and(
        eq(estimateFreightGroups.estimateId, id),
        eq(estimateFreightGroups.isActive, true),
      )),
  ]);

  // Use 'create' if NS never received the record, 'update' if it did
  const mode = est.netsuiteInternalId ? 'update' : 'create';
  syncEstimateToNetsuite(id, mode).catch(() => {/* already logged + recorded inside */});

  return { id, syncStatus: 'pending', message: `NS sync triggered (mode: ${mode})` };
}

// ── Convert to OTB (creates a Quote in NetSuite) ─────────────────────────────

export async function convertEstimateToOtb(
  id     : number,
  opts?  : { target?: 'new' | 'existing' },
) {
  const db = getDb();

  // 1. Verify estimate exists, is active, and has been synced to NS
  const [est] = await db
    .select({ id: estimates.id, status: estimates.status, isActive: estimates.isActive, netsuiteInternalId: estimates.netsuiteInternalId })
    .from(estimates)
    .where(and(eq(estimates.id, id), eq(estimates.isActive, true)))
    .limit(1);
  if (!est) throw new NotFoundError('Estimate', String(id));
  if (!est.netsuiteInternalId) {
    throw new Error('Estimate has not been synced to NetSuite yet. Save the estimate first before converting to OTB.');
  }

  // Defensive re-sync: push whatever currently sits in Postgres (e.g. a line item saved
  // moments ago by a PATCH whose own NS sync was fire-and-forget) to NetSuite and wait for
  // it, so the convert step below never races an in-flight/incomplete prior sync — no matter
  // whether the caller saved edits via this same request or a separate preceding call.
  await syncEstimateToNetsuite(id, 'update');
  const [preConvertState] = await db
    .select({ syncStatus: estimates.syncStatus, syncError: estimates.syncError })
    .from(estimates).where(eq(estimates.id, id)).limit(1);
  if (preConvertState?.syncStatus === 'failed') {
    throw new AppError(
      `Could not confirm the estimate's latest line items are synced to NetSuite before converting: `
      + `${preConvertState.syncError ?? 'unknown error'}. Save again and retry Create Quote.`,
      502, 'NS_SYNC_FAILED',
    );
  }

  const target = opts?.target ?? 'new';

  // ── Option B: add newly-added lines to the EXISTING quote ───────────────────
  if (target === 'existing') {
    // Only the unconverted (newly added) line items go to the existing quote
    const unconverted = await db
      .select({ id: estimateLineItems.id })
      .from(estimateLineItems)
      .where(and(eq(estimateLineItems.estimateId, id), eq(estimateLineItems.converted, false)));
    const targetIds = unconverted.map(r => r.id);
    if (targetIds.length === 0) {
      return { id, message: 'No new line items to add to the existing quote' };
    }

    // Find the latest active quote that already exists in NetSuite
    const [activeQuote] = await db
      .select()
      .from(estimateQuotes)
      .where(and(eq(estimateQuotes.estimateId, id), eq(estimateQuotes.status as any, 'active')))
      .orderBy(desc(estimateQuotes.createdAt))
      .limit(1);

    if (!activeQuote || !activeQuote.quoteNetsuiteInternalId) {
      throw new Error('No existing quote found for this estimate. Create a new quote first.');
    }

    await db.update(estimates)
      .set({ status: 'otb', syncStatus: 'pending', otbConvertedAt: new Date(), updatedAt: new Date() } as any)
      .where(eq(estimates.id, id));

    await syncEstimateToNetsuite(id, 'convertToExisting', {
      quoteId    : activeQuote.id,                       // portal quote row to refresh
      quoteNsId  : activeQuote.quoteNetsuiteInternalId,  // NS quote id sent in payload
      lineItemIds: targetIds,                            // lines to mark converted=true
    });

    const [quoteAfter] = await db.select().from(estimateQuotes)
      .where(eq(estimateQuotes.id, activeQuote.id)).limit(1);
    if (quoteAfter?.syncStatus === 'failed') {
      throw new AppError(
        `Line items were saved, but adding them to the existing quote failed in NetSuite: `
        + `${quoteAfter.syncError ?? 'unknown error'}. Click Create Quote again to retry.`,
        502, 'NS_CONVERT_FAILED',
      );
    }

    return {
      id,
      quoteId        : activeQuote.id,
      mode           : 'convertToExisting',
      targetLineItems: targetIds.length,
      syncStatus     : quoteAfter?.syncStatus ?? 'pending',
      message        : `Added ${targetIds.length} line item(s) to existing quote ${quoteAfter?.quoteDocumentNumber ?? quoteAfter?.quoteNetsuiteInternalId ?? activeQuote.quoteNetsuiteInternalId}`,
    };
  }

  // ── Option A: create a SEPARATE new quote for the newly-added lines ──────────
  // Only unconverted (newly added) lines are quoted. Previous quotes stay active,
  // so an estimate can hold multiple active quotes (one per batch of lines).
  const unconverted = await db
    .select({ id: estimateLineItems.id })
    .from(estimateLineItems)
    .where(and(eq(estimateLineItems.estimateId, id), eq(estimateLineItems.converted, false)));
  const targetIds = unconverted.map(r => r.id);
  if (targetIds.length === 0) {
    return { id, message: 'No new line items to quote' };
  }

  // New quote row for this conversion (previous quotes are left active)
  const [newQuote] = await db.insert(estimateQuotes)
    .values({ estimateId: id, syncStatus: 'pending' } as any)
    .returning();

  await db.update(estimates)
    .set({ status: 'otb', syncStatus: 'pending', otbConvertedAt: new Date(), updatedAt: new Date() } as any)
    .where(eq(estimates.id, id));

  await syncEstimateToNetsuite(id, 'convert', { quoteId: newQuote.id, lineItemIds: targetIds });

  const [quoteAfter] = await db.select().from(estimateQuotes)
    .where(eq(estimateQuotes.id, newQuote.id)).limit(1);
  if (quoteAfter?.syncStatus === 'failed') {
    throw new AppError(
      `Line items were saved, but quote creation failed in NetSuite: `
      + `${quoteAfter.syncError ?? 'unknown error'}. Click Create Quote again to retry.`,
      502, 'NS_CONVERT_FAILED',
    );
  }

  return {
    id,
    quoteId        : newQuote.id,
    mode           : 'convert',
    targetLineItems: targetIds.length,
    syncStatus     : quoteAfter?.syncStatus ?? 'pending',
    message        : `Quote ${quoteAfter?.quoteDocumentNumber ?? quoteAfter?.quoteNetsuiteInternalId ?? ''} created for ${targetIds.length} line item(s)`,
  };
}

// ── "Create Quote" from the Edit page: save any pending header/line-item edits,
// wait for NetSuite to actually hold them, THEN convert to a quote — all as one
// call, so the user never has to click "Save" before "Create Quote".
//
// If the save step fails (Portal or NetSuite), conversion is never attempted.
// If the save step succeeds but the convert step fails, the edits are already
// persisted in both Portal and NetSuite (safe to retry — see convertEstimateToOtb,
// which only ever operates on still-unconverted lines already in the DB).
export async function saveAndConvertEstimateToOtb(
  id: number,
  headerData: Record<string, unknown>,
  lineItems?: RawLineItem[],
  freightGroups?: Record<string, unknown>[],
  creativeRequests?: CreativeRequestsInput,
  submittedByUserId?: number | null,
  convertOpts?: { target?: 'new' | 'existing' },
) {
  const hasEdits = lineItems !== undefined || freightGroups !== undefined
    || creativeRequests !== undefined || Object.keys(headerData).length > 0;

  if (hasEdits) {
    await updateEstimateWithItems(
      id, headerData, lineItems, freightGroups, creativeRequests, submittedByUserId ?? null,
      { awaitSync: true },
    );
  }

  return convertEstimateToOtb(id, convertOpts);
}

// ── List quotes for an estimate ──────────────────────────────────────────────

export async function listEstimateQuotes(estimateId: number) {
  return getDb()
    .select()
    .from(estimateQuotes)
    .where(eq(estimateQuotes.estimateId, estimateId))
    .orderBy(desc(estimateQuotes.createdAt));
}

// ── Deactivate (soft delete) ─────────────────────────────────────────────────

export async function deactivateEstimate(id: number) {
  const db = getDb();
  await db.transaction(async (tx) => {
    // Soft-delete the estimate header...
    await tx.update(estimates)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(estimates.id, id));
    // ...and cascade to every line item (parents + components) so their rows +
    // netsuite_internal_ids are retained for later NetSuite deactivation.
    await tx.update(estimateLineItems)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(estimateLineItems.estimateId, id));
  });
  await cacheDel(CacheKeys.estimate(id));
  // Push the deactivation to NetSuite (delete mode) for every line of this estimate.
  deactivateLinesInNetsuite(id).catch(() => {/* already logged + recorded */});
  return { id, isActive: false };
}

// ── Delete (hard delete) ─────────────────────────────────────────────────────
//
// Permanently removes the estimate row from the database. The FK constraints on
// the child tables — estimate_line_items (incl. its component sub-tree via
// parent_line_item_id), estimate_freight_groups and estimate_quotes — are all
// ON DELETE CASCADE, so the database removes every related row in the same
// statement. No separate line-item cleanup is needed.
//
// Before deleting we push a delete-mode sync to NetSuite (best-effort) so the
// matching lines are deactivated there too. This MUST run first, while the rows
// and their netsuite_internal_ids still exist — once the estimate is deleted
// there is no way to tell NetSuite which lines to deactivate.
//
// This is separate from deactivateEstimate() (soft delete); callers choose one.
export async function deleteEstimate(id: number) {
  const db = getDb();

  // Confirm it exists so callers get a clean 404 instead of a silent no-op.
  const [existing] = await db.select({ id: estimates.id })
    .from(estimates)
    .where(eq(estimates.id, id))
    .limit(1);
  if (!existing) throw new NotFoundError('Estimate', id);

  // Notify NetSuite first (all lines, regardless of is_active) — the rows and
  // their NS ids are about to be deleted. Best-effort: failures are logged and
  // recorded but must not block the delete.
  await deactivateLinesInNetsuite(id, { allLines: true })
    .catch(() => {/* already logged + recorded */});

  // Hard delete — FK cascade removes line items, freight groups and quotes.
  await db.delete(estimates).where(eq(estimates.id, id));

  await cacheDel(CacheKeys.estimate(id));
  return { id, deleted: true };
}
