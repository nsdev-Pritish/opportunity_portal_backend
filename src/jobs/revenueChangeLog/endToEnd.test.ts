// End-to-end: fact_revenue_snapshot -> runAllComparisons -> revenue_comparison
//                                   -> runChangeLogForBatch -> revenue_change_log
//
// Unlike revenueChangeLog.test.ts (which seeds revenue_comparison by hand to
// test the rule engine in isolation), this suite seeds only SNAPSHOT rows and
// then drives the REAL production entry point:
//
//   runAllComparisons(db, '1990-01-02')
//     -> planComparisons        (DOD only — 1990-01-02 is a Tuesday)
//     -> isSnapshotComplete x2  (reads revenue_sync_signal_log)
//     -> runComparison          -> revenue_comparison  (lifecycle_event etc.)
//     -> runChangeLogForBatch   -> revenue_change_log
//
// Nothing in that chain is stubbed, so this is what actually proves the Part 3
// wiring works — the rule engine passing its own unit tests does not.
//
// Every scenario below is one anchor, so a failure names the exact rule that
// broke rather than "the batch was wrong".
//
// NOT destructive: unlike revenueComparison/endToEnd.test.ts (which derives
// its run date from the system clock and therefore has to write TODAY's rows),
// this suite only ever writes 1990 snapshot dates and TEST-E2E-CL- anchors, so
// it needs TEST_DATABASE_URL alone and cannot disturb real reporting data.
//
//   TEST_DATABASE_URL=postgres://... npx tsx --test src/jobs/revenueChangeLog/endToEnd.test.ts

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq, like, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../db/schema/index.js';
import {
  factRevenueSnapshot, revenueComparison, revenueChangeLog, revenueSyncSignalLog,
} from '../../db/schema/index.js';
import { runAllComparisons } from '../revenueComparison/index.js';
import { CHANGE_TYPES } from './revenueChangeLog.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// Snapshot dates are unique to THIS suite. runAllComparisons compares WHOLE
// dates, so a suite sharing a snapshot date with this one would have its
// anchors swept into this comparison (and vice versa), leaving change-log rows
// that neither suite's prefix-scoped cleanup removes. Each suite owns its own
// year: 1990 = comparisonBuilder.test.ts, 1992 = revenueChangeLog.test.ts,
// 1991 = here.
const BASELINE = '1990-02-01'; // earlier than PRIOR — establishes the Original Baseline only
const PRIOR = '1991-02-04';
const CURRENT = '1991-02-05'; // a Tuesday, and not the 1st, so planComparisons() yields DOD only
const PREFIX = 'TEST-E2E-CL-';

interface Seed {
  anchor: string;
  date: string;
  sourceType: 'PIPELINE' | 'SO' | 'INVOICE';
  amount: string;
  currency?: string;
  exchangeRate?: string;
  revenueDate?: string;
  likelyToClose?: string;
}

function snap(s: Seed): typeof factRevenueSnapshot.$inferInsert {
  const rate = s.exchangeRate ?? '1';
  const revenueDate = s.revenueDate ?? '1990-03-15';
  return {
    snapshotDate: s.date,
    snapshotTs: new Date(`${s.date}T00:00:00.000Z`),
    sourceType: s.sourceType,
    internalId: `${s.anchor}-${s.sourceType}-${s.date}`,
    anchorId: s.anchor,
    documentNumber: `${s.anchor}-DOC`,
    consolidatedCustomer: 'E2E Change Log Customer',
    subsidiary: 'E2E Subsidiary',
    currency: s.currency ?? 'USD',
    likelyToClose: s.likelyToClose ?? '4',
    revenueDate,
    revenuePeriod: `${revenueDate.slice(0, 7)}-01`,
    foreignAmount: s.amount,
    exchangeRate: rate,
    usdAmount: (Number(s.amount) * Number(rate)).toFixed(2),
  };
}

const A = {
  conv: `${PREFIX}CONV`,
  partial: `${PREFIX}PARTIAL`,
  full: `${PREFIX}FULL`,
  fxOnly: `${PREFIX}FXONLY`,
  bizFx: `${PREFIX}BIZFX`,
  ccy: `${PREFIX}CCY`,
  shift: `${PREFIX}SHIFT`,
  both: `${PREFIX}BOTH`,
  same: `${PREFIX}SAME`,
  deleted: `${PREFIX}DEL`,
  revert: `${PREFIX}REVERT`,
};

/** One entry per business scenario the change log is supposed to detect. */
const SEEDS: Seed[] = [
  // 1. Pipeline converted to Sales Order — pipeline vanishes, SO appears.
  { anchor: A.conv, date: PRIOR, sourceType: 'PIPELINE', amount: '100000.00' },
  { anchor: A.conv, date: CURRENT, sourceType: 'SO', amount: '100000.00' },

  // 2. SO partially invoiced — SO drops, invoice appears, SO still open.
  { anchor: A.partial, date: PRIOR, sourceType: 'SO', amount: '1200000.00' },
  { anchor: A.partial, date: CURRENT, sourceType: 'SO', amount: '800000.00' },
  { anchor: A.partial, date: CURRENT, sourceType: 'INVOICE', amount: '400000.00' },

  // 3. SO fully invoiced — SO gone entirely, invoice carries the full value.
  { anchor: A.full, date: PRIOR, sourceType: 'SO', amount: '500000.00' },
  { anchor: A.full, date: CURRENT, sourceType: 'INVOICE', amount: '500000.00' },

  // 4. FX only — same foreign amount, rate moved.
  { anchor: A.fxOnly, date: PRIOR, sourceType: 'SO', amount: '100000.00', currency: 'EUR', exchangeRate: '1.08000000' },
  { anchor: A.fxOnly, date: CURRENT, sourceType: 'SO', amount: '100000.00', currency: 'EUR', exchangeRate: '1.12000000' },

  // 5. Business + FX — both moved.
  { anchor: A.bizFx, date: PRIOR, sourceType: 'SO', amount: '100000.00', currency: 'EUR', exchangeRate: '1.08000000' },
  { anchor: A.bizFx, date: CURRENT, sourceType: 'SO', amount: '120000.00', currency: 'EUR', exchangeRate: '1.12000000' },

  // 6. Currency change — with the amount ALSO moving, to prove rule 2 wins.
  { anchor: A.ccy, date: PRIOR, sourceType: 'SO', amount: '100000.00', currency: 'EUR', exchangeRate: '1.08000000' },
  { anchor: A.ccy, date: CURRENT, sourceType: 'SO', amount: '120000.00', currency: 'USD', exchangeRate: '1.00000000' },

  // 7. Period shift only — identical amount, revenue date moves Mar -> May.
  { anchor: A.shift, date: PRIOR, sourceType: 'SO', amount: '100000.00', revenueDate: '1990-03-15' },
  { anchor: A.shift, date: CURRENT, sourceType: 'SO', amount: '100000.00', revenueDate: '1990-05-20' },

  // 8. Amount AND period — must produce TWO rows.
  { anchor: A.both, date: PRIOR, sourceType: 'SO', amount: '100000.00', revenueDate: '1990-03-15' },
  { anchor: A.both, date: CURRENT, sourceType: 'SO', amount: '120000.00', revenueDate: '1990-05-20' },

  // 9. Nothing changed — must produce ZERO rows.
  { anchor: A.same, date: PRIOR, sourceType: 'SO', amount: '100000.00' },
  { anchor: A.same, date: CURRENT, sourceType: 'SO', amount: '100000.00' },

  // 10. Deleted — present on the prior date, absent from the current one.
  { anchor: A.deleted, date: PRIOR, sourceType: 'SO', amount: '250000.00' },

  // 11. Reverted to Original — baseline 55000, drifted to 80000, back to 55000.
  { anchor: A.revert, date: BASELINE, sourceType: 'SO', amount: '55000.00' },
  { anchor: A.revert, date: PRIOR, sourceType: 'SO', amount: '80000.00' },
  { anchor: A.revert, date: CURRENT, sourceType: 'SO', amount: '55000.00' },
];

describe('revenue change log — end to end through runAllComparisons', {
  skip: TEST_DATABASE_URL ? false : 'set TEST_DATABASE_URL to run integration tests',
}, () => {
  const client = postgres(TEST_DATABASE_URL ?? '', { max: 1, prepare: false });
  const db = drizzle(client, { schema });

  /** Change-log rows for one anchor, in the order they were written. */
  let logByAnchor = new Map<string, (typeof revenueChangeLog.$inferSelect)[]>();

  async function cleanup() {
    await db.delete(revenueChangeLog).where(like(revenueChangeLog.anchorId, `${PREFIX}%`));
    await db.delete(revenueComparison).where(like(revenueComparison.anchorId, `${PREFIX}%`));
    await db.delete(factRevenueSnapshot).where(like(factRevenueSnapshot.anchorId, `${PREFIX}%`));
    await db.delete(revenueSyncSignalLog).where(inArray(revenueSyncSignalLog.runDate, [PRIOR, CURRENT]));
  }

  before(async () => {
    await cleanup();

    await db.insert(factRevenueSnapshot).values(SEEDS.map(snap));

    // runAllComparisons refuses to compare a date whose snapshot is not
    // marked complete — this is the real gate, so it is satisfied for real
    // rather than stubbed out.
    await db.insert(revenueSyncSignalLog).values([
      { runDate: PRIOR, sourceType: 'ALL', status: 'complete' },
      { runDate: CURRENT, sourceType: 'ALL', status: 'complete' },
    ]);

    // ── The actual production call, wiring included. ──
    const outcomes = await runAllComparisons(db, CURRENT);
    const dod = outcomes.find(o => o.reportType === 'DOD');
    assert.equal(dod?.status, 'ok', `DOD comparison did not succeed: ${JSON.stringify(dod)}`);

    const rows = await db.select().from(revenueChangeLog).where(and(
      like(revenueChangeLog.anchorId, `${PREFIX}%`),
      eq(revenueChangeLog.toSnapshotDate, CURRENT),
    )).orderBy(revenueChangeLog.changeEventId);

    logByAnchor = new Map();
    for (const r of rows) {
      if (!logByAnchor.has(r.anchorId)) logByAnchor.set(r.anchorId, []);
      logByAnchor.get(r.anchorId)!.push(r);
    }
  });

  after(async () => {
    await cleanup();
    await client.end();
  });

  const rowsFor = (anchor: string) => logByAnchor.get(anchor) ?? [];
  const oneRowFor = (anchor: string) => {
    const rows = rowsFor(anchor);
    assert.equal(rows.length, 1, `expected exactly 1 change-log row for ${anchor}, got ${rows.length}: ${rows.map(r => r.changeType).join(' | ')}`);
    return rows[0];
  };

  test('the wiring fired at all — runAllComparisons produced change-log rows', () => {
    assert.ok(logByAnchor.size > 0, 'no change-log rows were written; the runChangeLogForBatch call in runAllComparisons did not run');
  });

  test('report_type and both snapshot dates are carried onto every row', () => {
    for (const rows of logByAnchor.values()) {
      for (const r of rows) {
        assert.equal(r.reportType, 'DOD');
        assert.equal(r.fromSnapshotDate, PRIOR);
        assert.equal(r.toSnapshotDate, CURRENT);
        assert.ok(r.changeGroupId, 'change_group_id must be set');
        assert.ok(r.changeDescription && r.changeDescription.length > 20, `change_description too thin: ${r.changeDescription}`);
      }
    }
  });

  test('all rows in one batch share a single change_group_id', () => {
    const ids = new Set([...logByAnchor.values()].flat().map(r => r.changeGroupId));
    assert.equal(ids.size, 1, `expected one batch group id, got ${ids.size}`);
  });

  // ── Scenario 1 ──────────────────────────────────────────────────────────
  test('1. Pipeline converted to Sales Order', () => {
    const r = oneRowFor(A.conv);
    assert.equal(r.changeType, 'Pipeline converted to Sales Order');
    assert.equal(r.changeDriver, 'LIFECYCLE');
    assert.equal(
      r.changeDescription,
      `${A.conv}-DOC converted from pipeline to sales order — $100,000 of pipeline became $100,000 of open sales-order value as of ${CURRENT}.`,
    );
  });

  // ── Scenario 2 ──────────────────────────────────────────────────────────
  test('2. SO partially invoiced, with the split spelled out', () => {
    const r = oneRowFor(A.partial);
    assert.equal(r.changeType, 'SO partially invoiced');
    assert.equal(r.changeDriver, 'LIFECYCLE');
    assert.equal(
      r.changeDescription,
      `${A.partial}-DOC partially invoiced — $400,000 of $1,200,000 invoiced, $800,000 remains open.`,
    );
  });

  // ── Scenario 3 ──────────────────────────────────────────────────────────
  test('3. SO fully invoiced', () => {
    const r = oneRowFor(A.full);
    assert.equal(r.changeType, 'SO fully invoiced');
    assert.equal(r.changeDriver, 'LIFECYCLE');
    assert.match(String(r.changeDescription), /fully invoiced — \$500,000 invoiced in full/);
  });

  // ── Scenario 4 ──────────────────────────────────────────────────────────
  test('4. FX Only Change, with the flag set and the foreign amount flat', () => {
    const r = oneRowFor(A.fxOnly);
    assert.equal(r.changeType, CHANGE_TYPES.FX_ONLY);
    assert.equal(r.changeDriver, 'FX_ONLY');
    assert.equal(r.fxOnlyChangeFlag, true);
    assert.equal(r.foreignDeltaVsPrior, '0.00');
    assert.equal(r.priorExchangeRate, '1.08000000');
    assert.equal(r.currentExchangeRate, '1.12000000');
    assert.equal(r.reportedUsdDeltaVsPrior, '4000.00');
    assert.equal(
      r.changeDescription,
      'FX-only movement — foreign amount unchanged at €100,000, but USD value shifted from $108,000 to $112,000 due to exchange rate change (1.08 → 1.12).',
    );
  });

  // ── Scenario 5 ──────────────────────────────────────────────────────────
  test('5. Business + FX Change', () => {
    const r = oneRowFor(A.bizFx);
    assert.equal(r.changeType, CHANGE_TYPES.BUSINESS_AND_FX);
    assert.equal(r.changeDriver, 'BUSINESS_AND_FX');
    assert.equal(r.fxOnlyChangeFlag, false);
    assert.equal(r.foreignDeltaVsPrior, '20000.00');
    assert.match(String(r.changeDescription), /exchange rate moved \(1\.08 → 1\.12\)/);
  });

  // ── Scenario 6 ──────────────────────────────────────────────────────────
  test('6. Currency Change beats the amount rules, even though the amount also moved', () => {
    const r = oneRowFor(A.ccy);
    assert.equal(r.changeType, CHANGE_TYPES.CURRENCY_CHANGE);
    assert.equal(r.changeDriver, 'DATA_QUALITY');
    assert.equal(r.controlSeverity, 'WARNING');
    assert.equal(r.foreignDeltaVsPrior, null, 'a delta across two currencies must not be computed');
    assert.match(String(r.changeDescription), /changed currency from EUR to USD/);
  });

  // ── Scenario 7 ──────────────────────────────────────────────────────────
  test('7. a period-only move produces a single Revenue Shift row', () => {
    const r = oneRowFor(A.shift);
    assert.equal(r.changeType, CHANGE_TYPES.REVENUE_SHIFT);
    assert.equal(r.changeDriver, 'PERIOD');
    assert.equal(r.priorRevenuePeriod, '1990-03-01');
    assert.equal(r.currentRevenuePeriod, '1990-05-01');
    assert.equal(r.monthsShiftedVsPrior, 2);
  });

  // ── Scenario 8 ──────────────────────────────────────────────────────────
  test('8. amount AND period produce TWO rows (rule 7 appends, never overwrites)', () => {
    const rows = rowsFor(A.both);
    assert.equal(rows.length, 2, `expected 2 rows, got ${rows.map(r => r.changeType).join(' | ')}`);
    assert.deepEqual(
      rows.map(r => r.changeType).sort(),
      [CHANGE_TYPES.REVENUE_INCREASE, CHANGE_TYPES.REVENUE_SHIFT].sort(),
    );
    const increase = rows.find(r => r.changeType === CHANGE_TYPES.REVENUE_INCREASE)!;
    assert.equal(increase.changeDriver, 'BUSINESS');
    assert.equal(increase.foreignDeltaVsPrior, '20000.00');
    assert.equal(
      increase.changeDescription,
      'Revenue increased from $100,000 to $120,000 (+$20,000), no FX impact.',
    );
    assert.equal(rows.find(r => r.changeType === CHANGE_TYPES.REVENUE_SHIFT)!.changeDriver, 'PERIOD');
  });

  // ── Scenario 9 ──────────────────────────────────────────────────────────
  test('9. an unchanged anchor produces ZERO rows — no "no change" row ever reaches the table', () => {
    assert.deepEqual(rowsFor(A.same), []);
  });

  // ── Scenario 10 ─────────────────────────────────────────────────────────
  test('10. an anchor that disappeared is logged as Deleted', () => {
    const r = oneRowFor(A.deleted);
    assert.equal(r.changeType, 'Deleted');
    assert.equal(r.changeDriver, 'LIFECYCLE');
    assert.equal(r.controlSeverity, 'WARNING');
    assert.match(
      String(r.changeDescription),
      new RegExp(`^Anchor ${A.deleted} no longer appears in the current snapshot as of ${CURRENT} — record deleted\\.`),
    );
  });

  // ── Scenario 11 ─────────────────────────────────────────────────────────
  test('11. Reverted to Original, resolved against the real 1989 baseline snapshot', () => {
    const r = oneRowFor(A.revert);
    assert.equal(r.changeType, CHANGE_TYPES.REVERTED_TO_ORIGINAL);
    assert.equal(r.changeDriver, 'BUSINESS');
    assert.equal(r.originalForeignAmount, '55000.00');
    assert.equal(r.foreignDeltaVsOriginal, '0.00');
    assert.equal(r.foreignDeltaVsPrior, '-25000.00');
  });

  // ── Re-run safety through the real entry point ──────────────────────────
  test('re-running runAllComparisons writes no duplicate change-log rows', async () => {
    const before = await db.select({ id: revenueChangeLog.changeEventId }).from(revenueChangeLog)
      .where(like(revenueChangeLog.anchorId, `${PREFIX}%`));

    const outcomes = await runAllComparisons(db, CURRENT);
    assert.equal(outcomes.find(o => o.reportType === 'DOD')?.status, 'ok');

    const after = await db.select({ id: revenueChangeLog.changeEventId }).from(revenueChangeLog)
      .where(like(revenueChangeLog.anchorId, `${PREFIX}%`));

    assert.equal(after.length, before.length, 'a second full run must not add rows');
    assert.deepEqual(
      after.map(r => r.id).sort(),
      before.map(r => r.id).sort(),
      'the original rows must survive untouched, not be replaced',
    );
  });

  test('a lifecycle anchor never also gets an amount or period row', () => {
    for (const anchor of [A.conv, A.partial, A.full, A.deleted]) {
      const rows = rowsFor(anchor);
      assert.equal(rows.length, 1, `${anchor} produced ${rows.length} rows`);
      assert.equal(rows[0].changeDriver, 'LIFECYCLE');
    }
  });
});
