/**
 * BUDGET SEARCH — Create & Update service (single file)
 *
 * Writes to budget_search. Both endpoints accept EITHER a single object OR an
 * array (bulk) on the SAME route; every request is normalized to an array,
 * validated per-record with Zod, and run through the SAME `processBatch` flow, so
 * single and bulk share one code path.
 *
 * NetSuite is the caller, so every reference field carries a NetSuite INTERNAL id.
 * `resolveReferences` turns each into the portal DB id (via the master table's
 * unique netsuite_internal_id); an id with no match resolves to null (warning).
 *
 * NOTE: budget_search has its OWN column set (periods, forecast numerics, and FKs
 * to quarters / forecast_statuses / employees) — it does NOT share the
 * estimate/invoice/sales-order shape.
 */

import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import {
  budgetSearch,
  departments,
  customers,
  quarters,
  forecastStatuses,
  employees,
} from '../../db/schema/index.js';
import { AppError, ConflictError, NotFoundError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

// ── Validation schemas ───────────────────────────────────────────────────────

/**
 * Fields accepted when creating a budget_search row.
 * `netsuiteInternalId` is the record's NetSuite internal id (unique) and is
 * REQUIRED. Every `*InternalId` is a NetSuite internal id resolved to a portal DB
 * id before storing. Text / date / numeric / fiscalYear fields are stored as-is.
 */
export const BudgetCreateSchema = z.object({
  netsuiteInternalId            : z.string({ required_error: 'netsuiteInternalId is required' }).min(1).max(50),

  // Passthrough — plain text / dates / numerics
  name                          : z.string().max(500).optional(),
  soClosePeriod                 : z.string().optional(),
  leadTime                      : z.string().max(100).optional(),
  revenuePeriod                 : z.string().optional(),
  movedFromDate                 : z.string().optional(),
  revenueMovedToPeriod          : z.string().optional(),
  fiscalYear                    : z.coerce.number().int().optional(),
  budgetAmount                  : z.string().optional(),
  dilutionsPct                  : z.string().optional(),
  dilutionsAmt                  : z.string().optional(),
  netRevenue                    : z.string().optional(),
  projectedGm                   : z.string().optional(),
  projectedProfit               : z.string().optional(),
  trueGmGoal                    : z.string().optional(),
  forecastScenario              : z.string().max(255).optional(),
  consolidatedCustomerText      : z.string().max(500).optional(),

  // Reference fields — NetSuite internal ids resolved to portal DB ids
  soQtrInternalId               : z.string().max(50).optional(),
  revenueQtrInternalId          : z.string().max(50).optional(),
  forecastStatusInternalId      : z.string().max(50).optional(),
  departmentInternalId          : z.string().max(50).optional(),
  parentInternalId              : z.string().max(50).optional(),
  consolidatedCustomerInternalId: z.string().max(50).optional(),
  accountManagerInternalId      : z.string().max(50).optional(),
});

/**
 * Fields accepted when updating a budget_search row.
 * `netsuiteInternalId` is REQUIRED — the service locates the existing row by it.
 * Every other field is optional and only provided fields are changed.
 */
export const BudgetUpdateSchema = BudgetCreateSchema.partial().extend({
  netsuiteInternalId: z.string({ required_error: 'netsuiteInternalId is required' }).min(1).max(50),
});

export type BudgetCreateInput = z.infer<typeof BudgetCreateSchema>;
export type BudgetUpdateInput = z.infer<typeof BudgetUpdateSchema>;

// ── Plain (non-resolved) columns copied straight to the row ───────────────────

const PASSTHROUGH_FIELDS = [
  'name',
  'soClosePeriod',
  'leadTime',
  'revenuePeriod',
  'movedFromDate',
  'revenueMovedToPeriod',
  'fiscalYear',
  'budgetAmount',
  'dilutionsPct',
  'dilutionsAmt',
  'netRevenue',
  'projectedGm',
  'projectedProfit',
  'trueGmGoal',
  'forecastScenario',
  'consolidatedCustomerText',
] as const;

/** Pick the passthrough columns that are present on the record. */
function passthroughColumns(rec: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of PASSTHROUGH_FIELDS) {
    if (rec[k] !== undefined) out[k] = rec[k];
  }
  return out;
}

// ── NetSuite-internal-id → portal-DB-id resolution ────────────────────────────

interface FkResolver {
  /** payload field carrying the NetSuite internal id */
  field : string;
  /** master table to look up (has id + netsuiteInternalId) */
  table : any;
  /** budget_search column that receives the resolved DB id */
  column: string;
  /** stable per-table cache key (a table referenced by >1 field) */
  tkey  : string;
}

const FK_RESOLVERS: FkResolver[] = [
  { field: 'soQtrInternalId',                table: quarters,         column: 'soQtrId',                tkey: 'quarters' },
  { field: 'revenueQtrInternalId',           table: quarters,         column: 'revenueQtrId',           tkey: 'quarters' },
  { field: 'forecastStatusInternalId',       table: forecastStatuses, column: 'forecastStatusId',       tkey: 'forecastStatuses' },
  { field: 'departmentInternalId',           table: departments,      column: 'departmentId',           tkey: 'departments' },
  { field: 'parentInternalId',               table: customers,        column: 'parentId',               tkey: 'customers' },
  { field: 'consolidatedCustomerInternalId', table: customers,        column: 'consolidatedCustomerId', tkey: 'customers' },
  { field: 'accountManagerInternalId',       table: employees,        column: 'accountManagerId',       tkey: 'employees' },
];

/** Shared across a batch so a repeated NetSuite id is queried only once. */
type FkCache = Map<string, number | null>;

/**
 * Resolve every provided `*InternalId` on `rec` to its portal DB id. Returns the
 * budget_search columns to write, plus warnings for ids that matched no master
 * row (those columns are set to null and the row is still saved).
 */
async function resolveReferences(
  db: any,
  rec: Record<string, unknown>,
  cache: FkCache = new Map(),
): Promise<{ columns: Record<string, number | null>; warnings: string[] }> {
  const columns: Record<string, number | null> = {};
  const warnings: string[] = [];

  for (const { field, table, column, tkey } of FK_RESOLVERS) {
    const raw = rec[field];
    if (raw === undefined || raw === null || raw === '') continue;

    const value = String(raw);
    const cacheKey = `${tkey}:${value}`;

    let dbId: number | null;
    if (cache.has(cacheKey)) {
      dbId = cache.get(cacheKey)!;
    } else {
      const [row] = await db
        .select({ id: table.id })
        .from(table)
        .where(eq(table.netsuiteInternalId, value))
        .limit(1);
      dbId = row ? row.id : null;
      cache.set(cacheKey, dbId);
    }

    if (dbId === null) {
      warnings.push(`${field}='${value}' matched no ${tkey}; stored null`);
    }
    columns[column] = dbId;
  }

  return { columns, warnings };
}

// ── Single/bulk normalization ─────────────────────────────────────────────────

/** Recursively convert "" / null to undefined so optional fields accept blanks. */
function stripEmpty(val: unknown): unknown {
  if (val === '' || val === null) return undefined;
  if (Array.isArray(val)) return val.map(stripEmpty);
  if (val && typeof val === 'object') {
    return Object.fromEntries(
      Object.entries(val as Record<string, unknown>).map(([k, v]) => [k, stripEmpty(v)]),
    );
  }
  return val;
}

/**
 * Detect single vs. bulk, wrap a single object into a one-element array, and
 * validate every record with the supplied schema. A ZodError thrown here is
 * mapped to HTTP 400 by the global error handler.
 */
export function normalizeToArray<S extends z.ZodTypeAny>(
  body: unknown,
  schema: S,
): { records: z.output<S>[]; wasSingle: boolean } {
  const cleaned = stripEmpty(body);
  const wasSingle = !Array.isArray(cleaned);
  const arr = wasSingle ? [cleaned] : cleaned;
  const records = z.array(schema).parse(arr) as z.output<S>[];
  return { records, wasSingle };
}

// ── Shared batch processor ──────────────────────────────────────────────────

interface BatchSuccess<T> {
  index  : number;
  success: true;
  data   : T;
}

interface BatchFailure {
  index     : number;
  success   : false;
  error     : string;
  code?     : string;
  statusCode: number;
}

interface BatchResult<T> {
  total       : number;
  successCount: number;
  failureCount: number;
  succeeded   : BatchSuccess<T>[];
  failed      : BatchFailure[];
}

/**
 * Translate a thrown error into a clean failure shape. AppErrors keep their
 * status/code; raw PostgreSQL errors (surfaced via Drizzle's `cause`) are mapped
 * the same way the global error handler maps them, so per-record failures get a
 * meaningful message + status instead of a generic 500.
 */
function describeError(err: unknown): Omit<BatchFailure, 'index'> {
  if (err instanceof AppError) {
    return { success: false, error: err.message, code: err.code, statusCode: err.statusCode };
  }

  const cause: any = (err as any)?.cause ?? err;
  const dbCode: string | undefined = cause?.code;
  const detail: string | undefined = cause?.detail;

  if (dbCode === '23503') {
    return {
      success   : false,
      error     : detail ? `Invalid reference: ${detail}` : 'Invalid reference: one of the provided IDs does not exist',
      code      : 'INVALID_REFERENCE',
      statusCode: 400,
    };
  }
  if (dbCode === '23505') {
    return {
      success   : false,
      error     : detail ? `Duplicate entry: ${detail}` : 'Duplicate entry: a record with this value already exists',
      code      : 'DUPLICATE_ENTRY',
      statusCode: 409,
    };
  }

  return { success: false, error: err instanceof Error ? err.message : String(err), statusCode: 500 };
}

/**
 * Run `handler` against every item. Each item is processed independently — one
 * failure never aborts the rest — and the per-record outcome is collected so
 * bulk callers get full success/failure detail. Used by BOTH create and update.
 */
async function processBatch<TIn, TOut>(
  items: TIn[],
  handler: (item: TIn, index: number) => Promise<TOut>,
): Promise<BatchResult<TOut>> {
  const settled = await Promise.allSettled(items.map((it, i) => handler(it, i)));

  const succeeded: BatchSuccess<TOut>[] = [];
  const failed: BatchFailure[] = [];

  settled.forEach((res, index) => {
    if (res.status === 'fulfilled') {
      succeeded.push({ index, success: true, data: res.value });
    } else {
      failed.push({ index, ...describeError(res.reason) });
    }
  });

  return {
    total       : items.length,
    successCount: succeeded.length,
    failureCount: failed.length,
    succeeded,
    failed,
  };
}

/**
 * Shape a BatchResult for a request that came in as a SINGLE object.
 * Returns the created/updated row on success; rethrows the original error
 * (with its status code preserved) so the global handler responds correctly.
 */
export function unwrapSingle<T>(result: BatchResult<T>): T {
  const ok = result.succeeded[0];
  if (ok) return ok.data;
  const fail = result.failed[0];
  throw new AppError(fail.error, fail.statusCode, fail.code);
}

// ── CREATE ────────────────────────────────────────────────────────────────────

export async function createBudgets(records: BudgetCreateInput[]) {
  const db = getDb();
  const cache: FkCache = new Map();

  return processBatch(records, async (rec) => {
    // Reject duplicates on the NetSuite internal id (unique column).
    const [dup] = await db
      .select({ id: budgetSearch.id })
      .from(budgetSearch)
      .where(eq(budgetSearch.netsuiteInternalId, rec.netsuiteInternalId))
      .limit(1);

    if (dup) throw new ConflictError(`Budget '${rec.netsuiteInternalId}' already exists`);

    // Resolve every NetSuite internal id reference to its portal DB id.
    const { columns, warnings } = await resolveReferences(db, rec, cache);
    if (warnings.length) {
      logger.warn({ netsuiteInternalId: rec.netsuiteInternalId, warnings }, 'Unresolved references on budget create');
    }

    const row = {
      netsuiteInternalId: rec.netsuiteInternalId,
      ...passthroughColumns(rec),
      ...columns,
    };

    const [created] = await db
      .insert(budgetSearch)
      .values(row as typeof budgetSearch.$inferInsert)
      .returning();

    return created;
  });
}

// ── UPDATE ──────────────────────────────────────────────────────────────────

export async function updateBudgets(records: BudgetUpdateInput[]) {
  const db = getDb();
  const cache: FkCache = new Map();

  return processBatch(records, async (rec) => {
    const { netsuiteInternalId } = rec;

    // Locate the existing row by the NetSuite internal id — update only.
    const [existing] = await db
      .select({ id: budgetSearch.id })
      .from(budgetSearch)
      .where(eq(budgetSearch.netsuiteInternalId, netsuiteInternalId))
      .limit(1);

    if (!existing) throw new NotFoundError('Budget', netsuiteInternalId);

    // Resolve any provided reference fields (NetSuite internal id -> portal DB id).
    const { columns, warnings } = await resolveReferences(db, rec, cache);
    if (warnings.length) {
      logger.warn({ netsuiteInternalId, warnings }, 'Unresolved references on budget update');
    }

    const row = {
      ...passthroughColumns(rec),
      ...columns,
      updatedAt: new Date(),
    };

    const [updated] = await db
      .update(budgetSearch)
      .set(row)
      .where(eq(budgetSearch.id, existing.id))
      .returning();

    return updated;
  });
}
