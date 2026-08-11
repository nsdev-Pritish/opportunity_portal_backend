// Builds fact_revenue_change_log rows between two snapshot dates — the
// "3_Change Rules" priority-ordered rule engine from
// AI_FPA_DW_Change_Log_Rules_v4.xlsx, translated to code.
//
// Unlike revenue_comparison (one row per anchor, always, changed or not),
// this table is an EVENT LOG: a row is written only when something actually
// happened (3_Change Rules, priority 99, "no_event... do not insert
// change-log row"). It also works at a finer grain — one row per SOURCE
// RECORD (source_record_id/document_number are singular columns), not
// summed across every record sharing an anchor the way revenue_comparison
// aggregates Open SO/Invoice.
//
// Two kinds of rows come out of a single run:
//   1. PER-RECORD rows (Steps A-C below) — currency changes, amount
//      increase/decrease/reverted/restored + change_driver, revenue-period
//      shifts, new records, and deleted records. One row per rule that
//      fires for that ONE record's own history — a record can trigger both
//      an amount rule AND a period rule in the same run, producing two rows
//      that share one change_group_id.
//   2. ANCHOR-LEVEL lifecycle rows (Step D) — the 3 explicitly named
//      cross-stage transitions (pipeline_to_so, partial_so_to_invoice,
//      final_so_to_invoice), read from the revenue_comparison row already
//      built for the same DOD date pair rather than re-derived here.
//      "Lifecycle rules take priority over generic amount-decrease rules"
//      (10_Business Definitions) — so the specific records consumed by a
//      lifecycle event (the pipeline row that disappeared, the SO row that
//      appeared) are EXCLUDED from the per-record pass, so the same
//      occurrence is never reported twice from two different angles.
//
// Re-run safety: this deletes any existing rows for the (from, to) date
// pair before inserting the freshly computed set, all in one transaction —
// simpler and just as safe as an upsert here, since one comparison can
// produce 0-2 rows per record and there's no single natural per-row
// conflict key the way revenue_comparison has one row per anchor.

import { and, eq, inArray, sql } from 'drizzle-orm';
import { factRevenueSnapshot, factRevenueChangeLog, revenueComparison } from '../../db/schema/index.js';
import type { DB } from '../../config/database.js';
import { CHANGELOG_INSERT_CHUNK_SIZE, AMOUNT_EPSILON } from './config.js';
import { findOriginalBaselines, type Baseline } from './originalBaseline.repository.js';

type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];
type SnapshotRow = typeof factRevenueSnapshot.$inferSelect;
type ChangeLogRow = typeof factRevenueChangeLog.$inferInsert;

const STAGE_SOURCE_TYPES = ['PIPELINE', 'SO', 'INVOICE'] as const;
type StageSourceType = typeof STAGE_SOURCE_TYPES[number];

function isStageSourceType(s: string): s is StageSourceType {
  return (STAGE_SOURCE_TYPES as readonly string[]).includes(s);
}

function recordKey(sourceType: string, internalId: string): string {
  return `${sourceType}:${internalId}`;
}

/** One row per (source_type, internal_id) is expected — a duplicate for the same key on the same day just wins (last one). */
function groupByRecordKey(rows: SnapshotRow[]): Map<string, SnapshotRow> {
  const map = new Map<string, SnapshotRow>();
  for (const row of rows) {
    if (!isStageSourceType(row.sourceType) || !row.internalId) continue;
    map.set(recordKey(row.sourceType, row.internalId), row);
  }
  return map;
}

function num(v: string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isZero(n: number | null): boolean {
  return n == null || Math.abs(n) < AMOUNT_EPSILON;
}

function monthDiff(fromISODate: string, toISODate: string): number {
  const [fy, fm] = fromISODate.slice(0, 7).split('-').map(Number);
  const [ty, tm] = toISODate.slice(0, 7).split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

function baseFields(row: {
  sourceType: string;
  internalId: string;
  anchorId: string; // callers guard non-null before calling — never actually null at this point
  documentNumber: string | null;
  currency: string | null;
}) {
  return {
    sourceType: row.sourceType,
    sourceRecordId: row.internalId,
    documentNumber: row.documentNumber,
    anchorId: row.anchorId,
    currency: row.currency,
  };
}

// ─── Per-record rule engine (Steps A-C) ─────────────────────────────────

interface RecordChangeContext {
  key: string;
  prior: SnapshotRow | undefined;
  current: SnapshotRow | undefined;
  baseline: Baseline | undefined;
  fromDate: string;
  toDate: string;
}

function buildRecordChangeRows(ctx: RecordChangeContext): ChangeLogRow[] {
  const { prior, current, baseline, fromDate, toDate } = ctx;
  const anchor = current ?? prior;
  if (!anchor || !anchor.anchorId) return []; // no anchor to attribute the event to — shouldn't happen for an active SO/Invoice, but guard anyway
  const groupId = crypto.randomUUID();
  const rows: ChangeLogRow[] = [];

  const common = {
    ...baseFields({
      sourceType: anchor.sourceType,
      internalId: anchor.internalId,
      anchorId: anchor.anchorId,
      documentNumber: anchor.documentNumber,
      currency: anchor.currency,
    }),
    changeGroupId: groupId,
    fromSnapshotDate: fromDate,
    toSnapshotDate: toDate,
    originalForeignAmount: baseline?.foreignAmount?.toFixed(2) ?? null,
    originalReportedUsdAmount: baseline?.usdAmount?.toFixed(2) ?? null,
    originalExchangeRate: baseline?.exchangeRate?.toFixed(8) ?? null,
    originalRevenuePeriod: baseline?.revenuePeriod ?? null,
  };

  // ── New record: nothing on the prior date at all (DQ-016: "treat as a new record or baseline event, not an amount change"). ──
  if (!prior && current) {
    const currentFc = num(current.foreignAmount);
    const originalFc = baseline?.foreignAmount ?? null;
    rows.push({
      ...common,
      changeEventId: crypto.randomUUID(),
      changeType: `${current.sourceType.toLowerCase()}_added`,
      changeDriver: 'BUSINESS',
      priorForeignAmount: null,
      currentForeignAmount: current.foreignAmount,
      foreignDeltaVsPrior: currentFc?.toFixed(2) ?? null,
      foreignDeltaVsOriginal: currentFc != null && originalFc != null ? (currentFc - originalFc).toFixed(2) : null,
      priorReportedUsdAmount: null,
      currentReportedUsdAmount: current.usdAmount,
      priorExchangeRate: null,
      currentExchangeRate: current.exchangeRate,
      fxOnlyChangeFlag: false,
      priorRevenuePeriod: null,
      currentRevenuePeriod: current.revenuePeriod,
      monthsShiftedVsPrior: null,
      monthsShiftedVsOriginal: baseline?.revenuePeriod && current.revenuePeriod ? monthDiff(baseline.revenuePeriod, current.revenuePeriod) : null,
      changeDescription: `${current.documentNumber ?? current.internalId} is a new ${current.sourceType} record, ${current.currency ?? ''} ${current.foreignAmount ?? ''}.`.trim(),
      controlSeverity: 'INFO',
    });
    return rows;
  }

  // ── Deleted record: existed prior, absent now. Fires once — a later run where it's absent from both dates produces no row at all. ──
  if (prior && !current) {
    rows.push({
      ...common,
      changeEventId: crypto.randomUUID(),
      changeType: 'DELETED',
      changeDriver: 'LIFECYCLE',
      priorForeignAmount: prior.foreignAmount,
      currentForeignAmount: '0.00',
      foreignDeltaVsPrior: num(prior.foreignAmount) != null ? (-num(prior.foreignAmount)!).toFixed(2) : null,
      foreignDeltaVsOriginal: null,
      priorReportedUsdAmount: prior.usdAmount,
      currentReportedUsdAmount: null,
      priorExchangeRate: prior.exchangeRate,
      currentExchangeRate: null,
      fxOnlyChangeFlag: false,
      priorRevenuePeriod: prior.revenuePeriod,
      currentRevenuePeriod: null,
      monthsShiftedVsPrior: null,
      monthsShiftedVsOriginal: null,
      changeDescription: `${prior.documentNumber ?? prior.internalId} was removed from the ${prior.sourceType} snapshot; last known value was ${prior.currency ?? ''} ${prior.foreignAmount ?? ''}.`.trim(),
      controlSeverity: 'WARNING',
    });
    return rows;
  }

  if (!prior || !current) return rows; // neither exists — unreachable (key wouldn't exist), but keeps TS satisfied

  // ── Step A: currency control check — takes priority over amount comparison, since FC can't be reliably diffed across currencies. ──
  if (prior.currency && current.currency && prior.currency !== current.currency) {
    rows.push({
      ...common,
      changeEventId: crypto.randomUUID(),
      changeType: 'currency_changed',
      changeDriver: 'DATA_QUALITY',
      priorForeignAmount: prior.foreignAmount,
      currentForeignAmount: current.foreignAmount,
      foreignDeltaVsPrior: null, // deliberately not computed — amounts are in two different currencies
      foreignDeltaVsOriginal: null,
      priorReportedUsdAmount: prior.usdAmount,
      currentReportedUsdAmount: current.usdAmount,
      priorExchangeRate: prior.exchangeRate,
      currentExchangeRate: current.exchangeRate,
      fxOnlyChangeFlag: false,
      priorRevenuePeriod: prior.revenuePeriod,
      currentRevenuePeriod: current.revenuePeriod,
      monthsShiftedVsPrior: null,
      monthsShiftedVsOriginal: null,
      changeDescription: `${current.documentNumber ?? current.internalId} changed currency from ${prior.currency} to ${current.currency} — amounts are not comparable until this is resolved.`,
      controlSeverity: 'CRITICAL',
    });
    // Currency changed — skip the amount rule (Step B) entirely, but the period rule (Step C) is independent of currency and still runs.
  } else {
    rows.push(...buildAmountRuleRow(common, prior, current, baseline));
  }

  const periodRow = buildPeriodRuleRow(common, prior, current, baseline);
  if (periodRow) rows.push(periodRow);

  return rows;
}

function buildAmountRuleRow(
  common: Record<string, unknown>,
  prior: SnapshotRow,
  current: SnapshotRow,
  baseline: Baseline | undefined,
): ChangeLogRow[] {
  const priorFc = num(prior.foreignAmount);
  const currentFc = num(current.foreignAmount);
  const originalFc = baseline?.foreignAmount ?? null;
  if (priorFc == null || currentFc == null) return [];

  const fcDelta = currentFc - priorFc;
  const isAtOriginal = originalFc != null && Math.abs(currentFc - originalFc) < AMOUNT_EPSILON;
  const wasAtOriginal = originalFc != null && Math.abs(priorFc - originalFc) < AMOUNT_EPSILON;

  let changeType: string | null = null;
  if (isAtOriginal && !wasAtOriginal) {
    // Two named rules share this condition family (3_Change Rules, priority 10 vs 11) — the
    // more specific one (came back UP after dropping below original) is "restored"; anything
    // else that lands back on original (e.g. came back down from above) is "reverted".
    changeType = priorFc! < originalFc! ? `${current.sourceType.toLowerCase()}_amount_restored_to_original` : `${current.sourceType.toLowerCase()}_amount_reverted_to_original`;
  } else if (fcDelta > AMOUNT_EPSILON) {
    changeType = `${current.sourceType.toLowerCase()}_amount_increase`;
  } else if (fcDelta < -AMOUNT_EPSILON) {
    changeType = `${current.sourceType.toLowerCase()}_amount_decrease`;
  }

  const priorRate = num(prior.exchangeRate);
  const currentRate = num(current.exchangeRate);
  const rateChanged = priorRate != null && currentRate != null && Math.abs(currentRate - priorRate) > 1e-6;
  const priorUsd = num(prior.usdAmount);
  const currentUsd = num(current.usdAmount);
  const usdChanged = priorUsd != null && currentUsd != null && Math.abs(currentUsd - priorUsd) > AMOUNT_EPSILON;

  if (changeType) {
    const driver = rateChanged ? 'BUSINESS_AND_FX' : 'BUSINESS';
    return [{
      ...common,
      changeEventId: crypto.randomUUID(),
      changeType,
      changeDriver: driver,
      priorForeignAmount: prior.foreignAmount,
      currentForeignAmount: current.foreignAmount,
      foreignDeltaVsPrior: fcDelta.toFixed(2),
      foreignDeltaVsOriginal: originalFc != null ? (currentFc - originalFc).toFixed(2) : null,
      priorReportedUsdAmount: prior.usdAmount,
      currentReportedUsdAmount: current.usdAmount,
      priorExchangeRate: prior.exchangeRate,
      currentExchangeRate: current.exchangeRate,
      reportedUsdDeltaVsPrior: priorUsd != null && currentUsd != null ? (currentUsd - priorUsd).toFixed(2) : null,
      fxOnlyChangeFlag: false,
      changeDescription: `${current.documentNumber ?? current.internalId} ${changeType.endsWith('increase') ? 'increased' : changeType.endsWith('decrease') ? 'decreased' : 'returned to its original value'} by ${current.currency ?? ''} ${Math.abs(fcDelta).toFixed(2)}${rateChanged ? '; the exchange rate also moved.' : '.'}`,
      controlSeverity: 'INFO',
    } as ChangeLogRow];
  }

  // FC unchanged — a pure FX-translation event is still worth its own row (6_FX Logic): USD/rate moved with no commercial change.
  if (isZero(fcDelta) && rateChanged && usdChanged) {
    return [{
      ...common,
      changeEventId: crypto.randomUUID(),
      changeType: `${current.sourceType.toLowerCase()}_fx_translation_only`,
      changeDriver: 'FX_ONLY',
      priorForeignAmount: prior.foreignAmount,
      currentForeignAmount: current.foreignAmount,
      foreignDeltaVsPrior: '0.00',
      foreignDeltaVsOriginal: originalFc != null ? (currentFc - originalFc).toFixed(2) : null,
      priorReportedUsdAmount: prior.usdAmount,
      currentReportedUsdAmount: current.usdAmount,
      priorExchangeRate: prior.exchangeRate,
      currentExchangeRate: current.exchangeRate,
      reportedUsdDeltaVsPrior: priorUsd != null && currentUsd != null ? (currentUsd - priorUsd).toFixed(2) : null,
      fxOnlyChangeFlag: true,
      changeDescription: `${current.documentNumber ?? current.internalId} reported USD ${currentUsd! > priorUsd! ? 'increased' : 'decreased'} by $${Math.abs(currentUsd! - priorUsd!).toFixed(2)} solely because of exchange-rate movement; no commercial amount change occurred.`,
      controlSeverity: 'INFO',
    } as ChangeLogRow];
  }

  return []; // Foreign Amount unchanged and no FX-only event either — no amount-side row (no_event, priority 99, for this dimension).
}

function buildPeriodRuleRow(
  common: Record<string, unknown>,
  prior: SnapshotRow,
  current: SnapshotRow,
  baseline: Baseline | undefined,
): ChangeLogRow | null {
  const priorPeriod = prior.revenuePeriod;
  const currentPeriod = current.revenuePeriod;

  let changeType: string | null = null;
  const source = current.sourceType.toLowerCase();
  if (!priorPeriod && currentPeriod) {
    changeType = `${source}_period_assigned`;
  } else if (priorPeriod && !currentPeriod) {
    changeType = `${source}_period_removed`;
  } else if (priorPeriod && currentPeriod && priorPeriod !== currentPeriod) {
    if (baseline?.revenuePeriod && currentPeriod === baseline.revenuePeriod && priorPeriod !== baseline.revenuePeriod) {
      changeType = `${source}_period_reverted_to_original`;
    } else {
      changeType = currentPeriod > priorPeriod ? `${source}_period_shift_later` : `${source}_period_shift_earlier`;
    }
  }
  if (!changeType) return null; // Revenue Month unchanged — no period-side row (no_event, priority 99, for this dimension).

  return {
    ...common,
    changeEventId: crypto.randomUUID(),
    changeType,
    changeDriver: 'PERIOD',
    priorForeignAmount: prior.foreignAmount,
    currentForeignAmount: current.foreignAmount,
    priorReportedUsdAmount: prior.usdAmount,
    currentReportedUsdAmount: current.usdAmount,
    priorExchangeRate: prior.exchangeRate,
    currentExchangeRate: current.exchangeRate,
    fxOnlyChangeFlag: false,
    priorRevenuePeriod: priorPeriod,
    currentRevenuePeriod: currentPeriod,
    monthsShiftedVsPrior: priorPeriod && currentPeriod ? monthDiff(priorPeriod, currentPeriod) : null,
    monthsShiftedVsOriginal: baseline?.revenuePeriod && currentPeriod ? monthDiff(baseline.revenuePeriod, currentPeriod) : null,
    changeDescription: `${current.documentNumber ?? current.internalId} moved from ${priorPeriod ?? 'no assigned period'} to ${currentPeriod ?? 'no assigned period'}.`,
    controlSeverity: 'INFO',
  } as ChangeLogRow;
}

// ─── Anchor-level lifecycle rows (Step D) ────────────────────────────────

const LIFECYCLE_MAP: Record<string, { changeType: string; originType: StageSourceType; resultType: StageSourceType }> = {
  PIPELINE_CONVERTED_TO_SO: { changeType: 'pipeline_to_so', originType: 'PIPELINE', resultType: 'SO' },
  SO_PARTIALLY_INVOICED: { changeType: 'partial_so_to_invoice', originType: 'SO', resultType: 'INVOICE' },
  SO_FULLY_INVOICED: { changeType: 'final_so_to_invoice', originType: 'SO', resultType: 'INVOICE' },
};

interface LifecycleBuildResult {
  rows: ChangeLogRow[];
  /** (sourceType, internalId) keys already accounted for by a lifecycle row — excluded from the per-record pass so the same occurrence isn't logged twice. */
  consumedKeys: Set<string>;
}

/**
 * Reads the lifecycle events revenue_comparison already detected for this
 * exact DOD date pair and turns the 3 explicitly named ones (13_Expected
 * Outputs' worked "pipeline_to_so_conversion" row is the field-mapping
 * reference used below) into their own change-log rows — rather than
 * re-deriving lifecycle detection here a second time.
 */
async function buildLifecycleChangeRows(tx: Tx, fromDate: string, toDate: string): Promise<LifecycleBuildResult> {
  const anchors = await tx.select({
    anchorId: revenueComparison.anchorId,
    lifecycleEvent: revenueComparison.lifecycleEvent,
    currency: revenueComparison.currency,
  }).from(revenueComparison).where(and(
    eq(revenueComparison.reportType, 'DOD'),
    eq(revenueComparison.priorSnapshotPeriod, fromDate),
    eq(revenueComparison.currentSnapshotPeriod, toDate),
    inArray(revenueComparison.lifecycleEvent, Object.keys(LIFECYCLE_MAP)),
  ));

  const rows: ChangeLogRow[] = [];
  const consumedKeys = new Set<string>();

  for (const a of anchors) {
    const mapping = LIFECYCLE_MAP[a.lifecycleEvent!];
    if (!mapping || !a.anchorId) continue;

    // The resulting stage's CURRENT record (e.g. the new SO, or the invoice) — dominant by amount if more than one shares the anchor.
    const resultRows = await tx.select().from(factRevenueSnapshot).where(and(
      eq(factRevenueSnapshot.snapshotDate, toDate),
      eq(factRevenueSnapshot.sourceType, mapping.resultType),
      eq(factRevenueSnapshot.anchorId, a.anchorId),
    ));
    const resultRow = pickDominant(resultRows);
    if (!resultRow) continue; // data moved between the runs — skip rather than guess

    // The origin stage's PRIOR record (e.g. the pipeline row that disappeared, or the SO before invoicing) — this is what the baseline is inherited from.
    const originRows = await tx.select().from(factRevenueSnapshot).where(and(
      eq(factRevenueSnapshot.snapshotDate, fromDate),
      eq(factRevenueSnapshot.sourceType, mapping.originType),
      eq(factRevenueSnapshot.anchorId, a.anchorId),
    ));
    const originRow = pickDominant(originRows);

    consumedKeys.add(recordKey(mapping.resultType, resultRow.internalId));
    if (originRow) consumedKeys.add(recordKey(mapping.originType, originRow.internalId));

    const baselineMap = originRow
      ? await findOriginalBaselines(tx, mapping.originType, [originRow.internalId])
      : new Map<string, Baseline>();
    const baseline = originRow ? baselineMap.get(originRow.internalId) : undefined;

    const currentFc = num(resultRow.foreignAmount);
    const originalFc = baseline?.foreignAmount ?? null;
    const currentUsd = num(resultRow.usdAmount);

    rows.push({
      ...baseFields({
        sourceType: resultRow.sourceType,
        internalId: resultRow.internalId,
        anchorId: a.anchorId,
        documentNumber: resultRow.documentNumber,
        currency: resultRow.currency ?? a.currency,
      }),
      changeEventId: crypto.randomUUID(),
      changeGroupId: crypto.randomUUID(),
      changeType: mapping.changeType,
      changeDriver: 'LIFECYCLE',
      fromSnapshotDate: fromDate,
      toSnapshotDate: toDate,
      originalForeignAmount: baseline?.foreignAmount?.toFixed(2) ?? null,
      priorForeignAmount: null, // the resulting record has no prior state of its own — it's newly appearing this run
      currentForeignAmount: resultRow.foreignAmount,
      foreignDeltaVsPrior: currentFc?.toFixed(2) ?? null, // prior treated as 0, per 13_Expected Outputs' worked lifecycle row
      foreignDeltaVsOriginal: currentFc != null && originalFc != null ? (currentFc - originalFc).toFixed(2) : null,
      originalReportedUsdAmount: baseline?.usdAmount?.toFixed(2) ?? null,
      priorReportedUsdAmount: null,
      currentReportedUsdAmount: resultRow.usdAmount,
      reportedUsdDeltaVsPrior: currentUsd?.toFixed(2) ?? null,
      originalExchangeRate: baseline?.exchangeRate?.toFixed(8) ?? null,
      priorExchangeRate: null,
      currentExchangeRate: resultRow.exchangeRate,
      fxOnlyChangeFlag: false,
      originalRevenuePeriod: baseline?.revenuePeriod ?? null,
      priorRevenuePeriod: originRow?.revenuePeriod ?? null,
      currentRevenuePeriod: resultRow.revenuePeriod,
      monthsShiftedVsPrior: null,
      monthsShiftedVsOriginal: baseline?.revenuePeriod && resultRow.revenuePeriod ? monthDiff(baseline.revenuePeriod, resultRow.revenuePeriod) : null,
      changeDescription: describeLifecycle(mapping.changeType, originRow, resultRow),
      controlSeverity: 'INFO',
    } as ChangeLogRow);
  }

  return { rows, consumedKeys };
}

function pickDominant(rows: SnapshotRow[]): SnapshotRow | undefined {
  if (rows.length === 0) return undefined;
  return rows.reduce((best, r) => (num(r.foreignAmount) ?? 0) > (num(best.foreignAmount) ?? 0) ? r : best, rows[0]);
}

function describeLifecycle(changeType: string, originRow: SnapshotRow | undefined, resultRow: SnapshotRow): string {
  const amount = `${resultRow.currency ?? ''} ${resultRow.foreignAmount ?? ''}`.trim();
  if (changeType === 'pipeline_to_so') {
    return `${originRow?.documentNumber ?? 'The originating pipeline record'} converted to ${resultRow.documentNumber} with ${amount} of order value.`;
  }
  return `${originRow?.documentNumber ?? 'The originating sales order'} was invoiced through ${resultRow.documentNumber} for ${amount}.`;
}

// ─── Orchestration ────────────────────────────────────────────────────────

export interface ChangeLogResult {
  fromDate: string;
  toDate: string;
  inserted: number;
}

async function insertInChunks(tx: Tx, rows: ChangeLogRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += CHANGELOG_INSERT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHANGELOG_INSERT_CHUNK_SIZE);
    if (chunk.length > 0) await tx.insert(factRevenueChangeLog).values(chunk);
  }
}

/**
 * Builds the change log for one (fromDate, toDate) pair. Assumes revenue_comparison
 * has already been built for this exact pair as report_type='DOD' — lifecycle
 * detection reads it rather than re-deriving it.
 *
 * Re-run safe: deletes any existing rows for this date pair before inserting
 * the freshly computed set, in the same transaction.
 */
export async function buildChangeLog(db: DB, fromDate: string, toDate: string): Promise<ChangeLogResult> {
  return db.transaction(async (tx) => {
    const [priorRows, currentRows] = await Promise.all([
      tx.select().from(factRevenueSnapshot).where(and(
        eq(factRevenueSnapshot.snapshotDate, fromDate),
        inArray(factRevenueSnapshot.sourceType, STAGE_SOURCE_TYPES),
      )),
      tx.select().from(factRevenueSnapshot).where(and(
        eq(factRevenueSnapshot.snapshotDate, toDate),
        inArray(factRevenueSnapshot.sourceType, STAGE_SOURCE_TYPES),
      )),
    ]);

    const priorByKey = groupByRecordKey(priorRows);
    const currentByKey = groupByRecordKey(currentRows);

    // Step D first — lifecycle rows take priority, and the keys they consume must not also get a generic per-record row.
    const { rows: lifecycleRows, consumedKeys } = await buildLifecycleChangeRows(tx, fromDate, toDate);

    const allKeys = new Set<string>([...priorByKey.keys(), ...currentByKey.keys()]);
    const remainingKeys = [...allKeys].filter(k => !consumedKeys.has(k));

    // Batch baseline lookups, grouped by source type, for every record still needing the per-record pass.
    const byType: Record<StageSourceType, string[]> = { PIPELINE: [], SO: [], INVOICE: [] };
    for (const key of remainingKeys) {
      const [sourceType, internalId] = key.split(':') as [StageSourceType, string];
      byType[sourceType].push(internalId);
    }
    const baselineMaps = await Promise.all(
      STAGE_SOURCE_TYPES.map(st => findOriginalBaselines(tx, st, byType[st])),
    );
    const baselineByKey = new Map<string, Baseline>();
    STAGE_SOURCE_TYPES.forEach((st, i) => {
      for (const [internalId, baseline] of baselineMaps[i]) baselineByKey.set(recordKey(st, internalId), baseline);
    });

    const recordRows: ChangeLogRow[] = [];
    for (const key of remainingKeys) {
      recordRows.push(...buildRecordChangeRows({
        key,
        prior: priorByKey.get(key),
        current: currentByKey.get(key),
        baseline: baselineByKey.get(key),
        fromDate,
        toDate,
      }));
    }

    const allRows = [...lifecycleRows, ...recordRows];

    await tx.delete(factRevenueChangeLog).where(and(
      eq(factRevenueChangeLog.fromSnapshotDate, fromDate),
      eq(factRevenueChangeLog.toSnapshotDate, toDate),
    ));
    await insertInChunks(tx, allRows);

    return { fromDate, toDate, inserted: allRows.length };
  });
}
