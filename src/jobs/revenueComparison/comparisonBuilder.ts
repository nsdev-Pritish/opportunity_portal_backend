// Builds revenue_comparison rows from two fact_revenue_snapshot dates (prior
// + current) for the same report_type — the wide/cross-tab layout worked out
// in the "Cons Rev & comparison" tab of AI_FPA_DW_Change_Log_Rules_v4.xlsx
// (row 54/55, "Comparison Table" / "Partial Invoice Scenario"). Read-only
// against fact_revenue_snapshot; only ever writes to revenue_comparison. This
// module never reads NetSuite or the 4 source tables directly — that's what
// makes a comparison reproducible after the fact, since the source rows may
// have changed or been deleted since, but a snapshot date's rows never do.
//
// Called from index.ts's cadence scheduler (planComparisons/runAllComparisons),
// which decides WHICH report types are due on a given date and what their
// prior/current dates are — this file only knows how to diff two dates it's
// handed.
//
// Budget is deliberately excluded — the comparison table's own columns only
// ever cover Pipeline/Open SO/Invoice (Budget isn't a lifecycle stage of a
// deal, per the workbook).
//
// Amount fields: a stage with no row for an anchor on a given date is
// treated as amount 0, not null — this is what lets e.g. "Pipeline converted
// to SO" show up as a clean 100000 -> 0 pipeline change rather than a
// nullable gap. Dates for a missing stage stay null.
//
// Multiple rows per (anchor, stage): confirmed common in production — one
// Estimate can carry several active SOs or invoices at once (split
// shipments, partial billing; e.g. one real anchor has 480 active invoice
// rows on a single day). Every row sharing an (anchor_id, source_type) is
// SUMMED into that stage's amount — picking just one would silently discard
// the rest. The revenue date, exchange rate, and reporting attributes for a
// multi-row stage are taken from the single largest-amount row in the group
// ("dominant" row) — there's no single correct date/rate when several
// sub-orders genuinely differ, so the biggest one is the most defensible
// representative.
//
// USD delta columns (usd_so_amount_change, usd_invoice_amount_change,
// usd_total_amount_change): the sheet's own cell text for these is literally
// "Foreign amount x Exchange rate" — i.e. the already-computed foreign-
// currency delta, converted using the CURRENT snapshot's exchange rate for
// that stage (falling back to the prior rate if the stage doesn't exist in
// the current snapshot, e.g. an SO that was fully invoiced away this
// period). This wasn't fully unambiguous in the sheet — flag to the FX-logic
// owner if a different rate convention is intended.
//
// Re-run safety: upserts on the (anchor, report_type, prior date, current
// date) unique index rather than ON CONFLICT DO NOTHING — a re-run refreshes
// every column to the latest computed value instead of freezing whatever the
// first attempt happened to write, which matters if fact_revenue_snapshot
// itself was corrected after a first (bad) run.

import { and, eq, inArray, sql } from 'drizzle-orm';
import { factRevenueSnapshot, revenueComparison } from '../../db/schema/index.js';
import type { DB } from '../../config/database.js';
import { COMPARISON_INSERT_CHUNK_SIZE, type ReportType } from './config.js';

type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];
type SnapshotRow = typeof factRevenueSnapshot.$inferSelect;
type ComparisonRow = typeof revenueComparison.$inferInsert;

const STAGE_SOURCE_TYPES = ['PIPELINE', 'SO', 'INVOICE'] as const;
type StageSourceType = typeof STAGE_SOURCE_TYPES[number];

interface StageAttrs {
  consolidatedCustomer: string | null;
  topLevelParent: string | null;
  projectName: string | null;
  salesRep: string | null;
  department: string | null;
  subsidiary: string | null;
  currency: string | null;
}

interface StageAggregate {
  amount: number;
  revenueDate: string | null;
  exchangeRate: number | null;
  attrs: StageAttrs | null;
}

const EMPTY_STAGE: StageAggregate = { amount: 0, revenueDate: null, exchangeRate: null, attrs: null };

interface AnchorStages {
  PIPELINE?: SnapshotRow[];
  SO?: SnapshotRow[];
  INVOICE?: SnapshotRow[];
}

function isStageSourceType(s: string): s is StageSourceType {
  return (STAGE_SOURCE_TYPES as readonly string[]).includes(s);
}

/** Buckets every row sharing an (anchor_id, source_type) together — aggregateStage() sums them. */
function groupByAnchorAndStage(rows: SnapshotRow[]): Map<string, AnchorStages> {
  const map = new Map<string, AnchorStages>();
  for (const row of rows) {
    if (!row.anchorId || !isStageSourceType(row.sourceType)) continue;
    let stages = map.get(row.anchorId);
    if (!stages) { stages = {}; map.set(row.anchorId, stages); }
    (stages[row.sourceType] ??= []).push(row);
  }
  return map;
}

/** Sums a stage's amount across every row sharing the (anchor, stage); date/rate/attrs come from the largest single row. */
function aggregateStage(rows: SnapshotRow[] | undefined): StageAggregate {
  if (!rows || rows.length === 0) return EMPTY_STAGE;

  let amount = 0;
  let dominant: SnapshotRow = rows[0];
  let dominantAmount = -Infinity;
  for (const row of rows) {
    const n = row.foreignAmount == null ? 0 : Number(row.foreignAmount);
    const rowAmount = Number.isFinite(n) ? n : 0;
    amount += rowAmount;
    if (rowAmount > dominantAmount) { dominantAmount = rowAmount; dominant = row; }
  }

  const rateNum = dominant.exchangeRate == null ? null : Number(dominant.exchangeRate);
  return {
    amount,
    revenueDate: dominant.revenueDate ?? null,
    exchangeRate: rateNum != null && Number.isFinite(rateNum) ? rateNum : null,
    attrs: {
      consolidatedCustomer: dominant.consolidatedCustomer,
      topLevelParent: dominant.topLevelParent,
      projectName: dominant.projectName,
      salesRep: dominant.salesRep,
      department: dominant.department,
      subsidiary: dominant.subsidiary,
      currency: dominant.currency,
    },
  };
}

function monthDiff(fromISODate: string, toISODate: string): number {
  const [fy, fm] = fromISODate.slice(0, 7).split('-').map(Number);
  const [ty, tm] = toISODate.slice(0, 7).split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

function formatMonthShift(diff: number): string {
  if (diff === 0) return 'No Shift';
  return diff > 0 ? `+${diff} month${diff === 1 ? '' : 's'}` : `${diff} month${diff === -1 ? '' : 's'}`;
}

/** Pipeline/SO revenue-date-change columns (K/R on the sheet): "irrelevant" once the stage's current amount is 0, else the +/- month shift. Zero-tested via sign() — see its comment for why a strict `=== 0` misfires on a stage summed from many rows. */
function stageDateChange(currentStageAmt: number, priorDate: string | null, currentDate: string | null): string {
  if (sign(currentStageAmt) === 0) return 'Irrelevant';
  if (!priorDate || !currentDate) return 'No Shift';
  return formatMonthShift(monthDiff(priorDate, currentDate));
}

/** Invoice Revenue Period Summary (Y on the sheet): compares the invoice's OWN current date against the SO's current revenue date, not against the invoice's prior date. */
function invoiceRevenuePeriodSummary(currentInvoiceAmt: number, currentInvoiceDate: string | null, currentSoRevDate: string | null): string {
  if (sign(currentInvoiceAmt) === 0) return 'Irrelevant';
  if (!currentInvoiceDate || !currentSoRevDate) return 'No comparison SO revenue date available';
  return formatMonthShift(monthDiff(currentSoRevDate, currentInvoiceDate));
}

function buildRevenueDateChangeSummary(parts: { pipeline: string; so: string; invoice: string }): string {
  const bits: string[] = [];
  if (parts.pipeline !== 'Irrelevant' && parts.pipeline !== 'No Shift') bits.push(`Pipeline ${parts.pipeline}`);
  if (parts.so !== 'Irrelevant' && parts.so !== 'No Shift') bits.push(`SO ${parts.so}`);
  if (parts.invoice !== 'Irrelevant' && parts.invoice !== 'No comparison SO revenue date available') bits.push(`Invoice ${parts.invoice}`);
  return bits.length > 0 ? bits.join('; ') : 'No revenue date changes';
}

// Half a cent of tolerance on every zero/sign test below. Not a business
// threshold — it absorbs floating-point summation noise: aggregateStage()
// sums potentially hundreds of per-row amounts (one real anchor has 480
// invoice rows), and summing that many floats in JS can leave a delta like
// 4.5e-13 where the true business answer is exactly 0. Confirmed against
// production data: rows where prior/current invoice_amount_change both
// round to "0.00" for display were still failing a strict `=== 0` check
// here and falling through to OTHER_CHANGE. sign() centralizes the fix so
// every comparison in this function gets the same tolerance consistently.
const AMOUNT_EPSILON = 0.01;
function sign(n: number): -1 | 0 | 1 {
  if (n > AMOUNT_EPSILON) return 1;
  if (n < -AMOUNT_EPSILON) return -1;
  return 0;
}

/**
 * Translates the "Lifecycle Events" decision table (Cons Rev & comparison,
 * rows 62-78) into code. That table has some overlapping/ambiguous cells —
 * this is a deterministic, documented interpretation of its intent, ordered
 * so lifecycle-stage transitions are checked before generic single-stage
 * amount rules, per 10_Business Definitions ("Lifecycle rules take priority
 * over generic amount-decrease rules").
 */
function classifyLifecycleEvent(input: {
  priorPipelineAmt: number; currentPipelineAmt: number; pipelineChange: number;
  priorOpenSoAmt: number; currentOpenSoAmt: number; soChange: number;
  priorInvoiceAmt: number; currentInvoiceAmt: number; invoiceChange: number;
}): string {
  const priorPipeline = sign(input.priorPipelineAmt);
  const currentPipeline = sign(input.currentPipelineAmt);
  const pipelineChange = sign(input.pipelineChange);
  const priorOpenSo = sign(input.priorOpenSoAmt);
  const currentOpenSo = sign(input.currentOpenSoAmt);
  const soChange = sign(input.soChange);
  const priorInvoice = sign(input.priorInvoiceAmt);
  const currentInvoice = sign(input.currentInvoiceAmt);
  const invoiceChange = sign(input.invoiceChange);

  // Pipeline -> SO: "Prior period SO = 0 and Current Period SO > 0" (row 82 footnote).
  if (priorOpenSo === 0 && currentOpenSo > 0 && invoiceChange === 0) {
    return priorPipeline > 0 ? 'PIPELINE_CONVERTED_TO_SO' : 'ADDED_TO_SO_NO_PIPELINE';
  }

  // SO -> Invoice: "Open SO > 0 and Invoiced Current > 0" (partial) / "Open SO = 0 and Invoiced > 0" (full) — row 83/84 footnotes.
  if (priorInvoice === 0 && currentInvoice > 0) {
    if (currentOpenSo > 0 && soChange < 0) return 'SO_PARTIALLY_INVOICED';
    if (currentOpenSo === 0 && soChange < 0) return 'SO_FULLY_INVOICED';
    return 'INVOICED_NO_LINKED_SO';
  }

  if (priorOpenSo > 0 && currentOpenSo === 0 && currentInvoice === 0) return 'SO_DELETED';

  if (priorPipeline === 0 && currentPipeline > 0 && currentOpenSo === 0 && currentInvoice === 0) return 'ADDED_TO_PIPELINE';
  if (priorPipeline > 0 && currentPipeline === 0 && currentOpenSo === 0 && currentInvoice === 0) return 'PIPELINE_DELETED';

  if (currentPipeline > 0 && soChange === 0 && invoiceChange === 0) {
    if (pipelineChange > 0) return 'PIPELINE_AMOUNT_INCREASED';
    if (pipelineChange < 0) return 'PIPELINE_AMOUNT_DECREASED';
    return 'PIPELINE_OPEN_NO_CHANGE';
  }

  if (currentOpenSo > 0 && pipelineChange === 0 && invoiceChange === 0) {
    if (soChange > 0) return 'SO_AMOUNT_INCREASED';
    if (soChange < 0) return 'SO_AMOUNT_DECREASED';
    return 'SO_OPEN_NOT_INVOICED';
  }

  if (pipelineChange === 0 && soChange === 0 && invoiceChange === 0) return 'NO_CHANGE';
  return 'OTHER_CHANGE';
}

/** Reconciliation control (AD column): total_amount_change must equal invoice + open-SO change, since total deliberately excludes Pipeline. Same AMOUNT_EPSILON tolerance as sign() — see its comment. */
function computeCheckFlag(totalAmountChange: number, invoiceAmountChange: number, openSoAmountChange: number): boolean {
  return Math.abs(totalAmountChange - (invoiceAmountChange + openSoAmountChange)) < AMOUNT_EPSILON;
}

/** Reporting attributes (customer/parent/project/etc.) carried through from whichever stage is most current — prefers Invoice, then SO, then Pipeline; falls back to the prior snapshot if the anchor has no row at all in the current one (e.g. deleted this period). */
function pickReportingAttrs(current: { PIPELINE: StageAggregate; SO: StageAggregate; INVOICE: StageAggregate }, prior: { PIPELINE: StageAggregate; SO: StageAggregate; INVOICE: StageAggregate }) {
  const attrs = current.INVOICE.attrs ?? current.SO.attrs ?? current.PIPELINE.attrs ?? prior.INVOICE.attrs ?? prior.SO.attrs ?? prior.PIPELINE.attrs;
  return {
    customerName: attrs?.consolidatedCustomer ?? null,
    parent: attrs?.topLevelParent ?? null,
    projectName: attrs?.projectName ?? null,
    salesRep: attrs?.salesRep ?? null,
    department: attrs?.department ?? null,
    subsidiary: attrs?.subsidiary ?? null,
    currency: attrs?.currency ?? null,
  };
}

function buildOneComparisonRow(
  anchorId: string,
  reportType: ReportType,
  priorSnapshotDate: string,
  currentSnapshotDate: string,
  priorRaw: AnchorStages,
  currentRaw: AnchorStages,
): ComparisonRow {
  const prior = { PIPELINE: aggregateStage(priorRaw.PIPELINE), SO: aggregateStage(priorRaw.SO), INVOICE: aggregateStage(priorRaw.INVOICE) };
  const current = { PIPELINE: aggregateStage(currentRaw.PIPELINE), SO: aggregateStage(currentRaw.SO), INVOICE: aggregateStage(currentRaw.INVOICE) };

  const priorPipelineAmt = prior.PIPELINE.amount;
  const currentPipelineAmt = current.PIPELINE.amount;
  const pipelineAmountChange = currentPipelineAmt - priorPipelineAmt;

  const priorOpenSoAmt = prior.SO.amount;
  const currentOpenSoAmt = current.SO.amount;
  const openSoAmountChange = currentOpenSoAmt - priorOpenSoAmt;

  const priorInvoiceAmt = prior.INVOICE.amount;
  const currentInvoiceAmt = current.INVOICE.amount;
  const invoiceAmountChange = currentInvoiceAmt - priorInvoiceAmt;

  const soRate = current.SO.exchangeRate ?? prior.SO.exchangeRate;
  const invoiceRate = current.INVOICE.exchangeRate ?? prior.INVOICE.exchangeRate;
  const usdSoAmountChange = soRate != null ? openSoAmountChange * soRate : null;
  const usdInvoiceAmountChange = invoiceRate != null ? invoiceAmountChange * invoiceRate : null;

  const totalPriorAmount = priorOpenSoAmt + priorInvoiceAmt; // Pipeline excluded — not committed revenue
  const totalCurrentAmount = currentOpenSoAmt + currentInvoiceAmt;
  const totalAmountChange = totalCurrentAmount - totalPriorAmount;
  const usdTotalAmountChange = usdSoAmountChange != null && usdInvoiceAmountChange != null
    ? usdSoAmountChange + usdInvoiceAmountChange
    : null;

  const checkFlag = computeCheckFlag(totalAmountChange, invoiceAmountChange, openSoAmountChange);

  const priorPipelineRevDate = prior.PIPELINE.revenueDate;
  const currentPipelineRevDate = current.PIPELINE.revenueDate;
  const priorSoRevDate = prior.SO.revenueDate;
  const currentSoRevDate = current.SO.revenueDate;
  const priorInvoiceDate = prior.INVOICE.revenueDate;
  const currentInvoiceDate = current.INVOICE.revenueDate;

  const pipelineRevenueDateChange = stageDateChange(currentPipelineAmt, priorPipelineRevDate, currentPipelineRevDate);
  const soRevenueDateChange = stageDateChange(currentOpenSoAmt, priorSoRevDate, currentSoRevDate);
  const invoiceRevenuePeriodSummaryText = invoiceRevenuePeriodSummary(currentInvoiceAmt, currentInvoiceDate, currentSoRevDate);

  const lifecycleEvent = classifyLifecycleEvent({
    priorPipelineAmt, currentPipelineAmt, pipelineChange: pipelineAmountChange,
    priorOpenSoAmt, currentOpenSoAmt, soChange: openSoAmountChange,
    priorInvoiceAmt, currentInvoiceAmt, invoiceChange: invoiceAmountChange,
  });

  const attrs = pickReportingAttrs(current, prior);

  return {
    anchorId,
    reportType,
    priorSnapshotPeriod: priorSnapshotDate,
    currentSnapshotPeriod: currentSnapshotDate,

    priorPipelineAmt: priorPipelineAmt.toFixed(2),
    currentPipelineAmt: currentPipelineAmt.toFixed(2),
    pipelineAmountChange: pipelineAmountChange.toFixed(2),
    priorPipelineRevDate,
    currentPipelineRevDate,
    pipelineRevenueDateChange,

    priorOpenSoAmt: priorOpenSoAmt.toFixed(2),
    currentOpenSoAmt: currentOpenSoAmt.toFixed(2),
    openSoAmountChange: openSoAmountChange.toFixed(2),
    usdSoAmountChange: usdSoAmountChange != null ? usdSoAmountChange.toFixed(2) : null,
    priorSoRevDate,
    currentSoRevDate,
    soRevenueDateChange,

    priorInvoiceAmt: priorInvoiceAmt.toFixed(2),
    currentInvoiceAmt: currentInvoiceAmt.toFixed(2),
    invoiceAmountChange: invoiceAmountChange.toFixed(2),
    usdInvoiceAmountChange: usdInvoiceAmountChange != null ? usdInvoiceAmountChange.toFixed(2) : null,
    priorInvoiceDate,
    currentInvoiceDate,
    invoiceRevenuePeriodSummary: invoiceRevenuePeriodSummaryText,

    totalPriorAmount: totalPriorAmount.toFixed(2),
    totalCurrentAmount: totalCurrentAmount.toFixed(2),
    totalAmountChange: totalAmountChange.toFixed(2),
    usdTotalAmountChange: usdTotalAmountChange != null ? usdTotalAmountChange.toFixed(2) : null,

    checkFlag,
    lifecycleEvent,
    revenueDateChangeSummary: buildRevenueDateChangeSummary({
      pipeline: pipelineRevenueDateChange,
      so: soRevenueDateChange,
      invoice: invoiceRevenuePeriodSummaryText,
    }),

    customerName: attrs.customerName,
    parent: attrs.parent,
    projectName: attrs.projectName,
    salesRep: attrs.salesRep,
    department: attrs.department,
    subsidiary: attrs.subsidiary,
    currency: attrs.currency,
  };
}

const CONFLICT_UPDATE_SET = {
  pipelineAmountChange: sql`excluded.pipeline_amount_change`,
  currentPipelineAmt: sql`excluded.current_pipeline_amt`,
  priorPipelineAmt: sql`excluded.prior_pipeline_amt`,
  priorPipelineRevDate: sql`excluded.prior_pipeline_rev_date`,
  currentPipelineRevDate: sql`excluded.current_pipeline_rev_date`,
  pipelineRevenueDateChange: sql`excluded.pipeline_revenue_date_change`,
  priorOpenSoAmt: sql`excluded.prior_open_so_amt`,
  currentOpenSoAmt: sql`excluded.current_open_so_amt`,
  openSoAmountChange: sql`excluded.open_so_amount_change`,
  usdSoAmountChange: sql`excluded.usd_so_amount_change`,
  priorSoRevDate: sql`excluded.prior_so_rev_date`,
  currentSoRevDate: sql`excluded.current_so_rev_date`,
  soRevenueDateChange: sql`excluded.so_revenue_date_change`,
  priorInvoiceAmt: sql`excluded.prior_invoice_amt`,
  currentInvoiceAmt: sql`excluded.current_invoice_amt`,
  invoiceAmountChange: sql`excluded.invoice_amount_change`,
  usdInvoiceAmountChange: sql`excluded.usd_invoice_amount_change`,
  priorInvoiceDate: sql`excluded.prior_invoice_date`,
  currentInvoiceDate: sql`excluded.current_invoice_date`,
  invoiceRevenuePeriodSummary: sql`excluded.invoice_revenue_period_summary`,
  totalPriorAmount: sql`excluded.total_prior_amount`,
  totalCurrentAmount: sql`excluded.total_current_amount`,
  totalAmountChange: sql`excluded.total_amount_change`,
  usdTotalAmountChange: sql`excluded.usd_total_amount_change`,
  checkFlag: sql`excluded.check_flag`,
  lifecycleEvent: sql`excluded.lifecycle_event`,
  revenueDateChangeSummary: sql`excluded.revenue_date_change_summary`,
  customerName: sql`excluded.customer_name`,
  parent: sql`excluded.parent`,
  projectName: sql`excluded.project_name`,
  salesRep: sql`excluded.sales_rep`,
  department: sql`excluded.department`,
  subsidiary: sql`excluded.subsidiary`,
  currency: sql`excluded.currency`,
};

async function upsertInChunks(tx: Tx, rows: ComparisonRow[]): Promise<number> {
  let affected = 0;
  for (let i = 0; i < rows.length; i += COMPARISON_INSERT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + COMPARISON_INSERT_CHUNK_SIZE);
    if (chunk.length > 0) {
      const result = await tx.insert(revenueComparison).values(chunk).onConflictDoUpdate({
        target: [revenueComparison.anchorId, revenueComparison.reportType, revenueComparison.priorSnapshotPeriod, revenueComparison.currentSnapshotPeriod],
        set: CONFLICT_UPDATE_SET,
      }).returning({ id: revenueComparison.id });
      affected += result.length;
    }
  }
  return affected;
}

export interface ComparisonResult {
  reportType: ReportType;
  priorDate: string;
  currentDate: string;
  inserted: number;
  labelled: number;
}

/**
 * Diffs two snapshot dates for every anchor_id and writes one
 * revenue_comparison row per anchor.
 *
 * Returns { inserted: 0, labelled: 0 } rather than throwing when there is
 * nothing to compare (e.g. the very first run ever, where no prior snapshot
 * exists) — the query simply produces no rows to group.
 *
 * `labelled` always equals `inserted`/`upserted` here: unlike a two-pass
 * INSERT-then-UPDATE design, lifecycle_event and check_flag are computed
 * inline while building each row, so every row this call touches is already
 * fully labelled by the time it's written.
 */
export async function runComparison(
  db: DB,
  reportType: ReportType,
  priorDate: string,
  currentDate: string,
): Promise<ComparisonResult> {
  return db.transaction(async (tx) => {
    const [priorRows, currentRows] = await Promise.all([
      tx.select().from(factRevenueSnapshot).where(and(
        eq(factRevenueSnapshot.snapshotDate, priorDate),
        inArray(factRevenueSnapshot.sourceType, STAGE_SOURCE_TYPES),
      )),
      tx.select().from(factRevenueSnapshot).where(and(
        eq(factRevenueSnapshot.snapshotDate, currentDate),
        inArray(factRevenueSnapshot.sourceType, STAGE_SOURCE_TYPES),
      )),
    ]);

    const priorByAnchor = groupByAnchorAndStage(priorRows);
    const currentByAnchor = groupByAnchorAndStage(currentRows);
    const anchorIds = new Set<string>([...priorByAnchor.keys(), ...currentByAnchor.keys()]);

    const comparisonRows: ComparisonRow[] = [];
    for (const anchorId of anchorIds) {
      comparisonRows.push(buildOneComparisonRow(
        anchorId,
        reportType,
        priorDate,
        currentDate,
        priorByAnchor.get(anchorId) ?? {},
        currentByAnchor.get(anchorId) ?? {},
      ));
    }

    const affected = await upsertInChunks(tx, comparisonRows);
    return { reportType, priorDate, currentDate, inserted: affected, labelled: affected };
  });
}
