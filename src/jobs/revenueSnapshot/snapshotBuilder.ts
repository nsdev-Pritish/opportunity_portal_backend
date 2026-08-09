// The "read a source table, resolve, insert" sweep — run strictly one source
// at a time (Pipeline, then Open SO, then Invoice, then Budget), each fully
// selected, transformed, and inserted before the next one starts. Read-only
// against the 4 source tables; only ever writes to fact_revenue_snapshot.
//
// Known gaps, carried over as documented NULLs rather than guessed values —
// see the schema/migration comments for fact_revenue_snapshot:
//   - foreign_amount: not sent by NetSuite yet for any of the 3 sources that
//     need it. Pipeline/SO derive an interim value (projectedTotal ÷
//     exchangeRate); Invoice is left NULL because its exchangeRate is the
//     field already flagged as unreliable — dividing by a bad rate would
//     manufacture a bad number.
//   - anchor_id: NULL for SO/Invoice — there is no "Created From Estimate"
//     link field in either table yet, so there is nothing to resolve it from.
//   - stage: NULL for Pipeline (no source field). SO actually already has
//     this available for free via estimate_statuses.stage (the same lookup
//     used for `status`) — resolved below. NULL for Invoice, per the
//     workbook's scope (stage doesn't apply to Invoice).
//   - Budget: project_name and currency are NULL (no source field, and
//     currency has not been confirmed always-USD by the client yet).
//     created_date prefers budget_search.date_created (NetSuite's own "Date
//     Created"), falling back to the portal's own createdAt — NetSuite is not
//     populating date_created for any Budget row yet, so today the fallback
//     is what actually lands.
//
// source_name is a static per-pass label, not resolved from any source
// column — none of the 4 tables has a field literally called "Source Name"
// (the mapping sheet's own "Source Name -> Source Name" row is circular);
// this just records which of the 4 saved searches produced the row.
//
// likely_to_close resolves via the same likelyToCloseId FK already present
// on Pipeline/SO/Invoice (Budget has no such field) — used downstream by
// the Original Baseline rule ("Likely to Close > 3").
//
// The whole build runs inside ONE database transaction (see
// buildRevenueSnapshotSequential): if any chunk of any source fails partway
// through, everything inserted so far in this attempt rolls back together,
// rather than leaving a partial source half-inserted. That's what makes a
// retry after a failure safe — it never risks duplicating rows that already
// made it in before the failure. Within the transaction, each source's rows
// are still inserted in fixed-size chunks (SNAPSHOT_INSERT_CHUNK_SIZE) —
// a single INSERT for a large source (e.g. tens of thousands of Invoice
// rows) would exceed Postgres's 65,535-parameter-per-query limit.

import { eq } from 'drizzle-orm';
import {
  estimateQuoteSearch,
  salesOrderSearch,
  invoiceSearch,
  budgetSearch,
  factRevenueSnapshot,
  departments,
  customers,
  accountManagers,
  projectNames,
  currencies,
  estimateStatuses,
  forecastStatuses,
  employees,
  likelyToClose,
} from '../../db/schema/index.js';
import type { DB } from '../../config/database.js';
import { SNAPSHOT_INSERT_CHUNK_SIZE } from './config.js';

// The type of the `tx` parameter passed into db.transaction(async (tx) => ...) —
// supports the same .select()/.insert() query-builder API as `DB` itself.
type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];

const SOURCE_NAMES: Record<string, string> = {
  PIPELINE: 'Pipeline Saved Search',
  SO: 'Open SO Saved Search',
  INVOICE: 'Invoice Saved Search',
  BUDGET: 'Budget Saved Search',
};

type Id = number | null | undefined;

function toDateOnly(d: unknown): string | null {
  if (!d) return null;
  // Date-mode timestamp columns (e.g. syncCols.createdAt) hand back a JS Date,
  // whose String() form is "Wed Jul 01 2026 ..." — slicing that yields
  // "Wed Jul 01", which Postgres rejects (22007). The date()/string-mode
  // columns already arrive ISO-shaped, so only Date needs converting.
  if (d instanceof Date) return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  const s = String(d);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

function toMonthStart(d: unknown): string | null {
  const dateOnly = toDateOnly(d);
  if (!dateOnly) return null;
  return `${dateOnly.slice(0, 7)}-01`;
}

function deriveForeignAmount(projectedTotal: unknown, exchangeRate: unknown): string | null {
  if (projectedTotal == null || exchangeRate == null) return null;
  const rate = Number(exchangeRate);
  const total = Number(projectedTotal);
  if (!rate || Number.isNaN(rate) || Number.isNaN(total)) return null;
  return (total / rate).toFixed(2);
}

interface MasterLookups {
  departmentNames: Map<number, string>;
  customerNames: Map<number, string>;
  accountManagerNames: Map<number, string>;
  projectNameNames: Map<number, string>;
  currencyCodes: Map<number, string>;
  estimateStatuses: Map<number, { name: string; stage: string | null }>;
  forecastStatusNames: Map<number, string>;
  employeeNames: Map<number, string | null>;
  likelyToCloseNames: Map<number, string>;
}

async function loadMasterLookups(db: DB | Tx): Promise<MasterLookups> {
  const [deptRows, custRows, amRows, projRows, currRows, statusRows, fcastRows, empRows, ltcRows] = await Promise.all([
    db.select({ id: departments.id, name: departments.name }).from(departments),
    db.select({ id: customers.id, name: customers.name }).from(customers),
    db.select({ id: accountManagers.id, name: accountManagers.name }).from(accountManagers),
    db.select({ id: projectNames.id, name: projectNames.name }).from(projectNames),
    db.select({ id: currencies.id, code: currencies.code }).from(currencies),
    db.select({ id: estimateStatuses.id, name: estimateStatuses.name, stage: estimateStatuses.stage }).from(estimateStatuses),
    db.select({ id: forecastStatuses.id, name: forecastStatuses.name }).from(forecastStatuses),
    db.select({ id: employees.id, name: employees.name }).from(employees),
    db.select({ id: likelyToClose.id, name: likelyToClose.name }).from(likelyToClose),
  ]);
  // Master/dropdown lookups only — no data from the 4 source tables is read here,
  // so loading these once up front does not affect the one-source-at-a-time guarantee below.

  return {
    departmentNames: new Map(deptRows.map(r => [r.id, r.name])),
    customerNames: new Map(custRows.map(r => [r.id, r.name])),
    accountManagerNames: new Map(amRows.map(r => [r.id, r.name])),
    projectNameNames: new Map(projRows.map(r => [r.id, r.name])),
    currencyCodes: new Map(currRows.map(r => [r.id, r.code])),
    estimateStatuses: new Map(statusRows.map(r => [r.id, { name: r.name, stage: r.stage }])),
    forecastStatusNames: new Map(fcastRows.map(r => [r.id, r.name])),
    employeeNames: new Map(empRows.map(r => [r.id, r.name])),
    likelyToCloseNames: new Map(ltcRows.map(r => [r.id, r.name])),
  };
}

function get(map: Map<number, string | null>, id: Id): string | null {
  if (id == null) return null;
  return map.get(id) ?? null;
}

type SnapshotRow = typeof factRevenueSnapshot.$inferInsert;

function buildPipelineRows(
  rows: (typeof estimateQuoteSearch.$inferSelect)[],
  lu: MasterLookups,
  snapshotDate: string,
  snapshotTs: Date,
): SnapshotRow[] {
  return rows.map(r => ({
    snapshotDate,
    snapshotTs,
    sourceType: 'PIPELINE',
    sourceName: SOURCE_NAMES.PIPELINE,
    internalId: r.netsuiteInternalId ?? '',
    anchorId: r.documentNumber, // Pipeline is its own anchor
    documentNumber: r.documentNumber,
    consolidatedCustomer: r.consolidatedCustomer, // already free text on this source
    topLevelParent: get(lu.customerNames, r.topLevelParentId),
    department: get(lu.departmentNames, r.departmentId),
    salesRep: get(lu.accountManagerNames, r.salesRepId),
    projectName: get(lu.projectNameNames, r.projectNameId),
    status: r.status, // already free text on this source
    stage: null, // gap — no source field
    likelyToClose: get(lu.likelyToCloseNames, r.likelyToCloseId),
    createdDate: toDateOnly(r.tranDate),
    revenueDate: toDateOnly(r.promisedDeliveryDate),
    revenuePeriod: toMonthStart(r.promisedDeliveryDate),
    foreignAmount: deriveForeignAmount(r.projectedTotal, r.exchangeRate), // interim derivation — see file header
    currency: get(lu.currencyCodes, r.currencyId),
    exchangeRate: r.exchangeRate,
    usdAmount: r.projectedTotal,
    changeDriver: null, // set later, during comparison — never at snapshot time
    isActive: r.isActive,
  }));
}

function buildSalesOrderRows(
  rows: (typeof salesOrderSearch.$inferSelect)[],
  lu: MasterLookups,
  snapshotDate: string,
  snapshotTs: Date,
): SnapshotRow[] {
  return rows.map(r => {
    const statusRow = r.statusId != null ? lu.estimateStatuses.get(r.statusId) : undefined;
    return {
      snapshotDate,
      snapshotTs,
      sourceType: 'SO',
      sourceName: SOURCE_NAMES.SO,
      internalId: r.netsuiteInternalId ?? '',
      anchorId: null, // gap — no "Created From Estimate" link field yet
      documentNumber: r.documentNumber,
      consolidatedCustomer: get(lu.customerNames, r.consolidatedCustomerId),
      topLevelParent: get(lu.customerNames, r.topLevelParentId),
      department: get(lu.departmentNames, r.departmentId),
      salesRep: get(lu.accountManagerNames, r.salesRepId),
      projectName: get(lu.projectNameNames, r.projectNameId),
      status: statusRow?.name ?? null,
      stage: statusRow?.stage ?? null, // available today via the same estimate_statuses lookup
      likelyToClose: get(lu.likelyToCloseNames, r.likelyToCloseId),
      createdDate: toDateOnly(r.tranDate),
      revenueDate: toDateOnly(r.promisedDeliveryDate),
      revenuePeriod: toMonthStart(r.promisedDeliveryDate),
      foreignAmount: deriveForeignAmount(r.projectedTotal, r.exchangeRate), // interim derivation — see file header
      currency: get(lu.currencyCodes, r.currencyId),
      exchangeRate: r.exchangeRate,
      usdAmount: r.projectedTotal, // ⚠️ confirm this is Open Amount, not full Amount (Net) — Open Item #4
      changeDriver: null,
      isActive: r.isActive,
    };
  });
}

function buildInvoiceRows(
  rows: (typeof invoiceSearch.$inferSelect)[],
  lu: MasterLookups,
  snapshotDate: string,
  snapshotTs: Date,
): SnapshotRow[] {
  return rows.map(r => {
    const statusRow = r.statusId != null ? lu.estimateStatuses.get(r.statusId) : undefined;
    return {
      snapshotDate,
      snapshotTs,
      sourceType: 'INVOICE',
      sourceName: SOURCE_NAMES.INVOICE,
      internalId: r.netsuiteInternalId ?? '',
      anchorId: null, // gap — no EST#/created-from link field yet
      documentNumber: r.documentNumber,
      consolidatedCustomer: get(lu.customerNames, r.consolidatedCustomerId),
      topLevelParent: get(lu.customerNames, r.topLevelParentId),
      department: get(lu.departmentNames, r.departmentId),
      salesRep: get(lu.accountManagerNames, r.salesRepId),
      projectName: get(lu.projectNameNames, r.projectNameId),
      status: statusRow?.name ?? null,
      stage: null, // not applicable to Invoice per the workbook's scope
      likelyToClose: get(lu.likelyToCloseNames, r.likelyToCloseId),
      createdDate: toDateOnly(r.tranDate),
      revenueDate: toDateOnly(r.promisedDeliveryDate),
      revenuePeriod: toMonthStart(r.promisedDeliveryDate),
      foreignAmount: null, // NOT derived — invoice exchangeRate is the flagged-unreliable field
      currency: get(lu.currencyCodes, r.currencyId),
      exchangeRate: r.exchangeRate, // ⚠️ verify NetSuite is actually populating this
      usdAmount: r.projectedTotal, // ⚠️ confirm this represents "USD Net Revenue"
      changeDriver: null,
      isActive: r.isActive,
    };
  });
}

function buildBudgetRows(
  rows: (typeof budgetSearch.$inferSelect)[],
  lu: MasterLookups,
  snapshotDate: string,
  snapshotTs: Date,
): SnapshotRow[] {
  return rows.map(r => ({
    snapshotDate,
    snapshotTs,
    sourceType: 'BUDGET',
    sourceName: SOURCE_NAMES.BUDGET,
    internalId: r.netsuiteInternalId ?? '',
    anchorId: null, // not lifecycle-linked, per the workbook
    documentNumber: r.name,
    consolidatedCustomer: r.consolidatedCustomerText ?? get(lu.customerNames, r.consolidatedCustomerId),
    topLevelParent: get(lu.customerNames, r.parentId),
    department: get(lu.departmentNames, r.departmentId),
    salesRep: get(lu.employeeNames, r.accountManagerId),
    projectName: null, // gap — no source field
    status: get(lu.forecastStatusNames, r.forecastStatusId),
    stage: null, // not applicable to Budget
    likelyToClose: null, // Budget has no likelyToCloseId field
    createdDate: toDateOnly(r.dateCreated ?? r.createdAt), // NetSuite's own "Date Created" when sent; portal createdAt otherwise
    revenueDate: toDateOnly(r.revenuePeriod),
    revenuePeriod: toDateOnly(r.revenuePeriod), // already month-level on this source
    foreignAmount: null, // not applicable, per the workbook
    currency: null, // gap — no source field; not yet confirmed always-USD
    exchangeRate: null,
    usdAmount: r.netRevenue,
    changeDriver: null,
    isActive: r.isActive,
  }));
}

export interface BuildResult {
  inserted: number;
  bySource: Record<string, number>;
}

/** Inserts rows in fixed-size chunks, sequentially — never more than one INSERT in flight. */
async function insertInChunks(tx: Tx, rows: SnapshotRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += SNAPSHOT_INSERT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + SNAPSHOT_INSERT_CHUNK_SIZE);
    if (chunk.length > 0) await tx.insert(factRevenueSnapshot).values(chunk);
  }
}

/**
 * Runs the 4 sources strictly one at a time — Pipeline is fully selected,
 * transformed, and inserted before Open SO's select even starts, and so on.
 * This is intentionally NOT Promise.all'd across sources, so there is never
 * more than one insert into fact_revenue_snapshot in flight at once. Within
 * each source, rows are inserted in SNAPSHOT_INSERT_CHUNK_SIZE-row batches
 * for the same reason, one chunk at a time.
 *
 * The entire function runs inside one database transaction: if any chunk of
 * any source fails partway through, everything this attempt already
 * inserted rolls back together, so a retry never risks duplicating rows
 * that made it in before the failure.
 */
export async function buildRevenueSnapshotSequential(db: DB, snapshotDate: string, snapshotTs: Date): Promise<BuildResult> {
  return db.transaction(async (tx) => {
    const lu = await loadMasterLookups(tx);
    const bySource: Record<string, number> = {};
    let inserted = 0;

    const pipelineSource = await tx.select().from(estimateQuoteSearch).where(eq(estimateQuoteSearch.isActive, true));
    const pipelineRows = buildPipelineRows(pipelineSource, lu, snapshotDate, snapshotTs);
    await insertInChunks(tx, pipelineRows);
    bySource.PIPELINE = pipelineRows.length;
    inserted += pipelineRows.length;

    const soSource = await tx.select().from(salesOrderSearch).where(eq(salesOrderSearch.isActive, true));
    const soRows = buildSalesOrderRows(soSource, lu, snapshotDate, snapshotTs);
    await insertInChunks(tx, soRows);
    bySource.SO = soRows.length;
    inserted += soRows.length;

    const invoiceSource = await tx.select().from(invoiceSearch).where(eq(invoiceSearch.isActive, true));
    const invoiceRows = buildInvoiceRows(invoiceSource, lu, snapshotDate, snapshotTs);
    await insertInChunks(tx, invoiceRows);
    bySource.INVOICE = invoiceRows.length;
    inserted += invoiceRows.length;

    const budgetSource = await tx.select().from(budgetSearch).where(eq(budgetSearch.isActive, true));
    const budgetRows = buildBudgetRows(budgetSource, lu, snapshotDate, snapshotTs);
    await insertInChunks(tx, budgetRows);
    bySource.BUDGET = budgetRows.length;
    inserted += budgetRows.length;

    return { inserted, bySource };
  });
}
