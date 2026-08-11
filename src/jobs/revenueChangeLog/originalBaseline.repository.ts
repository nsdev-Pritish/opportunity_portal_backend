// Resolves the "Original Baseline" for a batch of source records — the
// first qualifying fact_revenue_snapshot row for each (source_type,
// internal_id) — per 2_Baseline Definitions:
//   - Pipeline: first snapshot where Likely to Close > 3 AND Foreign Amount > 0.
//     Records below that threshold may be stored but never establish a
//     baseline (10_Business Definitions, Pipeline row) — the WHERE clause
//     below simply excludes non-qualifying rows, so if a record has never
//     yet had a qualifying snapshot, it correctly resolves to "no baseline
//     yet" (undefined) rather than a wrong one. A non-numeric or
//     out-of-scale Likely to Close value (DQ-012) also just fails the
//     numeric-and->3 check and is skipped the same way.
//   - Open SO / Invoice: the first snapshot at all, no extra qualifying
//     condition (2_Baseline Definitions: "first valid creation-state record").
//
// fact_revenue_snapshot is append-only and rows are never edited, so
// "earliest qualifying row" always resolves to the same answer no matter
// when it's asked — that's what satisfies "the baseline must not be
// overwritten" (10_Business Definitions) without needing a separate table
// to cache it.

import { inArray, sql } from 'drizzle-orm';
import { factRevenueSnapshot } from '../../db/schema/index.js';
import type { DB } from '../../config/database.js';

export interface Baseline {
  internalId: string;
  foreignAmount: number | null;
  usdAmount: number | null;
  exchangeRate: number | null;
  revenuePeriod: string | null;
  currency: string | null;
}

type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];

interface BaselineRow {
  internal_id: string;
  foreign_amount: string | null;
  usd_amount: string | null;
  exchange_rate: string | null;
  revenue_period: string | null;
  currency: string | null;
}

function toBaseline(row: BaselineRow): Baseline {
  return {
    internalId: row.internal_id,
    foreignAmount: row.foreign_amount == null ? null : Number(row.foreign_amount),
    usdAmount: row.usd_amount == null ? null : Number(row.usd_amount),
    exchangeRate: row.exchange_rate == null ? null : Number(row.exchange_rate),
    revenuePeriod: row.revenue_period ?? null,
    currency: row.currency ?? null,
  };
}

/**
 * Batch-resolves baselines for every internalId of one source type in a
 * single query — never one query per record. Callers already group
 * internalIds by source type (Pipeline/SO/Invoice each need a different
 * qualifying clause), so this takes one homogeneous batch at a time.
 */
export async function findOriginalBaselines(
  db: DB | Tx,
  sourceType: 'PIPELINE' | 'SO' | 'INVOICE',
  internalIds: string[],
): Promise<Map<string, Baseline>> {
  if (internalIds.length === 0) return new Map();

  const qualifyingClause = sourceType === 'PIPELINE'
    ? sql`AND foreign_amount > 0 AND likely_to_close ~ '^[0-9]+$' AND likely_to_close::numeric > 3`
    : sql``;

  // internal_id membership goes through drizzle's inArray() rather than a raw
  // `= ANY(${internalIds})` — postgres.js needs an explicit array-typed bind,
  // and a plain interpolated JS array in a `sql` template serializes as a
  // single string parameter instead (confirmed: throws 22P02 "malformed
  // array literal"). inArray() expands to a proper parameterized IN (...).
  const rows = await db.execute(sql`
    SELECT DISTINCT ON (internal_id)
      internal_id, foreign_amount, usd_amount, exchange_rate, revenue_period, currency
    FROM fact_revenue_snapshot
    WHERE source_type = ${sourceType}
      AND ${inArray(factRevenueSnapshot.internalId, internalIds)}
      ${qualifyingClause}
    ORDER BY internal_id, snapshot_date ASC
  `) as unknown as BaselineRow[];

  return new Map([...rows].map(r => [r.internal_id, toBaseline(r)]));
}
