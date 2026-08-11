// revenue_change_log builder — anchor-grain, plain-language business events,
// derived from revenue_comparison rows immediately after each runComparison().
//
// Contract: only MEANINGFUL events are written. A comparison row where
// nothing moved produces zero change-log rows (rule 8), so every row in the
// table is by definition worth a human's attention, and change_description
// carries the whole explanation in words — a BI dashboard or an AI tool reads
// that column directly and never re-derives any of the rules below.
//
// ── How this maps onto the tables that actually exist here ────────────────
// The rule spec is written against a generic prior/current pair
// (prior_foreign_amount, current_exchange_rate, prior_revenue_period, ...).
// revenue_comparison does not have those columns — it is a WIDE, per-stage
// table (prior_pipeline_amt / current_pipeline_amt / prior_open_so_amt /
// current_open_so_amt / prior_invoice_amt / current_invoice_amt, each with
// its own revenue-date pair) and it carries no exchange rate at all. So:
//
//   * foreign amounts + revenue periods come from ONE stage of the
//     comparison row, chosen by pickStage() — see its comment.
//   * currency, exchange rate, reported USD, document_number and
//     source_record_id are not on revenue_comparison, and are read back from
//     fact_revenue_snapshot for the same (anchor, stage, snapshot date).
//     The rule spec anticipates exactly this for the currency check
//     ("fetch from fact_revenue_snapshot if not already on the comparison
//     row"); the same fetch supplies the FX fields.
//
// enrichComparisonRow() does that resolution up front, so
// evaluateChangeRules() itself stays pure, synchronous and directly unit
// testable against a plain object.
//
// ── Lifecycle values ──────────────────────────────────────────────────────
// The rule spec lists lifecycle_event as prose ('Pipeline converted to Sales
// Order'). revenue_comparison actually stores UPPER_SNAKE codes
// ('PIPELINE_CONVERTED_TO_SO') — see classifyLifecycleEvent() in
// ../revenueComparison/comparisonBuilder.ts. Matching the prose literally
// would make rule 1 dead code that never fires, so LIFECYCLE_EVENT_MAP below
// matches the codes the table really holds and writes the prose form into
// change_type, which is what the spec wants stored.

import { and, eq, inArray, sql } from 'drizzle-orm';
import { factRevenueSnapshot, revenueComparison, revenueChangeLog } from '../../db/schema/index.js';
import type { DB } from '../../config/database.js';
import { AMOUNT_EPSILON, RATE_EPSILON, CHANGELOG_INSERT_CHUNK_SIZE } from './config.js';

type ChangeLogRow = typeof revenueChangeLog.$inferInsert;

/**
 * The subset of revenue_comparison the rules actually read — 18 of its 40
 * columns. Narrowed on purpose: the batch select is by far the most expensive
 * thing this job does (measured at 66s for 8,999 rows against a remote
 * database), and that cost is almost entirely bytes on the wire, so pulling
 * the 22 columns nothing here touches doubles it for nothing.
 */
const COMPARISON_COLUMNS = {
  anchorId: revenueComparison.anchorId,
  reportType: revenueComparison.reportType,
  priorSnapshotPeriod: revenueComparison.priorSnapshotPeriod,
  currentSnapshotPeriod: revenueComparison.currentSnapshotPeriod,
  lifecycleEvent: revenueComparison.lifecycleEvent,
  currency: revenueComparison.currency,

  priorPipelineAmt: revenueComparison.priorPipelineAmt,
  currentPipelineAmt: revenueComparison.currentPipelineAmt,
  priorPipelineRevDate: revenueComparison.priorPipelineRevDate,
  currentPipelineRevDate: revenueComparison.currentPipelineRevDate,

  priorOpenSoAmt: revenueComparison.priorOpenSoAmt,
  currentOpenSoAmt: revenueComparison.currentOpenSoAmt,
  priorSoRevDate: revenueComparison.priorSoRevDate,
  currentSoRevDate: revenueComparison.currentSoRevDate,

  priorInvoiceAmt: revenueComparison.priorInvoiceAmt,
  currentInvoiceAmt: revenueComparison.currentInvoiceAmt,
  priorInvoiceDate: revenueComparison.priorInvoiceDate,
  currentInvoiceDate: revenueComparison.currentInvoiceDate,
} as const;

/** A revenue_comparison row as this job reads it — see COMPARISON_COLUMNS. */
export type ComparisonRow = {
  [K in keyof typeof COMPARISON_COLUMNS]: typeof revenueComparison.$inferSelect[K];
};

// ══════════════════════════════════════════════════════════════════════════
//  SEVERITY CONFIG — PLACEHOLDER VALUES, NOT YET CONFIRMED BY THE BUSINESS
// ══════════════════════════════════════════════════════════════════════════
// ⚠ EVERY NUMBER IN THIS BLOCK IS A PLACEHOLDER PENDING CLIENT CONFIRMATION.
// Nothing outside this object decides severity, and no threshold is repeated
// anywhere else in this file — change a value here and the whole job follows.
// Do not rely on these bands for production controls or alerting until the
// business has signed them off.
export const SEVERITY_THRESHOLDS = {
  /** |foreign_delta_vs_prior| at or below this ⇒ INFO. PLACEHOLDER — CONFIRM WITH BUSINESS. */
  info_max_abs_amount: 5000,
  /** |foreign_delta_vs_prior| at or below this (and above info) ⇒ WARNING. PLACEHOLDER — CONFIRM WITH BUSINESS. */
  warning_max_abs_amount: 50000,
  // Anything above warning_max_abs_amount ⇒ CRITICAL.

  // Lifecycle and currency events are always REVIEW or WARNING regardless of
  // amount — a stage transition or a currency flip matters because of WHAT it
  // is, not how big it is. Also placeholders, but of the "which band" kind
  // rather than the "which number" kind.
  /** Stage transitions (pipeline→SO, SO→invoice, new pipeline record). PLACEHOLDER — CONFIRM WITH BUSINESS. */
  lifecycle_severity: 'REVIEW',
  /** An anchor disappearing from the snapshot. Held above generic lifecycle because it silently removes revenue. PLACEHOLDER — CONFIRM WITH BUSINESS. */
  deleted_severity: 'WARNING',
  /** Currency flipped between snapshots — foreign amounts stop being comparable. Fixed at WARNING by the rule spec. PLACEHOLDER — CONFIRM WITH BUSINESS. */
  currency_change_severity: 'WARNING',
  /** Revenue period moved. The amount delta is 0 for a pure shift, so an amount band would always say INFO and understate it. PLACEHOLDER — CONFIRM WITH BUSINESS. */
  period_shift_severity: 'REVIEW',
  /** Amount returned to its original baseline. PLACEHOLDER — CONFIRM WITH BUSINESS. */
  reverted_to_original_severity: 'REVIEW',
} as const;

export type ControlSeverity = 'INFO' | 'REVIEW' | 'WARNING' | 'CRITICAL';

/**
 * The only place an amount becomes a severity. Used for the BUSINESS / FX /
 * BUSINESS_AND_FX change types, per the rule spec; the fixed-band event types
 * above read their severity straight from SEVERITY_THRESHOLDS instead.
 */
function severityForAmount(foreignDeltaVsPrior: number | null): ControlSeverity {
  const magnitude = Math.abs(foreignDeltaVsPrior ?? 0);
  if (magnitude <= SEVERITY_THRESHOLDS.info_max_abs_amount) return 'INFO';
  if (magnitude <= SEVERITY_THRESHOLDS.warning_max_abs_amount) return 'WARNING';
  return 'CRITICAL';
}

// ══════════════════════════════════════════════════════════════════════════
//  Change types + lifecycle mapping
// ══════════════════════════════════════════════════════════════════════════

export const CHANGE_TYPES = {
  CURRENCY_CHANGE: 'Currency Change',
  REVERTED_TO_ORIGINAL: 'Reverted to Original',
  FX_ONLY: 'FX Only Change',
  BUSINESS_AND_FX: 'Business + FX Change',
  REVENUE_INCREASE: 'Revenue Increase',
  REVENUE_DECREASE: 'Revenue Decrease',
  REVENUE_SHIFT: 'Revenue Shift',
} as const;

/**
 * revenue_comparison.lifecycle_event code → the prose change_type this table
 * stores. Only these codes are lifecycle events for rule 1; every other code
 * classifyLifecycleEvent() can emit (PIPELINE_AMOUNT_INCREASED, SO_AMOUNT_*,
 * OTHER_CHANGE, NO_CHANGE, ...) is deliberately absent, because those are
 * amount movements that rules 3-6 classify more precisely from the actual
 * numbers — routing them through rule 1 would STOP evaluation and throw away
 * the FX/period detail.
 *
 * ADDED_TO_SO_NO_PIPELINE and INVOICED_NO_LINKED_SO are also absent on
 * purpose: they are the "we never saw the earlier stage" variants, which is a
 * data-completeness question rather than an observed transition. They fall
 * through to the amount rules. FLAGGED AS AN ASSUMPTION.
 */
export const LIFECYCLE_EVENT_MAP: Record<string, string> = {
  PIPELINE_CONVERTED_TO_SO: 'Pipeline converted to Sales Order',
  SO_PARTIALLY_INVOICED: 'SO partially invoiced',
  SO_FULLY_INVOICED: 'SO fully invoiced',
  ADDED_TO_PIPELINE: 'New pipeline record added',
  PIPELINE_DELETED: 'Deleted',
  SO_DELETED: 'Deleted',
};

const DELETED = 'Deleted';

// ══════════════════════════════════════════════════════════════════════════
//  Small numeric / date helpers
// ══════════════════════════════════════════════════════════════════════════

function num(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Amount equality under AMOUNT_EPSILON. Two nulls count as equal; one null does not. */
function amountsEqual(a: number | null, b: number | null): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(a - b) < AMOUNT_EPSILON;
}

/** Rate equality under RATE_EPSILON. A missing rate on either side is treated as "no observable rate change" — see rule 4/5/6 notes. */
function ratesEqual(a: number | null, b: number | null): boolean {
  if (a == null || b == null) return true;
  return Math.abs(a - b) < RATE_EPSILON;
}

function monthDiff(fromISODate: string, toISODate: string): number {
  const [fy, fm] = fromISODate.slice(0, 7).split('-').map(Number);
  const [ty, tm] = toISODate.slice(0, 7).split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

/**
 * revenue_comparison stores per-stage revenue DATES (day precision);
 * revenue_change_log wants revenue PERIODS (month). fact_revenue_snapshot
 * derives revenue_period as DATE_TRUNC('month', revenue_date), so the same
 * truncation is applied here rather than joining back for it.
 */
function toRevenuePeriod(revDate: string | null): string | null {
  return revDate ? `${revDate.slice(0, 7)}-01` : null;
}

function toFixedOrNull(n: number | null, dp = 2): string | null {
  return n == null ? null : n.toFixed(dp);
}

/** NetSuite internal ids are varchar; source_record_id is BIGINT. Non-numeric ids resolve to null rather than failing the insert. */
function toBigintOrNull(v: string | null | undefined): number | null {
  if (v == null || !/^\d+$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

// ══════════════════════════════════════════════════════════════════════════
//  Money / rate formatting for change_description
// ══════════════════════════════════════════════════════════════════════════

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$', EUR: '€', GBP: '£', JPY: '¥', INR: '₹',
};

/** "$400,000" / "€100,000" / "AUD 1,234.56" — whole amounts drop the cents, so descriptions read the way a person would write them. */
function money(amount: number | null, currency: string | null): string {
  if (amount == null) return 'an unknown amount';
  const decimals = Number.isInteger(amount) ? 0 : 2;
  const formatted = Math.abs(amount).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  const sign = amount < 0 ? '-' : '';
  const code = currency ?? 'USD';
  const symbol = CURRENCY_SYMBOLS[code];
  return symbol ? `${sign}${symbol}${formatted}` : `${sign}${code} ${formatted}`;
}

/** Same as money() but always carries an explicit +/- — for delta phrases like "(+$20,000)". */
function signedMoney(amount: number | null, currency: string | null): string {
  if (amount == null) return 'an unknown amount';
  return `${amount >= 0 ? '+' : '-'}${money(Math.abs(amount), currency)}`;
}

/** Trims trailing zeros so a numeric(18,8) rate reads as "1.08", not "1.08000000". */
function rate(r: number | null): string {
  if (r == null) return 'an unknown rate';
  return String(Number(r.toFixed(8)));
}

function monthPhrase(months: number): string {
  const magnitude = Math.abs(months);
  const unit = magnitude === 1 ? 'month' : 'months';
  return `${months >= 0 ? '+' : '-'}${magnitude} ${unit}`;
}

/** "2026-07-01" → "2026-07", the way a revenue period is spoken about. */
function periodLabel(period: string | null): string {
  return period ? period.slice(0, 7) : 'no assigned period';
}

/** The best human label for the record behind an anchor — the document number if we resolved one, else the anchor itself. */
function subject(row: EnrichedComparisonRow): string {
  return row.documentNumber ?? row.anchorId;
}

// ══════════════════════════════════════════════════════════════════════════
//  Stage selection + enrichment
// ══════════════════════════════════════════════════════════════════════════

export const STAGE_SOURCE_TYPES = ['PIPELINE', 'SO', 'INVOICE'] as const;
export type StageSourceType = typeof STAGE_SOURCE_TYPES[number];

interface StageAmounts {
  sourceType: StageSourceType;
  priorForeign: number | null;
  currentForeign: number | null;
  priorPeriod: string | null;
  currentPeriod: string | null;
}

function stageAmounts(row: ComparisonRow, stage: StageSourceType): StageAmounts {
  switch (stage) {
    case 'INVOICE':
      return {
        sourceType: 'INVOICE',
        priorForeign: num(row.priorInvoiceAmt),
        currentForeign: num(row.currentInvoiceAmt),
        priorPeriod: toRevenuePeriod(row.priorInvoiceDate),
        currentPeriod: toRevenuePeriod(row.currentInvoiceDate),
      };
    case 'SO':
      return {
        sourceType: 'SO',
        priorForeign: num(row.priorOpenSoAmt),
        currentForeign: num(row.currentOpenSoAmt),
        priorPeriod: toRevenuePeriod(row.priorSoRevDate),
        currentPeriod: toRevenuePeriod(row.currentSoRevDate),
      };
    case 'PIPELINE':
      return {
        sourceType: 'PIPELINE',
        priorForeign: num(row.priorPipelineAmt),
        currentForeign: num(row.currentPipelineAmt),
        priorPeriod: toRevenuePeriod(row.priorPipelineRevDate),
        currentPeriod: toRevenuePeriod(row.currentPipelineRevDate),
      };
  }
}

/**
 * Collapses the wide comparison row onto the single prior/current pair the
 * rules are written against, by picking the most advanced stage the anchor
 * has any value in on either side: Invoice, then Open SO, then Pipeline.
 *
 * Rationale: that stage is where the anchor's revenue actually sits now, and
 * it matches the precedence pickReportingAttrs() already uses in
 * comparisonBuilder.ts. Using the reconciled total_* columns instead would
 * hide every pipeline-only movement (those columns deliberately exclude
 * Pipeline), and summing all three stages would double-count a deal mid
 * pipeline→SO→invoice transition.
 *
 * Cross-stage transitions are NOT lost by this choice: they are exactly what
 * revenue_comparison already flagged as a lifecycle_event, which rule 1
 * handles before any of these amounts are consulted.
 *
 * FLAGGED AS AN ASSUMPTION — confirm the intended single-figure definition.
 */
function pickStage(row: ComparisonRow): StageAmounts {
  for (const stage of ['INVOICE', 'SO', 'PIPELINE'] as const) {
    const amounts = stageAmounts(row, stage);
    const prior = amounts.priorForeign ?? 0;
    const current = amounts.currentForeign ?? 0;
    if (Math.abs(prior) >= AMOUNT_EPSILON || Math.abs(current) >= AMOUNT_EPSILON) return amounts;
  }
  // Every stage is zero on both sides — nothing can have changed amount-wise.
  // Pipeline is the defensible default: it is where an anchor starts life.
  return stageAmounts(row, 'PIPELINE');
}

/** The fact_revenue_snapshot facts revenue_comparison does not carry, for one (anchor, stage, snapshot date). */
export interface SnapshotFacts {
  currency: string | null;
  exchangeRate: number | null;
  usdAmount: number | null;
  documentNumber: string | null;
  internalId: string | null;
}

/** The Original Baseline for an anchor — the earliest qualifying snapshot row. */
export interface OriginalBaseline {
  anchorId: string;
  sourceType: string | null;
  snapshotDate: string | null;
  foreignAmount: number | null;
  usdAmount: number | null;
  exchangeRate: number | null;
  revenuePeriod: string | null;
  currency: string | null;
}

/**
 * A comparison row with the generic prior/current pair resolved, ready for
 * evaluateChangeRules(). Everything here is plain data — no database handle —
 * so rule evaluation is directly unit testable.
 */
export interface EnrichedComparisonRow {
  anchorId: string;
  reportType: string;
  fromSnapshotDate: string;
  toSnapshotDate: string;
  lifecycleEvent: string | null;

  sourceType: StageSourceType;
  sourceRecordId: number | null;
  documentNumber: string | null;

  priorForeignAmount: number | null;
  currentForeignAmount: number | null;
  priorRevenuePeriod: string | null;
  currentRevenuePeriod: string | null;

  priorCurrency: string | null;
  currentCurrency: string | null;
  priorExchangeRate: number | null;
  currentExchangeRate: number | null;
  priorReportedUsdAmount: number | null;
  currentReportedUsdAmount: number | null;

  /** Kept for the lifecycle descriptions, which talk about stages the picked stage isn't. */
  stages: {
    priorPipeline: number | null; currentPipeline: number | null;
    priorOpenSo: number | null; currentOpenSo: number | null;
    priorInvoice: number | null; currentInvoice: number | null;
  };
}

/** Joins a comparison row to the snapshot facts + baseline already fetched for the batch. */
export function enrichComparisonRow(
  row: ComparisonRow,
  priorFacts: SnapshotFacts | undefined,
  currentFacts: SnapshotFacts | undefined,
): EnrichedComparisonRow {
  const stage = pickStage(row);
  const facts = currentFacts ?? priorFacts;

  return {
    anchorId: row.anchorId,
    reportType: row.reportType,
    fromSnapshotDate: row.priorSnapshotPeriod,
    toSnapshotDate: row.currentSnapshotPeriod,
    lifecycleEvent: row.lifecycleEvent,

    sourceType: stage.sourceType,
    sourceRecordId: toBigintOrNull(facts?.internalId ?? null),
    documentNumber: facts?.documentNumber ?? null,

    priorForeignAmount: stage.priorForeign,
    currentForeignAmount: stage.currentForeign,
    priorRevenuePeriod: stage.priorPeriod,
    currentRevenuePeriod: stage.currentPeriod,

    // Currency falls back to revenue_comparison.currency when a side has no
    // snapshot row for the picked stage — without that, a stage that only
    // exists on one date would read as a currency change.
    priorCurrency: priorFacts?.currency ?? row.currency ?? null,
    currentCurrency: currentFacts?.currency ?? row.currency ?? null,
    priorExchangeRate: priorFacts?.exchangeRate ?? null,
    currentExchangeRate: currentFacts?.exchangeRate ?? null,
    priorReportedUsdAmount: priorFacts?.usdAmount ?? null,
    currentReportedUsdAmount: currentFacts?.usdAmount ?? null,

    stages: {
      priorPipeline: num(row.priorPipelineAmt), currentPipeline: num(row.currentPipelineAmt),
      priorOpenSo: num(row.priorOpenSoAmt), currentOpenSo: num(row.currentOpenSoAmt),
      priorInvoice: num(row.priorInvoiceAmt), currentInvoice: num(row.currentInvoiceAmt),
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════
//  Derived context columns — computed for EVERY row, whatever matched
// ══════════════════════════════════════════════════════════════════════════

interface DerivedContext {
  foreignDeltaVsPrior: number | null;
  foreignDeltaVsOriginal: number | null;
  reportedUsdDeltaVsPrior: number | null;
  monthsShiftedVsPrior: number | null;
  monthsShiftedVsOriginal: number | null;
}

/**
 * Straight arithmetic on what is already resolved. Computed for every emitted
 * row regardless of which rule matched — a lifecycle row is far more useful
 * with its deltas filled in than with nulls.
 */
function deriveContext(row: EnrichedComparisonRow, baseline: OriginalBaseline | null): DerivedContext {
  const prior = row.priorForeignAmount;
  const current = row.currentForeignAmount;
  const original = baseline?.foreignAmount ?? null;
  const priorUsd = row.priorReportedUsdAmount;
  const currentUsd = row.currentReportedUsdAmount;

  return {
    foreignDeltaVsPrior: prior != null && current != null ? current - prior : null,
    foreignDeltaVsOriginal: original != null && current != null ? current - original : null,
    reportedUsdDeltaVsPrior: priorUsd != null && currentUsd != null ? currentUsd - priorUsd : null,
    monthsShiftedVsPrior: row.priorRevenuePeriod && row.currentRevenuePeriod
      ? monthDiff(row.priorRevenuePeriod, row.currentRevenuePeriod) : null,
    monthsShiftedVsOriginal: baseline?.revenuePeriod && row.currentRevenuePeriod
      ? monthDiff(baseline.revenuePeriod, row.currentRevenuePeriod) : null,
  };
}

// ══════════════════════════════════════════════════════════════════════════
//  change_description — one template per change_type, real numbers only
// ══════════════════════════════════════════════════════════════════════════

function describe(
  changeType: string,
  row: EnrichedComparisonRow,
  baseline: OriginalBaseline | null,
  ctx: DerivedContext,
): string {
  const ccy = row.currentCurrency ?? row.priorCurrency;
  const prior = row.priorForeignAmount;
  const current = row.currentForeignAmount;
  const who = subject(row);

  switch (changeType) {
    // ── Lifecycle ────────────────────────────────────────────────────────
    case 'Pipeline converted to Sales Order': {
      const pipelineValue = row.stages.priorPipeline;
      const orderValue = row.stages.currentOpenSo;
      return `${who} converted from pipeline to sales order — ${money(pipelineValue, ccy)} of pipeline became ${money(orderValue, ccy)} of open sales-order value as of ${row.toSnapshotDate}.`;
    }
    case 'SO partially invoiced': {
      const invoiced = row.stages.currentInvoice ?? 0;
      const stillOpen = row.stages.currentOpenSo ?? 0;
      return `${who} partially invoiced — ${money(invoiced, ccy)} of ${money(invoiced + stillOpen, ccy)} invoiced, ${money(stillOpen, ccy)} remains open.`;
    }
    case 'SO fully invoiced': {
      const invoiced = row.stages.currentInvoice;
      return `${who} fully invoiced — ${money(invoiced, ccy)} invoiced in full, no open sales-order value remains as of ${row.toSnapshotDate}.`;
    }
    case 'New pipeline record added':
      return `${who} was added to the pipeline as of ${row.toSnapshotDate} — ${money(row.stages.currentPipeline, ccy)} of new pipeline value, revenue period ${periodLabel(row.currentRevenuePeriod)}.`;
    case DELETED:
      return `Anchor ${row.anchorId} no longer appears in the current snapshot as of ${row.toSnapshotDate} — record deleted. Last known value was ${money(prior, row.priorCurrency)}.`;

    // ── Data quality ─────────────────────────────────────────────────────
    case CHANGE_TYPES.CURRENCY_CHANGE:
      return `${who} changed currency from ${row.priorCurrency} to ${row.currentCurrency} between ${row.fromSnapshotDate} and ${row.toSnapshotDate} — prior ${money(prior, row.priorCurrency)} and current ${money(current, row.currentCurrency)} are not comparable until this is resolved.`;

    // ── Amount rules ─────────────────────────────────────────────────────
    case CHANGE_TYPES.REVERTED_TO_ORIGINAL:
      return `${who} reverted to its original baseline of ${money(baseline?.foreignAmount ?? null, ccy)} — the prior snapshot showed ${money(prior, ccy)}, a move of ${signedMoney(ctx.foreignDeltaVsPrior, ccy)} back to the baseline set on ${baseline?.snapshotDate ?? 'an earlier snapshot'}.`;

    case CHANGE_TYPES.FX_ONLY:
      return `FX-only movement — foreign amount unchanged at ${money(current, ccy)}, but USD value shifted from ${money(row.priorReportedUsdAmount, 'USD')} to ${money(row.currentReportedUsdAmount, 'USD')} due to exchange rate change (${rate(row.priorExchangeRate)} → ${rate(row.currentExchangeRate)}).`;

    case CHANGE_TYPES.BUSINESS_AND_FX:
      return `${who} changed from ${money(prior, ccy)} to ${money(current, ccy)} (${signedMoney(ctx.foreignDeltaVsPrior, ccy)}) and the exchange rate moved (${rate(row.priorExchangeRate)} → ${rate(row.currentExchangeRate)}) — reported USD went from ${money(row.priorReportedUsdAmount, 'USD')} to ${money(row.currentReportedUsdAmount, 'USD')} (${signedMoney(ctx.reportedUsdDeltaVsPrior, 'USD')}).`;

    case CHANGE_TYPES.REVENUE_INCREASE:
      return `Revenue increased from ${money(prior, ccy)} to ${money(current, ccy)} (${signedMoney(ctx.foreignDeltaVsPrior, ccy)}), no FX impact.`;

    case CHANGE_TYPES.REVENUE_DECREASE:
      return `Revenue decreased from ${money(prior, ccy)} to ${money(current, ccy)} (${signedMoney(ctx.foreignDeltaVsPrior, ccy)}), no FX impact.`;

    // ── Period ───────────────────────────────────────────────────────────
    case CHANGE_TYPES.REVENUE_SHIFT: {
      const shift = ctx.monthsShiftedVsPrior;
      const shiftPhrase = shift == null ? '' : ` (${monthPhrase(shift)})`;
      return `Revenue period moved from ${periodLabel(row.priorRevenuePeriod)} to ${periodLabel(row.currentRevenuePeriod)}${shiftPhrase} — ${money(current, ccy)} of ${row.sourceType} revenue reallocated to a different period.`;
    }
  }

  // Unreachable while every change_type this file emits has a case above.
  return `${who} recorded a ${changeType} between ${row.fromSnapshotDate} and ${row.toSnapshotDate}.`;
}

// ══════════════════════════════════════════════════════════════════════════
//  Rule engine
// ══════════════════════════════════════════════════════════════════════════

/** What a matched rule decides; everything else on the row is derived identically for all of them. */
interface RuleMatch {
  changeType: string;
  changeDriver: 'BUSINESS' | 'FX_ONLY' | 'BUSINESS_AND_FX' | 'PERIOD' | 'LIFECYCLE' | 'DATA_QUALITY';
  controlSeverity: ControlSeverity;
  fxOnlyChangeFlag?: boolean;
}

function toChangeLogRow(
  match: RuleMatch,
  row: EnrichedComparisonRow,
  baseline: OriginalBaseline | null,
  ctx: DerivedContext,
  changeGroupId: string,
): ChangeLogRow {
  const isCurrencyChange = match.changeType === CHANGE_TYPES.CURRENCY_CHANGE;

  return {
    changeGroupId,
    changeType: match.changeType,
    changeDriver: match.changeDriver,

    sourceType: row.sourceType,
    sourceRecordId: row.sourceRecordId,
    documentNumber: row.documentNumber,
    anchorId: row.anchorId,

    fromSnapshotDate: row.fromSnapshotDate,
    toSnapshotDate: row.toSnapshotDate,
    reportType: row.reportType,

    originalForeignAmount: toFixedOrNull(baseline?.foreignAmount ?? null),
    priorForeignAmount: toFixedOrNull(row.priorForeignAmount),
    currentForeignAmount: toFixedOrNull(row.currentForeignAmount),
    // Deltas across two different currencies would be arithmetic on
    // incomparable units — left null on a currency change on purpose.
    foreignDeltaVsPrior: isCurrencyChange ? null : toFixedOrNull(ctx.foreignDeltaVsPrior),
    foreignDeltaVsOriginal: isCurrencyChange ? null : toFixedOrNull(ctx.foreignDeltaVsOriginal),

    originalReportedUsdAmount: toFixedOrNull(baseline?.usdAmount ?? null),
    priorReportedUsdAmount: toFixedOrNull(row.priorReportedUsdAmount),
    currentReportedUsdAmount: toFixedOrNull(row.currentReportedUsdAmount),
    // USD is a common unit, so this one stays valid even across a currency change.
    reportedUsdDeltaVsPrior: toFixedOrNull(ctx.reportedUsdDeltaVsPrior),

    originalExchangeRate: toFixedOrNull(baseline?.exchangeRate ?? null, 8),
    priorExchangeRate: toFixedOrNull(row.priorExchangeRate, 8),
    currentExchangeRate: toFixedOrNull(row.currentExchangeRate, 8),
    fxOnlyChangeFlag: match.fxOnlyChangeFlag ?? false,

    originalRevenuePeriod: baseline?.revenuePeriod ?? null,
    priorRevenuePeriod: row.priorRevenuePeriod,
    currentRevenuePeriod: row.currentRevenuePeriod,
    monthsShiftedVsPrior: ctx.monthsShiftedVsPrior,
    monthsShiftedVsOriginal: ctx.monthsShiftedVsOriginal,

    changeDescription: describe(match.changeType, row, baseline, ctx),
    controlSeverity: match.controlSeverity,
  };
}

/**
 * The priority-ordered rule engine. First match wins; rules 4/5/6 explicitly
 * fall through to rule 7 so an FX or business change that ALSO moved period
 * produces two rows.
 *
 * Returns 0, 1 or 2 rows:
 *   0 — nothing meaningful changed (rule 8). Nothing is inserted.
 *   1 — the normal case.
 *   2 — an amount/FX change that co-occurred with a period shift (rule 7).
 *
 * Pure and synchronous: everything it needs is already on the two arguments.
 * changeGroupId defaults to a fresh UUID so the function can be called
 * standalone in a test; runChangeLogForBatch passes one id for the batch.
 */
export function evaluateChangeRules(
  comparisonRow: EnrichedComparisonRow,
  originalBaseline: OriginalBaseline | null,
  changeGroupId: string = crypto.randomUUID(),
): ChangeLogRow[] {
  const row = comparisonRow;
  const baseline = originalBaseline;
  const ctx = deriveContext(row, baseline);
  const emit = (match: RuleMatch) => toChangeLogRow(match, row, baseline, ctx, changeGroupId);

  // ── Rule 1: LIFECYCLE ──────────────────────────────────────────────────
  // Stage transitions outrank generic amount rules: a pipeline row vanishing
  // because it became an SO is not a revenue decrease.
  const lifecycleChangeType = row.lifecycleEvent ? LIFECYCLE_EVENT_MAP[row.lifecycleEvent] : undefined;
  if (lifecycleChangeType) {
    return [emit({
      changeType: lifecycleChangeType,
      changeDriver: 'LIFECYCLE',
      controlSeverity: (lifecycleChangeType === DELETED
        ? SEVERITY_THRESHOLDS.deleted_severity
        : SEVERITY_THRESHOLDS.lifecycle_severity) as ControlSeverity,
    })];
    // STOP — no further rules.
  }

  // ── Rule 2: CURRENCY_CHANGED ───────────────────────────────────────────
  // Runs before every amount rule, every time, no exceptions: once the
  // currency moved, the foreign-amount comparison underneath rules 3-6 is
  // arithmetic on two different units and would report a fictional delta.
  // Both sides must be known — a null currency is missing data, not a change.
  if (row.priorCurrency && row.currentCurrency && row.priorCurrency !== row.currentCurrency) {
    return [emit({
      changeType: CHANGE_TYPES.CURRENCY_CHANGE,
      changeDriver: 'DATA_QUALITY',
      controlSeverity: SEVERITY_THRESHOLDS.currency_change_severity as ControlSeverity,
    })];
    // STOP — no further rules.
  }

  const prior = row.priorForeignAmount;
  const current = row.currentForeignAmount;
  const original = baseline?.foreignAmount ?? null;
  const amountUnchanged = amountsEqual(prior, current);
  const rateUnchanged = ratesEqual(row.priorExchangeRate, row.currentExchangeRate);
  const periodShifted = row.priorRevenuePeriod !== row.currentRevenuePeriod;

  // ── Rule 3: REVERTED_TO_ORIGINAL ───────────────────────────────────────
  // Needs a baseline to compare against; without one this rule cannot fire
  // and evaluation continues to rule 4.
  if (original != null && amountsEqual(current, original) && !amountsEqual(prior, original)) {
    return [emit({
      changeType: CHANGE_TYPES.REVERTED_TO_ORIGINAL,
      changeDriver: 'BUSINESS',
      controlSeverity: SEVERITY_THRESHOLDS.reverted_to_original_severity as ControlSeverity,
    })];
    // STOP — no further rules.
  }

  const rows: ChangeLogRow[] = [];

  // ── Rules 4-6: FX / business / both ────────────────────────────────────
  // These CONTINUE into rule 7 rather than stopping, so a period shift that
  // happened in the same run gets its own row instead of being swallowed.
  if (amountUnchanged && !rateUnchanged) {
    // Rule 4: FX_ONLY.
    rows.push(emit({
      changeType: CHANGE_TYPES.FX_ONLY,
      changeDriver: 'FX_ONLY',
      controlSeverity: severityForAmount(ctx.reportedUsdDeltaVsPrior),
      fxOnlyChangeFlag: true,
    }));
  } else if (!amountUnchanged && !rateUnchanged) {
    // Rule 5: BUSINESS_AND_FX.
    rows.push(emit({
      changeType: CHANGE_TYPES.BUSINESS_AND_FX,
      changeDriver: 'BUSINESS_AND_FX',
      controlSeverity: severityForAmount(ctx.foreignDeltaVsPrior),
    }));
  } else if (!amountUnchanged && rateUnchanged) {
    // Rule 6: BUSINESS_CHANGE. Direction comes from the actual numbers; a
    // null prior (stage absent on the prior date) counts as an increase from
    // nothing rather than an unknown.
    const increased = (current ?? 0) > (prior ?? 0);
    rows.push(emit({
      changeType: increased ? CHANGE_TYPES.REVENUE_INCREASE : CHANGE_TYPES.REVENUE_DECREASE,
      changeDriver: 'BUSINESS',
      controlSeverity: severityForAmount(ctx.foreignDeltaVsPrior),
    }));
  }

  // ── Rule 7: PERIOD_SHIFT ───────────────────────────────────────────────
  // Appends a second row when an amount/FX rule already matched; becomes the
  // sole event when nothing else did.
  if (periodShifted) {
    rows.push(emit({
      changeType: CHANGE_TYPES.REVENUE_SHIFT,
      changeDriver: 'PERIOD',
      controlSeverity: SEVERITY_THRESHOLDS.period_shift_severity as ControlSeverity,
    }));
  }

  // ── Rule 8: NO_CHANGE ──────────────────────────────────────────────────
  // Empty array — the array-shaped form of "no event". The caller inserts
  // nothing, so a "no change" row can never reach the table.
  return rows;
}

// ══════════════════════════════════════════════════════════════════════════
//  Original Baseline lookup
// ══════════════════════════════════════════════════════════════════════════

interface BaselineQueryRow {
  anchor_id: string;
  source_type: string | null;
  snapshot_date: string | null;
  foreign_amount: string | null;
  usd_amount: string | null;
  exchange_rate: string | null;
  revenue_period: string | null;
  currency: string | null;
}

function toBaseline(r: BaselineQueryRow): OriginalBaseline {
  return {
    anchorId: r.anchor_id,
    sourceType: r.source_type,
    snapshotDate: r.snapshot_date,
    foreignAmount: num(r.foreign_amount),
    usdAmount: num(r.usd_amount),
    exchangeRate: num(r.exchange_rate),
    revenuePeriod: r.revenue_period,
    currency: r.currency,
  };
}

/**
 * The qualifying condition for a baseline row, per the baseline definition:
 *
 *   PIPELINE   — Likely to Close > 3 AND foreign_amount > 0. A pipeline
 *                record below the threshold is stored but never establishes a
 *                baseline. likely_to_close is varchar(100) in this schema, so
 *                the regex guard runs before the ::numeric cast — a
 *                non-numeric value ('High', '') simply fails to qualify
 *                instead of aborting the query with a cast error.
 *
 *                The decimal point is written as the bracket expression [.]
 *                rather than \. on purpose: this regex lives inside a JS
 *                template literal, which swallows the backslash before
 *                Postgres ever sees it, leaving `.` — a match-anything
 *                wildcard that would let '1x5' through the guard and then
 *                abort the whole query on the ::numeric cast. [.] survives
 *                both layers intact.
 *   SO/INVOICE — the first VALID row, read here as foreign_amount > 0 (a zero
 *                or null amount cannot serve as a baseline). FLAGGED AS AN
 *                ASSUMPTION.
 *
 * fact_revenue_snapshot is append-only and never edited, so "earliest
 * qualifying row" resolves to the same answer whenever it is asked — which is
 * what keeps a baseline from being silently overwritten later.
 */
const BASELINE_QUALIFIES = sql`
  source_type IN ('PIPELINE', 'SO', 'INVOICE')
  AND foreign_amount IS NOT NULL
  AND foreign_amount > 0
  AND (
    source_type <> 'PIPELINE'
    OR (likely_to_close ~ '^[0-9]+([.][0-9]+)?$' AND likely_to_close::numeric > 3)
  )
`;

const BASELINE_COLUMNS = sql`
  anchor_id, source_type, snapshot_date, foreign_amount, usd_amount,
  exchange_rate, revenue_period, currency
`;

/**
 * The Original Baseline for one anchor — the earliest qualifying
 * fact_revenue_snapshot row for it, or null if it has never had one.
 *
 * Reusable and safe to call on its own. runChangeLogForBatch does NOT use it
 * per row (that would be one query per anchor); it calls
 * getOriginalBaselines() to resolve a whole batch in one query instead.
 */
export async function getOriginalBaseline(db: DB, anchorId: string): Promise<OriginalBaseline | null> {
  const rows = await db.execute(sql`
    SELECT ${BASELINE_COLUMNS}
    FROM fact_revenue_snapshot
    WHERE anchor_id = ${anchorId}
      AND ${BASELINE_QUALIFIES}
    ORDER BY snapshot_date ASC, id ASC
    LIMIT 1
  `) as unknown as BaselineQueryRow[];

  const row = [...rows][0];
  return row ? toBaseline(row) : null;
}

/** Batched form of getOriginalBaseline — one DISTINCT ON query for every anchor in a batch. */
export async function getOriginalBaselines(db: DB, anchorIds: string[]): Promise<Map<string, OriginalBaseline>> {
  if (anchorIds.length === 0) return new Map();

  // Membership goes through drizzle's inArray() rather than an interpolated
  // `= ANY(${array})`: postgres.js needs an explicit array-typed bind, and a
  // plain JS array inside a sql template serializes as one string parameter
  // (throws 22P02 "malformed array literal"). Same reason as the note in
  // originalBaseline.repository.ts.
  const rows = await db.execute(sql`
    SELECT DISTINCT ON (anchor_id) ${BASELINE_COLUMNS}
    FROM fact_revenue_snapshot
    WHERE ${inArray(factRevenueSnapshot.anchorId, anchorIds)}
      AND ${BASELINE_QUALIFIES}
    ORDER BY anchor_id, snapshot_date ASC, id ASC
  `) as unknown as BaselineQueryRow[];

  return new Map([...rows].map(r => [r.anchor_id, toBaseline(r)]));
}

// ══════════════════════════════════════════════════════════════════════════
//  Snapshot fact resolution
// ══════════════════════════════════════════════════════════════════════════

/**
 * Reads the currency / exchange rate / reported USD / document number that
 * revenue_comparison does not carry, for every anchor on one snapshot date,
 * keyed by `${anchorId}:${sourceType}`.
 *
 * Aggregation deliberately mirrors comparisonBuilder.aggregateStage(), so the
 * numbers line up with the comparison row they annotate: usd_amount is SUMMED
 * across every record sharing an (anchor, stage) — one estimate can carry
 * hundreds of invoice rows — while currency, rate and document number come
 * from the single largest-amount ("dominant") row in that group, since there
 * is no single correct rate when sub-orders genuinely differ.
 */
export async function fetchSnapshotFacts(db: DB, snapshotDate: string): Promise<Map<string, SnapshotFacts>> {
  const rows = await db.select({
    anchorId: factRevenueSnapshot.anchorId,
    sourceType: factRevenueSnapshot.sourceType,
    foreignAmount: factRevenueSnapshot.foreignAmount,
    usdAmount: factRevenueSnapshot.usdAmount,
    exchangeRate: factRevenueSnapshot.exchangeRate,
    currency: factRevenueSnapshot.currency,
    documentNumber: factRevenueSnapshot.documentNumber,
    internalId: factRevenueSnapshot.internalId,
  }).from(factRevenueSnapshot).where(and(
    eq(factRevenueSnapshot.snapshotDate, snapshotDate),
    inArray(factRevenueSnapshot.sourceType, STAGE_SOURCE_TYPES),
  ));

  const facts = new Map<string, SnapshotFacts>();
  const dominantAmount = new Map<string, number>();
  const usdTotal = new Map<string, number>();

  for (const r of rows) {
    if (!r.anchorId) continue;
    const key = `${r.anchorId}:${r.sourceType}`;
    const amount = num(r.foreignAmount) ?? 0;

    usdTotal.set(key, (usdTotal.get(key) ?? 0) + (num(r.usdAmount) ?? 0));

    if (amount > (dominantAmount.get(key) ?? -Infinity)) {
      dominantAmount.set(key, amount);
      facts.set(key, {
        currency: r.currency,
        exchangeRate: num(r.exchangeRate),
        usdAmount: null, // filled from usdTotal below, once every row is summed
        documentNumber: r.documentNumber,
        internalId: r.internalId,
      });
    }
  }

  for (const [key, f] of facts) f.usdAmount = usdTotal.get(key) ?? null;
  return facts;
}

// ══════════════════════════════════════════════════════════════════════════
//  Batch runner
// ══════════════════════════════════════════════════════════════════════════

export interface ChangeLogBatchResult {
  reportType: string;
  currentSnapshotPeriod: string;
  changeGroupId: string;
  evaluated: number;
  written: number;
  /** Rows produced by the rules but already present from an earlier run — skipped by ON CONFLICT DO NOTHING. */
  skippedAsDuplicate: number;
  failed: number;
  byChangeType: Record<string, number>;
}

/**
 * Builds the change log for one (reportType, currentSnapshotPeriod) batch.
 *
 * Re-run safe: inserts with ON CONFLICT DO NOTHING on
 * (report_type, anchor_id, to_snapshot_date, change_type), so running the same
 * batch twice writes nothing the second time.
 *
 * Never lets one bad anchor take the batch down — rule evaluation is wrapped
 * per row, and a throw is logged with its anchor_id and counted in `failed`
 * while every other row carries on.
 *
 * `db` is threaded in as the first argument to match the convention the rest
 * of these jobs use (runComparison(db, ...), buildChangeLog(db, ...)) rather
 * than reaching for a module-level singleton.
 */
export async function runChangeLogForBatch(
  db: DB,
  reportType: string,
  currentSnapshotPeriod: string,
): Promise<ChangeLogBatchResult> {
  // One change_group_id for the whole batch — every event this run produces
  // is traceable back to it.
  const changeGroupId = crypto.randomUUID();

  const comparisonRows = await db.select(COMPARISON_COLUMNS).from(revenueComparison).where(and(
    eq(revenueComparison.reportType, reportType),
    eq(revenueComparison.currentSnapshotPeriod, currentSnapshotPeriod),
  ));

  const result: ChangeLogBatchResult = {
    reportType, currentSnapshotPeriod, changeGroupId,
    evaluated: comparisonRows.length, written: 0, skippedAsDuplicate: 0, failed: 0,
    byChangeType: {},
  };

  if (comparisonRows.length === 0) {
    console.log(`[revenue-change-log] ${reportType} ${currentSnapshotPeriod} — no comparison rows to evaluate`);
    return result;
  }

  // All rows in a batch normally share one prior date, but the query is not
  // constrained to that, so every distinct prior date present is resolved.
  const priorDates = [...new Set(comparisonRows.map(r => r.priorSnapshotPeriod))];
  const anchorIds = [...new Set(comparisonRows.map(r => r.anchorId))];

  const [currentFacts, priorFactsByDate, baselines] = await Promise.all([
    fetchSnapshotFacts(db, currentSnapshotPeriod),
    Promise.all(priorDates.map(async d => [d, await fetchSnapshotFacts(db, d)] as const))
      .then(entries => new Map(entries)),
    getOriginalBaselines(db, anchorIds),
  ]);

  const toInsert: ChangeLogRow[] = [];
  for (const row of comparisonRows) {
    try {
      const priorFacts = priorFactsByDate.get(row.priorSnapshotPeriod);
      const stage = pickStage(row).sourceType;
      const factsKey = `${row.anchorId}:${stage}`;

      const enriched = enrichComparisonRow(row, priorFacts?.get(factsKey), currentFacts.get(factsKey));
      const produced = evaluateChangeRules(enriched, baselines.get(row.anchorId) ?? null, changeGroupId);

      for (const r of produced) {
        toInsert.push(r);
        result.byChangeType[r.changeType] = (result.byChangeType[r.changeType] ?? 0) + 1;
      }
    } catch (err) {
      // One anchor's rules throwing must not cost the rest of the batch.
      result.failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[revenue-change-log] ${reportType} ${currentSnapshotPeriod} — anchor ${row.anchorId} FAILED rule evaluation: ${message}`);
    }
  }

  for (let i = 0; i < toInsert.length; i += CHANGELOG_INSERT_CHUNK_SIZE) {
    const chunk = toInsert.slice(i, i + CHANGELOG_INSERT_CHUNK_SIZE);
    if (chunk.length === 0) continue;
    const inserted = await db.insert(revenueChangeLog).values(chunk)
      .onConflictDoNothing({
        target: [
          revenueChangeLog.reportType,
          revenueChangeLog.anchorId,
          revenueChangeLog.toSnapshotDate,
          revenueChangeLog.changeType,
        ],
      })
      .returning({ id: revenueChangeLog.changeEventId });
    result.written += inserted.length;
  }
  result.skippedAsDuplicate = toInsert.length - result.written;

  const breakdown = Object.entries(result.byChangeType)
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `${type}=${count}`)
    .join(', ') || 'none';
  console.log(
    `[revenue-change-log] ${reportType} ${currentSnapshotPeriod} — ` +
    `${result.evaluated} comparison row(s) evaluated, ${result.written} change-log row(s) written` +
    `${result.skippedAsDuplicate > 0 ? `, ${result.skippedAsDuplicate} already present (re-run)` : ''}` +
    `${result.failed > 0 ? `, ${result.failed} row(s) failed` : ''} | by change_type: ${breakdown}`,
  );

  return result;
}
