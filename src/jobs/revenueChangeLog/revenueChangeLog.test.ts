// Tests for the revenue_change_log rule engine and batch runner.
//
// Two suites, on purpose:
//
//   1. "evaluateChangeRules" — pure, no database, ALWAYS runs. The rule
//      priority order is the part most likely to regress, and it is fully
//      determined by the two arguments, so it is tested directly rather than
//      through a round trip.
//
//   2. "runChangeLogForBatch" — real PostgreSQL, seeds real revenue_comparison
//      and fact_revenue_snapshot rows and asserts on the rows that actually
//      land in revenue_change_log. Guarded on TEST_DATABASE_URL rather than
//      falling back to DATABASE_URL, matching comparisonBuilder.test.ts: this
//      suite writes to reporting tables, and silently picking up a .env
//      pointing at a shared database would seed junk into real reporting.
//
//        TEST_DATABASE_URL=postgres://... npm test
//
// Every seeded row uses an anchor_id under the TEST-CL- prefix and snapshot
// dates in 1990, so it can be removed precisely and cannot collide with real
// snapshot data.

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq, like } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../db/schema/index.js';
import { factRevenueSnapshot, revenueComparison, revenueChangeLog } from '../../db/schema/index.js';
import {
  evaluateChangeRules,
  runChangeLogForBatch,
  getOriginalBaseline,
  SEVERITY_THRESHOLDS,
  CHANGE_TYPES,
  type EnrichedComparisonRow,
  type OriginalBaseline,
} from './revenueChangeLog.js';

// ══════════════════════════════════════════════════════════════════════════
//  1. Pure rule-engine tests
// ══════════════════════════════════════════════════════════════════════════

/** An enriched comparison row where nothing has changed — each test overrides only the fields its rule cares about. */
function enriched(overrides: Partial<EnrichedComparisonRow> = {}): EnrichedComparisonRow {
  const base: EnrichedComparisonRow = {
    anchorId: 'EST100190',
    reportType: 'DOD',
    fromSnapshotDate: '2026-07-22',
    toSnapshotDate: '2026-07-23',
    lifecycleEvent: 'NO_CHANGE',

    sourceType: 'SO',
    sourceRecordId: 40315,
    documentNumber: 'SO40315',

    priorForeignAmount: 100000,
    currentForeignAmount: 100000,
    priorRevenuePeriod: '2026-07-01',
    currentRevenuePeriod: '2026-07-01',

    priorCurrency: 'USD',
    currentCurrency: 'USD',
    priorExchangeRate: 1,
    currentExchangeRate: 1,
    priorReportedUsdAmount: 100000,
    currentReportedUsdAmount: 100000,

    stages: {
      priorPipeline: 0, currentPipeline: 0,
      priorOpenSo: 100000, currentOpenSo: 100000,
      priorInvoice: 0, currentInvoice: 0,
    },
  };
  return { ...base, ...overrides };
}

function baselineOf(foreignAmount: number, overrides: Partial<OriginalBaseline> = {}): OriginalBaseline {
  return {
    anchorId: 'EST100190',
    sourceType: 'SO',
    snapshotDate: '2026-01-05',
    foreignAmount,
    usdAmount: foreignAmount,
    exchangeRate: 1,
    revenuePeriod: '2026-07-01',
    currency: 'USD',
    ...overrides,
  };
}

describe('evaluateChangeRules', () => {
  // ── Rule 1: LIFECYCLE ──────────────────────────────────────────────────

  test('rule 1: maps PIPELINE_CONVERTED_TO_SO to the prose change_type with LIFECYCLE driver', () => {
    const rows = evaluateChangeRules(enriched({
      lifecycleEvent: 'PIPELINE_CONVERTED_TO_SO',
      priorForeignAmount: 0,
      currentForeignAmount: 100000,
      stages: {
        priorPipeline: 100000, currentPipeline: 0,
        priorOpenSo: 0, currentOpenSo: 100000,
        priorInvoice: 0, currentInvoice: 0,
      },
    }), null);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].changeType, 'Pipeline converted to Sales Order');
    assert.equal(rows[0].changeDriver, 'LIFECYCLE');
    assert.equal(rows[0].controlSeverity, SEVERITY_THRESHOLDS.lifecycle_severity);
    // Plain language with the real numbers in it — not boilerplate.
    assert.equal(
      rows[0].changeDescription,
      'SO40315 converted from pipeline to sales order — $100,000 of pipeline became $100,000 of open sales-order value as of 2026-07-23.',
    );
  });

  test('rule 1: SO partially invoiced describes invoiced vs remaining open', () => {
    const rows = evaluateChangeRules(enriched({
      lifecycleEvent: 'SO_PARTIALLY_INVOICED',
      stages: {
        priorPipeline: 0, currentPipeline: 0,
        priorOpenSo: 1200000, currentOpenSo: 800000,
        priorInvoice: 0, currentInvoice: 400000,
      },
    }), null);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].changeType, 'SO partially invoiced');
    assert.equal(rows[0].changeDriver, 'LIFECYCLE');
    assert.equal(
      rows[0].changeDescription,
      'SO40315 partially invoiced — $400,000 of $1,200,000 invoiced, $800,000 remains open.',
    );
  });

  test('rule 1: a deleted anchor names the anchor and the snapshot date it vanished on', () => {
    const rows = evaluateChangeRules(enriched({
      lifecycleEvent: 'PIPELINE_DELETED',
      currentForeignAmount: 0,
    }), null);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].changeType, 'Deleted');
    assert.equal(rows[0].changeDriver, 'LIFECYCLE');
    assert.equal(rows[0].controlSeverity, SEVERITY_THRESHOLDS.deleted_severity);
    assert.match(
      String(rows[0].changeDescription),
      /^Anchor EST100190 no longer appears in the current snapshot as of 2026-07-23 — record deleted\./,
    );
  });

  test('rule 1: STOPs — a lifecycle event never also emits an amount or period row', () => {
    const rows = evaluateChangeRules(enriched({
      lifecycleEvent: 'SO_FULLY_INVOICED',
      priorForeignAmount: 100000,
      currentForeignAmount: 0,          // would otherwise be a Revenue Decrease
      currentExchangeRate: 1.5,         // would otherwise be Business + FX
      currentRevenuePeriod: '2026-09-01', // would otherwise add a Revenue Shift
    }), null);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].changeType, 'SO fully invoiced');
  });

  test('rule 1: derived context columns are populated on lifecycle rows too', () => {
    const rows = evaluateChangeRules(enriched({
      lifecycleEvent: 'SO_PARTIALLY_INVOICED',
      priorForeignAmount: 1200000,
      currentForeignAmount: 800000,
      currentRevenuePeriod: '2026-09-01',
      currentReportedUsdAmount: 800000,
      priorReportedUsdAmount: 1200000,
    }), baselineOf(1000000));

    assert.equal(rows[0].foreignDeltaVsPrior, '-400000.00');
    assert.equal(rows[0].foreignDeltaVsOriginal, '-200000.00');
    assert.equal(rows[0].reportedUsdDeltaVsPrior, '-400000.00');
    assert.equal(rows[0].monthsShiftedVsPrior, 2);
    assert.equal(rows[0].monthsShiftedVsOriginal, 2);
  });

  // ── Rule 2: CURRENCY_CHANGED ───────────────────────────────────────────

  test('rule 2: a currency change wins over the amount rules even when amounts also moved', () => {
    const rows = evaluateChangeRules(enriched({
      priorCurrency: 'EUR',
      currentCurrency: 'USD',
      priorForeignAmount: 100000,
      currentForeignAmount: 120000, // would be a Revenue Increase if rule 2 did not stop first
      currentExchangeRate: 1.12,
    }), null);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].changeType, CHANGE_TYPES.CURRENCY_CHANGE);
    assert.equal(rows[0].changeDriver, 'DATA_QUALITY');
    assert.equal(rows[0].controlSeverity, 'WARNING');
    // A delta across two currencies would be arithmetic on incomparable units.
    assert.equal(rows[0].foreignDeltaVsPrior, null);
    assert.match(String(rows[0].changeDescription), /changed currency from EUR to USD/);
  });

  test('rule 2: a currency change also outranks a co-occurring period shift', () => {
    const rows = evaluateChangeRules(enriched({
      priorCurrency: 'EUR',
      currentCurrency: 'GBP',
      currentRevenuePeriod: '2026-09-01',
    }), null);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].changeType, CHANGE_TYPES.CURRENCY_CHANGE);
  });

  test('rule 2: one missing currency is missing data, not a currency change', () => {
    const rows = evaluateChangeRules(enriched({
      priorCurrency: null,
      currentCurrency: 'USD',
      currentForeignAmount: 120000,
    }), null);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].changeType, CHANGE_TYPES.REVENUE_INCREASE);
  });

  // ── Rule 3: REVERTED_TO_ORIGINAL ───────────────────────────────────────

  test('rule 3: returning to the original baseline is Reverted to Original, and STOPs', () => {
    const rows = evaluateChangeRules(enriched({
      priorForeignAmount: 80000,
      currentForeignAmount: 100000,
      currentRevenuePeriod: '2026-09-01', // STOP means no Revenue Shift row is added
    }), baselineOf(100000));

    assert.equal(rows.length, 1);
    assert.equal(rows[0].changeType, CHANGE_TYPES.REVERTED_TO_ORIGINAL);
    assert.equal(rows[0].changeDriver, 'BUSINESS');
    assert.equal(rows[0].originalForeignAmount, '100000.00');
  });

  test('rule 3: does not fire when the prior amount was already at the original', () => {
    const rows = evaluateChangeRules(enriched({
      priorForeignAmount: 100000,
      currentForeignAmount: 120000,
    }), baselineOf(100000));

    assert.equal(rows[0].changeType, CHANGE_TYPES.REVENUE_INCREASE);
  });

  test('rule 3: with no baseline at all, evaluation falls through to the amount rules', () => {
    const rows = evaluateChangeRules(enriched({
      priorForeignAmount: 80000,
      currentForeignAmount: 100000,
    }), null);

    assert.equal(rows[0].changeType, CHANGE_TYPES.REVENUE_INCREASE);
  });

  // ── Rule 4: FX_ONLY ────────────────────────────────────────────────────

  test('rule 4: unchanged foreign amount with a moved rate is FX Only Change with the flag set', () => {
    const rows = evaluateChangeRules(enriched({
      priorCurrency: 'EUR',
      currentCurrency: 'EUR',
      priorForeignAmount: 100000,
      currentForeignAmount: 100000,
      priorExchangeRate: 1.08,
      currentExchangeRate: 1.12,
      priorReportedUsdAmount: 108000,
      currentReportedUsdAmount: 112000,
    }), null);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].changeType, CHANGE_TYPES.FX_ONLY);
    assert.equal(rows[0].changeDriver, 'FX_ONLY');
    assert.equal(rows[0].fxOnlyChangeFlag, true);
    assert.equal(rows[0].foreignDeltaVsPrior, '0.00');
    assert.equal(
      rows[0].changeDescription,
      'FX-only movement — foreign amount unchanged at €100,000, but USD value shifted from $108,000 to $112,000 due to exchange rate change (1.08 → 1.12).',
    );
  });

  // ── Rule 5: BUSINESS_AND_FX ────────────────────────────────────────────

  test('rule 5: both amount and rate moving is Business + FX Change', () => {
    const rows = evaluateChangeRules(enriched({
      priorCurrency: 'EUR',
      currentCurrency: 'EUR',
      priorForeignAmount: 100000,
      currentForeignAmount: 120000,
      priorExchangeRate: 1.08,
      currentExchangeRate: 1.12,
      priorReportedUsdAmount: 108000,
      currentReportedUsdAmount: 134400,
    }), null);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].changeType, CHANGE_TYPES.BUSINESS_AND_FX);
    assert.equal(rows[0].changeDriver, 'BUSINESS_AND_FX');
    assert.equal(rows[0].fxOnlyChangeFlag, false);
    assert.equal(rows[0].foreignDeltaVsPrior, '20000.00');
    assert.match(String(rows[0].changeDescription), /exchange rate moved \(1\.08 → 1\.12\)/);
  });

  // ── Rule 6: BUSINESS_CHANGE ────────────────────────────────────────────

  test('rule 6: an amount rise with a flat rate is Revenue Increase, no FX impact', () => {
    const rows = evaluateChangeRules(enriched({
      priorForeignAmount: 100000,
      currentForeignAmount: 120000,
      priorReportedUsdAmount: 100000,
      currentReportedUsdAmount: 120000,
    }), null);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].changeType, CHANGE_TYPES.REVENUE_INCREASE);
    assert.equal(rows[0].changeDriver, 'BUSINESS');
    assert.equal(
      rows[0].changeDescription,
      'Revenue increased from $100,000 to $120,000 (+$20,000), no FX impact.',
    );
  });

  test('rule 6: an amount fall with a flat rate is Revenue Decrease', () => {
    const rows = evaluateChangeRules(enriched({
      priorForeignAmount: 120000,
      currentForeignAmount: 100000,
    }), null);

    assert.equal(rows[0].changeType, CHANGE_TYPES.REVENUE_DECREASE);
    assert.equal(rows[0].foreignDeltaVsPrior, '-20000.00');
    assert.equal(
      rows[0].changeDescription,
      'Revenue decreased from $120,000 to $100,000 (-$20,000), no FX impact.',
    );
  });

  // ── Rule 7: PERIOD_SHIFT ───────────────────────────────────────────────

  test('rule 7: a period move with identical amounts produces a single Revenue Shift row', () => {
    const rows = evaluateChangeRules(enriched({
      priorRevenuePeriod: '2026-07-01',
      currentRevenuePeriod: '2026-09-01',
    }), null);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].changeType, CHANGE_TYPES.REVENUE_SHIFT);
    assert.equal(rows[0].changeDriver, 'PERIOD');
    assert.equal(rows[0].monthsShiftedVsPrior, 2);
    assert.match(String(rows[0].changeDescription), /Revenue period moved from 2026-07 to 2026-09 \(\+2 months\)/);
  });

  test('rule 7: an amount change AND a period move produce TWO rows, amount rule first', () => {
    const rows = evaluateChangeRules(enriched({
      priorForeignAmount: 100000,
      currentForeignAmount: 120000,
      priorRevenuePeriod: '2026-07-01',
      currentRevenuePeriod: '2026-09-01',
    }), null);

    assert.equal(rows.length, 2);
    assert.equal(rows[0].changeType, CHANGE_TYPES.REVENUE_INCREASE);
    assert.equal(rows[0].changeDriver, 'BUSINESS');
    assert.equal(rows[1].changeType, CHANGE_TYPES.REVENUE_SHIFT);
    assert.equal(rows[1].changeDriver, 'PERIOD');
    // Both rows belong to the same batch group.
    assert.equal(rows[0].changeGroupId, rows[1].changeGroupId);
  });

  test('rule 7: an FX-only change AND a period move also produce TWO rows', () => {
    const rows = evaluateChangeRules(enriched({
      priorExchangeRate: 1.08,
      currentExchangeRate: 1.12,
      priorReportedUsdAmount: 108000,
      currentReportedUsdAmount: 112000,
      currentRevenuePeriod: '2026-09-01',
    }), null);

    assert.equal(rows.length, 2);
    assert.equal(rows[0].changeType, CHANGE_TYPES.FX_ONLY);
    assert.equal(rows[1].changeType, CHANGE_TYPES.REVENUE_SHIFT);
  });

  // ── Rule 8: NO_CHANGE ──────────────────────────────────────────────────

  test('rule 8: a row where nothing moved produces zero rows', () => {
    assert.deepEqual(evaluateChangeRules(enriched(), null), []);
  });

  test('rule 8: still zero rows when a baseline exists and everything already sits on it', () => {
    assert.deepEqual(evaluateChangeRules(enriched(), baselineOf(100000)), []);
  });

  test('rule 8: NO_CHANGE / OTHER_CHANGE lifecycle codes are not lifecycle events', () => {
    // These are not in LIFECYCLE_EVENT_MAP, so rule 1 must not swallow them —
    // the amount rules classify them from the real numbers instead.
    for (const code of ['NO_CHANGE', 'OTHER_CHANGE', 'SO_AMOUNT_INCREASED', 'PIPELINE_OPEN_NO_CHANGE']) {
      assert.deepEqual(evaluateChangeRules(enriched({ lifecycleEvent: code }), null), [], code);
    }
  });

  // ── Severity banding ───────────────────────────────────────────────────

  test('severity comes from the config thresholds, on |foreign_delta_vs_prior|', () => {
    const withDelta = (delta: number) => evaluateChangeRules(enriched({
      priorForeignAmount: 0,
      currentForeignAmount: delta,
    }), null)[0].controlSeverity;

    assert.equal(withDelta(SEVERITY_THRESHOLDS.info_max_abs_amount), 'INFO');
    assert.equal(withDelta(SEVERITY_THRESHOLDS.info_max_abs_amount + 1), 'WARNING');
    assert.equal(withDelta(SEVERITY_THRESHOLDS.warning_max_abs_amount), 'WARNING');
    assert.equal(withDelta(SEVERITY_THRESHOLDS.warning_max_abs_amount + 1), 'CRITICAL');
  });

  test('every emitted control_severity fits the varchar(10) column', () => {
    for (const value of Object.values(SEVERITY_THRESHOLDS)) {
      if (typeof value === 'string') assert.ok(value.length <= 10, value);
    }
  });

  test('every emitted change_type fits the varchar(50) column', () => {
    const rows = [
      ...evaluateChangeRules(enriched({ lifecycleEvent: 'PIPELINE_CONVERTED_TO_SO' }), null),
      ...evaluateChangeRules(enriched({ priorCurrency: 'EUR' }), null),
      ...evaluateChangeRules(enriched({ priorForeignAmount: 1 }), baselineOf(100000)),
      ...evaluateChangeRules(enriched({ currentForeignAmount: 120000, currentRevenuePeriod: '2026-09-01' }), null),
    ];
    assert.ok(rows.length > 0);
    for (const r of rows) assert.ok(r.changeType.length <= 50, r.changeType);
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  2. Batch runner — integration
// ══════════════════════════════════════════════════════════════════════════

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// Snapshot dates are unique to THIS suite. runChangeLogForBatch selects every
// comparison row for a (report_type, date) — not just this suite's anchors — so
// two suites sharing a snapshot date would evaluate each other's rows and write
// change-log rows neither one's prefix-scoped cleanup removes. Each suite
// therefore owns its own year: 1990 = comparisonBuilder.test.ts,
// 1991 = endToEnd.test.ts, 1992 = here.
const PRIOR = '1992-02-04';
const CURRENT = '1992-02-05';
const BASELINE_DATE = '1991-02-04'; // earlier than PRIOR, so it wins the baseline lookup
const ANCHOR_PREFIX = 'TEST-CL-';
const REPORT_TYPE = 'DOD';

interface SnapshotSeed {
  anchor: string;
  date: string;
  sourceType: 'PIPELINE' | 'SO' | 'INVOICE';
  amount: string;
  currency?: string;
  exchangeRate?: string;
  usdAmount?: string;
  likelyToClose?: string;
  revenueDate?: string;
}

function snapshotSeed(s: SnapshotSeed): typeof factRevenueSnapshot.$inferInsert {
  const rate = s.exchangeRate ?? '1';
  return {
    snapshotDate: s.date,
    snapshotTs: new Date(`${s.date}T00:00:00.000Z`),
    sourceType: s.sourceType,
    internalId: `${s.anchor}-${s.sourceType}-${s.date}`,
    anchorId: s.anchor,
    documentNumber: `${s.anchor}-DOC`,
    consolidatedCustomer: 'Change Log Test Customer',
    currency: s.currency ?? 'USD',
    likelyToClose: s.likelyToClose ?? '4',
    revenueDate: s.revenueDate ?? '1990-03-15',
    revenuePeriod: `${(s.revenueDate ?? '1990-03-15').slice(0, 7)}-01`,
    foreignAmount: s.amount,
    exchangeRate: rate,
    usdAmount: s.usdAmount ?? (Number(s.amount) * Number(rate)).toFixed(2),
  };
}

interface ComparisonSeed {
  anchor: string;
  lifecycleEvent?: string;
  priorPipeline?: string;
  currentPipeline?: string;
  priorOpenSo?: string;
  currentOpenSo?: string;
  priorInvoice?: string;
  currentInvoice?: string;
  priorSoRevDate?: string;
  currentSoRevDate?: string;
  currency?: string;
}

function comparisonSeed(s: ComparisonSeed): typeof revenueComparison.$inferInsert {
  return {
    anchorId: s.anchor,
    reportType: REPORT_TYPE,
    priorSnapshotPeriod: PRIOR,
    currentSnapshotPeriod: CURRENT,
    priorPipelineAmt: s.priorPipeline ?? '0.00',
    currentPipelineAmt: s.currentPipeline ?? '0.00',
    priorOpenSoAmt: s.priorOpenSo ?? '0.00',
    currentOpenSoAmt: s.currentOpenSo ?? '0.00',
    priorInvoiceAmt: s.priorInvoice ?? '0.00',
    currentInvoiceAmt: s.currentInvoice ?? '0.00',
    priorSoRevDate: s.priorSoRevDate ?? '1990-03-15',
    currentSoRevDate: s.currentSoRevDate ?? '1990-03-15',
    lifecycleEvent: s.lifecycleEvent ?? 'NO_CHANGE',
    currency: s.currency ?? 'USD',
  };
}

describe('runChangeLogForBatch', { skip: TEST_DATABASE_URL ? false : 'set TEST_DATABASE_URL to run integration tests' }, () => {
  const client = postgres(TEST_DATABASE_URL ?? '', { max: 1, prepare: false });
  const db = drizzle(client, { schema });

  async function cleanup() {
    await db.delete(revenueChangeLog).where(like(revenueChangeLog.anchorId, `${ANCHOR_PREFIX}%`));
    await db.delete(revenueComparison).where(like(revenueComparison.anchorId, `${ANCHOR_PREFIX}%`));
    await db.delete(factRevenueSnapshot).where(like(factRevenueSnapshot.anchorId, `${ANCHOR_PREFIX}%`));
  }

  /** The change-log rows for one test anchor, in insertion order. */
  async function logRowsFor(anchor: string) {
    return db.select().from(revenueChangeLog).where(and(
      eq(revenueChangeLog.anchorId, anchor),
      eq(revenueChangeLog.toSnapshotDate, CURRENT),
    )).orderBy(revenueChangeLog.changeEventId);
  }

  async function seed(comparisons: ComparisonSeed[], snapshots: SnapshotSeed[]) {
    if (snapshots.length > 0) await db.insert(factRevenueSnapshot).values(snapshots.map(snapshotSeed));
    if (comparisons.length > 0) await db.insert(revenueComparison).values(comparisons.map(comparisonSeed));
  }

  before(cleanup);
  beforeEach(cleanup);
  after(async () => {
    await cleanup();
    await client.end();
  });

  test('a Pipeline→SO conversion writes one LIFECYCLE row with the prose change_type and worded description', async () => {
    const anchor = `${ANCHOR_PREFIX}P2SO`;
    await seed(
      [{ anchor, lifecycleEvent: 'PIPELINE_CONVERTED_TO_SO', priorPipeline: '100000.00', currentOpenSo: '100000.00' }],
      [
        { anchor, date: PRIOR, sourceType: 'PIPELINE', amount: '100000.00' },
        { anchor, date: CURRENT, sourceType: 'SO', amount: '100000.00' },
      ],
    );

    const result = await runChangeLogForBatch(db, REPORT_TYPE, CURRENT);
    assert.equal(result.evaluated, 1);
    assert.equal(result.written, 1);

    const rows = await logRowsFor(anchor);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].changeType, 'Pipeline converted to Sales Order');
    assert.equal(rows[0].changeDriver, 'LIFECYCLE');
    assert.equal(rows[0].reportType, REPORT_TYPE);
    assert.equal(rows[0].fromSnapshotDate, PRIOR);
    assert.equal(rows[0].toSnapshotDate, CURRENT);
    assert.equal(
      rows[0].changeDescription,
      `${anchor}-DOC converted from pipeline to sales order — $100,000 of pipeline became $100,000 of open sales-order value as of ${CURRENT}.`,
    );
  });

  test('an unchanged foreign amount with a moved exchange rate writes FX Only Change with the flag set', async () => {
    const anchor = `${ANCHOR_PREFIX}FXONLY`;
    await seed(
      [{ anchor, priorOpenSo: '100000.00', currentOpenSo: '100000.00', currency: 'EUR' }],
      [
        { anchor, date: PRIOR, sourceType: 'SO', amount: '100000.00', currency: 'EUR', exchangeRate: '1.08000000', usdAmount: '108000.00' },
        { anchor, date: CURRENT, sourceType: 'SO', amount: '100000.00', currency: 'EUR', exchangeRate: '1.12000000', usdAmount: '112000.00' },
      ],
    );

    await runChangeLogForBatch(db, REPORT_TYPE, CURRENT);

    const rows = await logRowsFor(anchor);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].changeType, CHANGE_TYPES.FX_ONLY);
    assert.equal(rows[0].changeDriver, 'FX_ONLY');
    assert.equal(rows[0].fxOnlyChangeFlag, true);
    assert.equal(rows[0].priorExchangeRate, '1.08000000');
    assert.equal(rows[0].currentExchangeRate, '1.12000000');
    assert.equal(rows[0].reportedUsdDeltaVsPrior, '4000.00');
  });

  test('both amount and exchange rate moving writes Business + FX Change', async () => {
    const anchor = `${ANCHOR_PREFIX}BIZFX`;
    await seed(
      [{ anchor, priorOpenSo: '100000.00', currentOpenSo: '120000.00', currency: 'EUR' }],
      [
        { anchor, date: PRIOR, sourceType: 'SO', amount: '100000.00', currency: 'EUR', exchangeRate: '1.08000000', usdAmount: '108000.00' },
        { anchor, date: CURRENT, sourceType: 'SO', amount: '120000.00', currency: 'EUR', exchangeRate: '1.12000000', usdAmount: '134400.00' },
      ],
    );

    await runChangeLogForBatch(db, REPORT_TYPE, CURRENT);

    const rows = await logRowsFor(anchor);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].changeType, CHANGE_TYPES.BUSINESS_AND_FX);
    assert.equal(rows[0].changeDriver, 'BUSINESS_AND_FX');
    assert.equal(rows[0].fxOnlyChangeFlag, false);
    assert.equal(rows[0].foreignDeltaVsPrior, '20000.00');
  });

  test('only the revenue period moving writes a single Revenue Shift row', async () => {
    const anchor = `${ANCHOR_PREFIX}SHIFT`;
    await seed(
      [{
        anchor, priorOpenSo: '100000.00', currentOpenSo: '100000.00',
        priorSoRevDate: '1990-03-15', currentSoRevDate: '1990-05-20',
      }],
      [
        { anchor, date: PRIOR, sourceType: 'SO', amount: '100000.00', revenueDate: '1990-03-15' },
        { anchor, date: CURRENT, sourceType: 'SO', amount: '100000.00', revenueDate: '1990-05-20' },
      ],
    );

    await runChangeLogForBatch(db, REPORT_TYPE, CURRENT);

    const rows = await logRowsFor(anchor);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].changeType, CHANGE_TYPES.REVENUE_SHIFT);
    assert.equal(rows[0].changeDriver, 'PERIOD');
    assert.equal(rows[0].priorRevenuePeriod, '1990-03-01');
    assert.equal(rows[0].currentRevenuePeriod, '1990-05-01');
    assert.equal(rows[0].monthsShiftedVsPrior, 2);
  });

  test('amount AND period both moving writes TWO rows — the amount rule and Revenue Shift', async () => {
    const anchor = `${ANCHOR_PREFIX}BOTH`;
    await seed(
      [{
        anchor, priorOpenSo: '100000.00', currentOpenSo: '120000.00',
        priorSoRevDate: '1990-03-15', currentSoRevDate: '1990-05-20',
      }],
      [
        { anchor, date: PRIOR, sourceType: 'SO', amount: '100000.00', revenueDate: '1990-03-15' },
        { anchor, date: CURRENT, sourceType: 'SO', amount: '120000.00', revenueDate: '1990-05-20' },
      ],
    );

    const result = await runChangeLogForBatch(db, REPORT_TYPE, CURRENT);
    assert.equal(result.written, 2);

    const rows = await logRowsFor(anchor);
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map(r => r.changeType).sort(),
      [CHANGE_TYPES.REVENUE_INCREASE, CHANGE_TYPES.REVENUE_SHIFT].sort(),
    );
    // Both events from one comparison row share the batch's change_group_id.
    assert.equal(rows[0].changeGroupId, rows[1].changeGroupId);
  });

  test('a comparison row where nothing changed writes ZERO rows', async () => {
    const anchor = `${ANCHOR_PREFIX}NOCHANGE`;
    await seed(
      [{ anchor, priorOpenSo: '100000.00', currentOpenSo: '100000.00' }],
      [
        { anchor, date: PRIOR, sourceType: 'SO', amount: '100000.00' },
        { anchor, date: CURRENT, sourceType: 'SO', amount: '100000.00' },
      ],
    );

    const result = await runChangeLogForBatch(db, REPORT_TYPE, CURRENT);
    assert.equal(result.evaluated, 1);
    assert.equal(result.written, 0);
    assert.deepEqual(await logRowsFor(anchor), []);
  });

  test('a currency change writes Currency Change / DATA_QUALITY even though the amounts also differ', async () => {
    const anchor = `${ANCHOR_PREFIX}CCY`;
    await seed(
      [{ anchor, priorOpenSo: '100000.00', currentOpenSo: '120000.00' }],
      [
        { anchor, date: PRIOR, sourceType: 'SO', amount: '100000.00', currency: 'EUR', exchangeRate: '1.08000000', usdAmount: '108000.00' },
        { anchor, date: CURRENT, sourceType: 'SO', amount: '120000.00', currency: 'USD', exchangeRate: '1.00000000', usdAmount: '120000.00' },
      ],
    );

    await runChangeLogForBatch(db, REPORT_TYPE, CURRENT);

    const rows = await logRowsFor(anchor);
    // Exactly one row: the currency rule STOPped before the amount rules,
    // so there is no Revenue Increase row alongside it.
    assert.equal(rows.length, 1);
    assert.equal(rows[0].changeType, CHANGE_TYPES.CURRENCY_CHANGE);
    assert.equal(rows[0].changeDriver, 'DATA_QUALITY');
    assert.equal(rows[0].controlSeverity, 'WARNING');
    assert.equal(rows[0].foreignDeltaVsPrior, null);
  });

  test('running the same batch twice inserts no duplicates', async () => {
    const anchor = `${ANCHOR_PREFIX}RERUN`;
    await seed(
      [{
        anchor, priorOpenSo: '100000.00', currentOpenSo: '120000.00',
        priorSoRevDate: '1990-03-15', currentSoRevDate: '1990-05-20',
      }],
      [
        { anchor, date: PRIOR, sourceType: 'SO', amount: '100000.00', revenueDate: '1990-03-15' },
        { anchor, date: CURRENT, sourceType: 'SO', amount: '120000.00', revenueDate: '1990-05-20' },
      ],
    );

    const first = await runChangeLogForBatch(db, REPORT_TYPE, CURRENT);
    assert.equal(first.written, 2);
    assert.equal(first.skippedAsDuplicate, 0);

    const second = await runChangeLogForBatch(db, REPORT_TYPE, CURRENT);
    assert.equal(second.written, 0, 'a re-run must write nothing');
    assert.equal(second.skippedAsDuplicate, 2, 'both rows should be recognised as already present');

    assert.equal((await logRowsFor(anchor)).length, 2, 'still exactly two rows after the re-run');
  });

  test('one bad anchor does not stop the rest of the batch', async () => {
    const good = `${ANCHOR_PREFIX}GOOD`;
    const bad = `${ANCHOR_PREFIX}BAD`;
    await seed(
      [
        { anchor: good, priorOpenSo: '100000.00', currentOpenSo: '120000.00' },
        // A NULL revenue date on one side and a non-null on the other is the
        // shape most likely to trip date arithmetic — it must still classify.
        { anchor: bad, priorOpenSo: '50000.00', currentOpenSo: '70000.00', priorSoRevDate: undefined },
      ],
      [
        { anchor: good, date: PRIOR, sourceType: 'SO', amount: '100000.00' },
        { anchor: good, date: CURRENT, sourceType: 'SO', amount: '120000.00' },
        { anchor: bad, date: PRIOR, sourceType: 'SO', amount: '50000.00' },
        { anchor: bad, date: CURRENT, sourceType: 'SO', amount: '70000.00' },
      ],
    );

    const result = await runChangeLogForBatch(db, REPORT_TYPE, CURRENT);
    assert.equal(result.evaluated, 2);
    assert.equal(result.failed, 0);
    assert.equal((await logRowsFor(good)).length, 1);
  });

  test('the batch summary counts by change_type', async () => {
    await seed(
      [
        { anchor: `${ANCHOR_PREFIX}S1`, priorOpenSo: '10.00', currentOpenSo: '20.00' },
        { anchor: `${ANCHOR_PREFIX}S2`, priorOpenSo: '30.00', currentOpenSo: '20.00' },
        { anchor: `${ANCHOR_PREFIX}S3`, priorOpenSo: '40.00', currentOpenSo: '40.00' },
      ],
      [
        { anchor: `${ANCHOR_PREFIX}S1`, date: PRIOR, sourceType: 'SO', amount: '10.00' },
        { anchor: `${ANCHOR_PREFIX}S1`, date: CURRENT, sourceType: 'SO', amount: '20.00' },
        { anchor: `${ANCHOR_PREFIX}S2`, date: PRIOR, sourceType: 'SO', amount: '30.00' },
        { anchor: `${ANCHOR_PREFIX}S2`, date: CURRENT, sourceType: 'SO', amount: '20.00' },
        { anchor: `${ANCHOR_PREFIX}S3`, date: PRIOR, sourceType: 'SO', amount: '40.00' },
        { anchor: `${ANCHOR_PREFIX}S3`, date: CURRENT, sourceType: 'SO', amount: '40.00' },
      ],
    );

    const result = await runChangeLogForBatch(db, REPORT_TYPE, CURRENT);
    assert.equal(result.evaluated, 3);
    assert.equal(result.written, 2); // S3 changed nothing
    assert.equal(result.byChangeType[CHANGE_TYPES.REVENUE_INCREASE], 1);
    assert.equal(result.byChangeType[CHANGE_TYPES.REVENUE_DECREASE], 1);
  });

  // ── getOriginalBaseline ────────────────────────────────────────────────

  test('getOriginalBaseline returns the earliest qualifying snapshot row', async () => {
    const anchor = `${ANCHOR_PREFIX}BASE`;
    await seed([], [
      { anchor, date: BASELINE_DATE, sourceType: 'SO', amount: '55000.00' },
      { anchor, date: PRIOR, sourceType: 'SO', amount: '100000.00' },
      { anchor, date: CURRENT, sourceType: 'SO', amount: '120000.00' },
    ]);

    const baseline = await getOriginalBaseline(db, anchor);
    assert.equal(baseline?.snapshotDate, BASELINE_DATE);
    assert.equal(baseline?.foreignAmount, 55000);
  });

  test('getOriginalBaseline skips PIPELINE rows with likely_to_close <= 3 or a zero amount', async () => {
    const anchor = `${ANCHOR_PREFIX}BASEPIPE`;
    await seed([], [
      { anchor, date: '1988-01-01', sourceType: 'PIPELINE', amount: '10000.00', likelyToClose: '2' }, // below threshold
      { anchor, date: '1988-06-01', sourceType: 'PIPELINE', amount: '0.00', likelyToClose: '5' }, // zero amount
      { anchor, date: BASELINE_DATE, sourceType: 'PIPELINE', amount: '77000.00', likelyToClose: '4' }, // first qualifying
    ]);

    const baseline = await getOriginalBaseline(db, anchor);
    assert.equal(baseline?.snapshotDate, BASELINE_DATE);
    assert.equal(baseline?.foreignAmount, 77000);
  });

  test('getOriginalBaseline tolerates a non-numeric likely_to_close instead of failing the cast', async () => {
    const anchor = `${ANCHOR_PREFIX}BASETEXT`;
    await seed([], [
      { anchor, date: '1988-01-01', sourceType: 'PIPELINE', amount: '10000.00', likelyToClose: 'High' },
      { anchor, date: BASELINE_DATE, sourceType: 'PIPELINE', amount: '88000.00', likelyToClose: '5' },
    ]);

    const baseline = await getOriginalBaseline(db, anchor);
    assert.equal(baseline?.foreignAmount, 88000);
  });

  test('getOriginalBaseline returns null for an anchor that has never qualified', async () => {
    assert.equal(await getOriginalBaseline(db, `${ANCHOR_PREFIX}NEVER`), null);
  });

  test('a baseline the current amount returns to writes Reverted to Original', async () => {
    const anchor = `${ANCHOR_PREFIX}REVERT`;
    await seed(
      [{ anchor, priorOpenSo: '80000.00', currentOpenSo: '55000.00' }],
      [
        { anchor, date: BASELINE_DATE, sourceType: 'SO', amount: '55000.00' },
        { anchor, date: PRIOR, sourceType: 'SO', amount: '80000.00' },
        { anchor, date: CURRENT, sourceType: 'SO', amount: '55000.00' },
      ],
    );

    await runChangeLogForBatch(db, REPORT_TYPE, CURRENT);

    const rows = await logRowsFor(anchor);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].changeType, CHANGE_TYPES.REVERTED_TO_ORIGINAL);
    assert.equal(rows[0].originalForeignAmount, '55000.00');
    assert.equal(rows[0].foreignDeltaVsOriginal, '0.00');
  });

  test('a different report_type is a separate batch and does not collide on the unique key', async () => {
    const anchor = `${ANCHOR_PREFIX}MULTIRPT`;
    await seed(
      [{ anchor, priorOpenSo: '100000.00', currentOpenSo: '120000.00' }],
      [
        { anchor, date: PRIOR, sourceType: 'SO', amount: '100000.00' },
        { anchor, date: CURRENT, sourceType: 'SO', amount: '120000.00' },
      ],
    );
    await db.insert(revenueComparison).values({
      ...comparisonSeed({ anchor, priorOpenSo: '100000.00', currentOpenSo: '120000.00' }),
      reportType: 'WOW',
    });

    await runChangeLogForBatch(db, 'DOD', CURRENT);
    await runChangeLogForBatch(db, 'WOW', CURRENT);

    const rows = await logRowsFor(anchor);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(r => r.reportType).sort(), ['DOD', 'WOW']);
  });
});
