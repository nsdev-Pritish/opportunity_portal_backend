// End-to-end: NetSuite sync signals -> daily snapshot -> revenue_comparison.
//
// Unlike comparisonBuilder.test.ts (which seeds fact_revenue_snapshot by hand
// to test the comparison logic in isolation), this suite starts from the 4
// REAL source tables and drives the REAL production entry points:
//
//   handleSyncStart x4  ->  handleSyncEnd x4  ->  [1 minute timer]
//     -> buildRevenueSnapshotSequential (reads estimate_quote_search,
//        sales_order_search, invoice_search, budget_search)
//     -> markInsertComplete
//     -> runAllComparisons  -> revenue_comparison
//
// Nothing in that chain is stubbed. The only thing faked is the clock, so the
// job's 1-minute INSERT_DELAY_MS doesn't make the suite take a minute.
//
// ── DESTRUCTIVE — read before running ──────────────────────────────────────
// handleSyncEnd() derives its run date from the system clock, so this suite
// has no choice but to write TODAY's snapshot, TODAY's signal-log rows and
// TODAY's comparison rows. On a database that carries real data that would
// corrupt today's reporting. It therefore requires BOTH TEST_DATABASE_URL and
// E2E_ALLOW_DESTRUCTIVE=1, and should only ever be pointed at a throwaway
// database:
//
//   TEST_DATABASE_URL=postgres://...  E2E_ALLOW_DESTRUCTIVE=1  npm run test:e2e
//
// Source-table rows are prefixed E2E- and cleaned up; every assertion is
// scoped to those anchors, so unrelated rows in the database are ignored
// rather than deleted.

import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq, inArray, like, sql as raw } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../db/schema/index.js';
import {
  factRevenueSnapshot, revenueComparison, revenueSyncSignalLog,
  estimateQuoteSearch, salesOrderSearch, invoiceSearch, budgetSearch,
  departments, customers, accountManagers, projectNames, currencies,
  estimateStatuses, likelyToClose, forecastStatuses,
} from '../../db/schema/index.js';
import { handleSyncStart, handleSyncEnd, todayDateString } from '../revenueSnapshot/syncSignalHandler.js';
import { buildRevenueSnapshotSequential } from '../revenueSnapshot/snapshotBuilder.js';
import { INSERT_DELAY_MS, SOURCE_TYPES } from '../revenueSnapshot/config.js';
import { runAllComparisons, planComparisons, type ComparisonOutcome } from './index.js';
import { addDays } from './dateMath.js';

const ENABLED = Boolean(process.env.TEST_DATABASE_URL) && process.env.E2E_ALLOW_DESTRUCTIVE === '1';
const SKIP_REASON = 'set TEST_DATABASE_URL and E2E_ALLOW_DESTRUCTIVE=1 (throwaway database only)';

const TODAY = todayDateString();
const YESTERDAY = addDays(TODAY, -1);

describe('end-to-end: signals -> snapshot -> comparison', { skip: ENABLED ? false : SKIP_REASON }, () => {
  const client = postgres(process.env.TEST_DATABASE_URL ?? '', { max: 1, prepare: false });
  const db = drizzle(client, { schema });

  // Captured during `before`, asserted by the individual tests below.
  let signalResults: { source: string; scheduledInsert: boolean }[] = [];
  let outcomes: ComparisonOutcome[] = [];
  let ids: Record<string, number> = {};

  const num = (v: string | null) => (v === null ? null : Number(v));

  /**
   * mock.timers.enable() takes { apis: [...] } from Node 21.2 onward and a
   * bare array before that. The repo's Docker image is node:20-alpine, so
   * accept either rather than failing on whichever Node the developer has.
   */
  function enableTimerMock() {
    // Called as a method, never a detached reference — enable() reads private
    // state off `mock.timers` and throws on an unbound `this`.
    const timers = mock.timers as unknown as { enable: (arg: unknown) => void };
    try {
      timers.enable({ apis: ['setTimeout'] });
    } catch {
      timers.enable(['setTimeout']);
    }
  }

  async function dodRow(anchor: string) {
    const rows = await db.select().from(revenueComparison).where(and(
      eq(revenueComparison.reportType, 'DOD'),
      eq(revenueComparison.anchorId, anchor),
      eq(revenueComparison.priorSnapshotPeriod, YESTERDAY),
      eq(revenueComparison.currentSnapshotPeriod, TODAY),
    ));
    assert.ok(rows.length <= 1, `expected at most one DOD row for ${anchor}, found ${rows.length}`);
    return rows[0];
  }

  async function snapshotRows(date: string) {
    return db.select().from(factRevenueSnapshot).where(and(
      eq(factRevenueSnapshot.snapshotDate, date),
      like(factRevenueSnapshot.internalId, 'E2E-%'),
    ));
  }

  async function allSignalRow(runDate: string) {
    const rows = await db.select().from(revenueSyncSignalLog).where(and(
      eq(revenueSyncSignalLog.runDate, runDate),
      eq(revenueSyncSignalLog.sourceType, 'ALL'),
    ));
    return rows[0];
  }

  /** Polls until the day's insert job settles, using real timers. */
  async function waitForInsert(runDate: string, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const row = await allSignalRow(runDate);
      if (row && (row.status === 'complete' || row.status === 'failed')) return row;
      if (Date.now() > deadline) throw new Error(`insert for ${runDate} did not settle (status=${row?.status})`);
      await new Promise(r => setTimeout(r, 50));
    }
  }

  async function cleanup() {
    await db.delete(revenueComparison).where(inArray(revenueComparison.currentSnapshotPeriod, [YESTERDAY, TODAY]));
    await db.delete(factRevenueSnapshot).where(inArray(factRevenueSnapshot.snapshotDate, [YESTERDAY, TODAY]));
    await db.delete(revenueSyncSignalLog).where(inArray(revenueSyncSignalLog.runDate, [YESTERDAY, TODAY]));
    await db.delete(estimateQuoteSearch).where(like(estimateQuoteSearch.netsuiteInternalId, 'E2E-%'));
    await db.delete(salesOrderSearch).where(like(salesOrderSearch.netsuiteInternalId, 'E2E-%'));
    await db.delete(invoiceSearch).where(like(invoiceSearch.netsuiteInternalId, 'E2E-%'));
    await db.delete(budgetSearch).where(like(budgetSearch.netsuiteInternalId, 'E2E-%'));
  }

  before(async () => {
    await client`SELECT 1`; // warm the connection before the clock is faked
    await cleanup();

    // ── Master data, so the snapshot builder's id -> display-text resolution
    // is genuinely exercised rather than writing NULLs everywhere.
    const [dept] = await db.insert(departments).values({ name: 'E2E Department' }).returning({ id: departments.id });
    const [cust] = await db.insert(customers).values({ name: 'E2E Top Parent' }).returning({ id: customers.id });
    const [am] = await db.insert(accountManagers).values({ name: 'E2E Sales Rep' }).returning({ id: accountManagers.id });
    const [proj] = await db.insert(projectNames).values({ name: 'E2E Project' }).returning({ id: projectNames.id });
    const [curr] = await db.insert(currencies).values({ code: 'USD', name: 'US Dollar' }).returning({ id: currencies.id });
    const [stat] = await db.insert(estimateStatuses).values({ name: 'E2E Paid In Full', stage: 'Closed' }).returning({ id: estimateStatuses.id });
    const [ltc] = await db.insert(likelyToClose).values({ name: '4' }).returning({ id: likelyToClose.id });
    const [fcast] = await db.insert(forecastStatuses).values({ name: 'E2E Forecast' }).returning({ id: forecastStatuses.id });
    ids = { dept: dept.id, cust: cust.id, am: am.id, proj: proj.id, curr: curr.id, stat: stat.id, ltc: ltc.id, fcast: fcast.id };

    const common = {
      departmentId: ids.dept, topLevelParentId: ids.cust, salesRepId: ids.am,
      projectNameId: ids.proj, currencyId: ids.curr, likelyToCloseId: ids.ltc,
      consolidatedCustomer: 'E2E Customer', status: 'Open', exchangeRate: '1',
      tranDate: YESTERDAY, isActive: true,
    };

    // ── DAY 1 source state ────────────────────────────────────────────────
    await db.insert(estimateQuoteSearch).values([
      // amount will rise tomorrow
      { ...common, netsuiteInternalId: 'E2E-P-001', documentNumber: 'EST-E2E-001', foreignAmount: '100000', projectedTotal: '100000', promisedDeliveryDate: '2026-09-15' },
      // will be deactivated tomorrow (a real-world "delete")
      { ...common, netsuiteInternalId: 'E2E-P-002', documentNumber: 'EST-E2E-002', foreignAmount: '50000', projectedTotal: '50000', promisedDeliveryDate: '2026-09-15' },
      // untouched
      { ...common, netsuiteInternalId: 'E2E-P-004', documentNumber: 'EST-E2E-004', foreignAmount: '25000', projectedTotal: '25000', promisedDeliveryDate: '2026-09-15' },
      // becomes a Sales Order tomorrow
      { ...common, netsuiteInternalId: 'E2E-P-005', documentNumber: 'EST-E2E-005', foreignAmount: '80000', projectedTotal: '80000', promisedDeliveryDate: '2026-09-15' },
      // revenue period slips a month tomorrow
      { ...common, netsuiteInternalId: 'E2E-P-006', documentNumber: 'EST-E2E-006', foreignAmount: '60000', projectedTotal: '60000', promisedDeliveryDate: '2026-09-15' },
    ]);

    await db.insert(salesOrderSearch).values([
      // partially invoiced tomorrow — createdFrom links it back to EST-E2E-007
      { ...common, netsuiteInternalId: 'E2E-S-007', documentNumber: 'SO-E2E-007', createdFrom: 'EST-E2E-007', foreignAmount: '100000', projectedTotal: '100000', endDate: '2026-09-30' },
    ]);

    await db.insert(budgetSearch).values([
      // budget rows carry no anchor_id and must never reach revenue_comparison
      { netsuiteInternalId: 'E2E-B-001', name: 'E2E Budget', netRevenue: '900000', revenuePeriod: '2026-09-01', departmentId: ids.dept, parentId: ids.cust, forecastStatusId: ids.fcast, isActive: true },
    ]);

    // Day 1's snapshot, built by the real builder, then marked complete the
    // way a finished run leaves it — this is the "prior" side.
    await buildRevenueSnapshotSequential(db, YESTERDAY, new Date());
    await db.insert(revenueSyncSignalLog)
      .values({ runDate: YESTERDAY, sourceType: 'ALL', status: 'complete', completedAt: new Date() });

    // ── Overnight NetSuite changes -> DAY 2 source state ──────────────────
    // 001: amount increases 100k -> 120k
    await db.update(estimateQuoteSearch).set({ foreignAmount: '120000', projectedTotal: '120000' })
      .where(eq(estimateQuoteSearch.netsuiteInternalId, 'E2E-P-001'));
    // 002: deactivated — the builder only snapshots is_active rows, so it vanishes
    await db.update(estimateQuoteSearch).set({ isActive: false })
      .where(eq(estimateQuoteSearch.netsuiteInternalId, 'E2E-P-002'));
    // 003: brand new pipeline record appears
    await db.insert(estimateQuoteSearch).values({
      ...common, netsuiteInternalId: 'E2E-P-003', documentNumber: 'EST-E2E-003',
      foreignAmount: '15000', projectedTotal: '15000', promisedDeliveryDate: '2026-09-15', tranDate: TODAY,
    });
    // 005: pipeline closes and becomes a Sales Order (same originating estimate)
    await db.update(estimateQuoteSearch).set({ isActive: false })
      .where(eq(estimateQuoteSearch.netsuiteInternalId, 'E2E-P-005'));
    await db.insert(salesOrderSearch).values({
      ...common, netsuiteInternalId: 'E2E-S-005', documentNumber: 'SO-E2E-005',
      createdFrom: 'EST-E2E-005', foreignAmount: '80000', projectedTotal: '80000', endDate: '2026-09-30',
    });
    // 006: revenue period slips from September to October
    await db.update(estimateQuoteSearch).set({ promisedDeliveryDate: '2026-10-15' })
      .where(eq(estimateQuoteSearch.netsuiteInternalId, 'E2E-P-006'));
    // 007: 40k of the 100k SO gets invoiced, 60k left open — est_number links
    // the invoice directly back to the same anchor as SO-E2E-007
    await db.update(salesOrderSearch).set({ foreignAmount: '60000', projectedTotal: '60000' })
      .where(eq(salesOrderSearch.netsuiteInternalId, 'E2E-S-007'));
    await db.insert(invoiceSearch).values({
      netsuiteInternalId: 'E2E-I-007', documentNumber: 'INV-E2E-007', estNumber: 'EST-E2E-007',
      soDocumentNumber: 'SO-E2E-007', foreignAmount: '40000', projectedTotal: '40000',
      usdNetRevenue: '40000', tranDate: TODAY, statusId: ids.stat, departmentId: ids.dept,
      topLevelParentId: ids.cust, salesRepId: ids.am, projectNameId: ids.proj,
      currencyId: ids.curr, likelyToCloseId: ids.ltc, consolidatedCustomer: 'E2E Customer',
      exchangeRate: '1', isActive: true,
    });
    // budget amount moves too — still must not produce a comparison row
    await db.update(budgetSearch).set({ netRevenue: '950000' })
      .where(eq(budgetSearch.netsuiteInternalId, 'E2E-B-001'));

    // ── DAY 2 driven entirely through the real signal path ────────────────
    for (const source of SOURCE_TYPES) await handleSyncStart(db, source);

    enableTimerMock();
    try {
      for (const source of SOURCE_TYPES) {
        const res = await handleSyncEnd(db, source, 1);
        signalResults.push({ source, ...res });
      }
      // The 4th "sync end" armed the job's 1-minute delay; fire it.
      mock.timers.tick(INSERT_DELAY_MS);
    } finally {
      mock.timers.reset(); // real timers back for the async work the tick started
    }

    await waitForInsert(TODAY);

    // runAllComparisons already ran inside the job. Capture a second, no-op
    // invocation's outcomes to inspect cadence + re-run behaviour.
    outcomes = await runAllComparisons(db, TODAY);
  });

  after(async () => {
    await cleanup();
    await db.delete(departments).where(eq(departments.id, ids.dept));
    await db.delete(customers).where(eq(customers.id, ids.cust));
    await db.delete(accountManagers).where(eq(accountManagers.id, ids.am));
    await db.delete(projectNames).where(eq(projectNames.id, ids.proj));
    await db.delete(currencies).where(eq(currencies.id, ids.curr));
    await db.delete(estimateStatuses).where(eq(estimateStatuses.id, ids.stat));
    await db.delete(likelyToClose).where(eq(likelyToClose.id, ids.ltc));
    await db.delete(forecastStatuses).where(eq(forecastStatuses.id, ids.fcast));
    await client.end();
  });

  // ── The trigger chain ──────────────────────────────────────────────────

  test('only the 4th sync-end schedules the insert', () => {
    assert.equal(signalResults.length, 4);
    assert.deepEqual(signalResults.slice(0, 3).map(r => r.scheduledInsert), [false, false, false]);
    assert.equal(signalResults[3].scheduledInsert, true, 'the 4th source completes the set');
  });

  test("the day's job reached status complete", async () => {
    const row = await allSignalRow(TODAY);
    assert.equal(row?.status, 'complete');
    assert.ok(row?.completedAt, 'completed_at should be stamped');
  });

  test('the snapshot was built from the real source tables', async () => {
    const day1 = await snapshotRows(YESTERDAY);
    const day2 = await snapshotRows(TODAY);

    // Day 1: 5 pipeline + 1 SO + 1 budget. Day 2: 4 pipeline (002 and 005
    // deactivated, 003 added) + 2 SO + 1 invoice + 1 budget.
    assert.equal(day1.length, 7, 'day 1 snapshot row count');
    assert.equal(day2.length, 8, 'day 2 snapshot row count');

    // Master ids were resolved to display text, not left as ids or NULL.
    const p1 = day1.find(r => r.internalId === 'E2E-P-001');
    assert.equal(p1?.department, 'E2E Department');
    assert.equal(p1?.salesRep, 'E2E Sales Rep');
    assert.equal(p1?.projectName, 'E2E Project');
    assert.equal(p1?.currency, 'USD');
    assert.equal(p1?.topLevelParent, 'E2E Top Parent');
    assert.equal(p1?.revenuePeriod, '2026-09-01', 'revenue_period is the first of the revenue month');

    // The deactivated record is absent from day 2 — this is what a "delete"
    // looks like to the snapshot engine.
    assert.ok(day1.some(r => r.internalId === 'E2E-P-002'));
    assert.ok(!day2.some(r => r.internalId === 'E2E-P-002'));

    // anchor_id resolves through the linked Estimate, not the SO/Invoice's own number.
    const so005 = day2.find(r => r.internalId === 'E2E-S-005');
    assert.equal(so005?.anchorId, 'EST-E2E-005');
    const inv007 = day2.find(r => r.internalId === 'E2E-I-007');
    assert.equal(inv007?.anchorId, 'EST-E2E-007');
  });

  // ── Comparison results ─────────────────────────────────────────────────

  test('amount increase on an unchanged pipeline record', async () => {
    const row = await dodRow('EST-E2E-001');
    assert.ok(row, 'expected a DOD row');
    assert.equal(num(row.priorPipelineAmt), 100000);
    assert.equal(num(row.currentPipelineAmt), 120000);
    assert.equal(num(row.pipelineAmountChange), 20000);
    assert.equal(num(row.totalAmountChange), 0, 'total excludes Pipeline — only Open SO + Invoice count toward it');
    assert.equal(row.lifecycleEvent, 'PIPELINE_AMOUNT_INCREASED');
    assert.equal(row.checkFlag, true);
    // Reporting attributes carried through from the snapshot.
    assert.equal(row.customerName, 'E2E Customer');
    assert.equal(row.salesRep, 'E2E Sales Rep');
    assert.equal(row.department, 'E2E Department');
    assert.equal(row.currency, 'USD');
  });

  test('deactivated record produces a PIPELINE_DELETED row', async () => {
    const row = await dodRow('EST-E2E-002');
    assert.ok(row, 'expected a DOD row');
    assert.equal(num(row.priorPipelineAmt), 50000);
    assert.equal(num(row.currentPipelineAmt), 0);
    assert.equal(num(row.totalPriorAmount), 0, 'Pipeline never counted toward totals, even before deletion');
    assert.equal(num(row.totalCurrentAmount), 0);
    assert.equal(row.lifecycleEvent, 'PIPELINE_DELETED');
  });

  test('new pipeline record', async () => {
    const row = await dodRow('EST-E2E-003');
    assert.ok(row, 'expected a DOD row');
    assert.equal(num(row.priorPipelineAmt), 0);
    assert.equal(num(row.currentPipelineAmt), 15000);
    assert.equal(row.lifecycleEvent, 'ADDED_TO_PIPELINE');
  });

  test('untouched record', async () => {
    const row = await dodRow('EST-E2E-004');
    assert.ok(row, 'expected a DOD row');
    assert.equal(num(row.priorPipelineAmt), 25000);
    assert.equal(num(row.currentPipelineAmt), 25000);
    assert.equal(num(row.totalAmountChange), 0);
    assert.equal(row.pipelineRevenueDateChange, 'No Shift', 'current pipeline amount is nonzero, so the date comparison runs and finds no movement');
    assert.equal(row.lifecycleEvent, 'PIPELINE_OPEN_NO_CHANGE');
    assert.equal(row.checkFlag, true);
  });

  test('revenue period slipping a month is reported as a shift', async () => {
    const row = await dodRow('EST-E2E-006');
    assert.ok(row, 'expected a DOD row');
    assert.equal(row.priorPipelineRevDate, '2026-09-01');
    assert.equal(row.currentPipelineRevDate, '2026-10-01');
    assert.equal(row.pipelineRevenueDateChange, '+1 month');
    assert.equal(num(row.totalAmountChange), 0, 'a pure date slip moves no money');
  });

  test('budget rows never reach revenue_comparison', async () => {
    // The budget snapshot row itself exists and did change...
    const snap = await db.select().from(factRevenueSnapshot).where(and(
      eq(factRevenueSnapshot.snapshotDate, TODAY),
      eq(factRevenueSnapshot.internalId, 'E2E-B-001'),
    ));
    assert.equal(snap.length, 1);
    assert.equal(snap[0].anchorId, null, 'budget carries no anchor_id');

    // ...but with anchor_id null, groupByAnchorAndStage's `!row.anchorId`
    // guard drops it before comparison ever runs — no row can exist for it.
    assert.equal(await dodRow('E2E Budget'), undefined);
    assert.equal(await dodRow('E2E-B-001'), undefined);
  });

  // ── The anchor_id fix: cross-stage lifecycle linking now works ─────────

  test('Pipeline -> SO conversion links into ONE row under the fixed anchor_id mapping', async () => {
    // The estimate and its sales order now share anchor EST-E2E-005 (via
    // sales_order_search.created_from), so this is a single conversion row
    // rather than two unrelated ones.
    const merged = await dodRow('EST-E2E-005');
    assert.ok(merged, 'expected one merged DOD row for EST-E2E-005');

    assert.equal(num(merged.priorPipelineAmt), 80000);
    assert.equal(num(merged.currentPipelineAmt), 0);
    assert.equal(num(merged.priorOpenSoAmt), 0);
    assert.equal(num(merged.currentOpenSoAmt), 80000);
    assert.equal(num(merged.totalPriorAmount), 0, 'Pipeline never counted; SO was 0 prior');
    assert.equal(num(merged.totalCurrentAmount), 80000);
    assert.equal(merged.lifecycleEvent, 'PIPELINE_CONVERTED_TO_SO');

    // There is no separate row under the SO's own document number.
    const bySoNumber = await dodRow('SO-E2E-005');
    assert.equal(bySoNumber, undefined, 'the SO does not get its own anchor — it shares EST-E2E-005');
  });

  test('partial invoicing links into ONE row under the fixed anchor_id mapping', async () => {
    // SO-E2E-007 and INV-E2E-007 both resolve to anchor EST-E2E-007 (via
    // created_from and est_number respectively).
    const merged = await dodRow('EST-E2E-007');
    assert.ok(merged, 'expected one merged DOD row for EST-E2E-007');

    assert.equal(num(merged.priorOpenSoAmt), 100000);
    assert.equal(num(merged.currentOpenSoAmt), 60000);
    assert.equal(num(merged.openSoAmountChange), -40000);
    assert.equal(num(merged.currentInvoiceAmt), 40000);
    assert.equal(num(merged.invoiceAmountChange), 40000);
    assert.equal(num(merged.totalAmountChange), 0, 'the SO decrease and invoice increase net to zero — execution, not lost revenue');
    assert.equal(merged.lifecycleEvent, 'SO_PARTIALLY_INVOICED');
    assert.equal(merged.checkFlag, true);

    // Neither the SO's own document number nor the invoice's own document
    // number produces a separate row — both threaded onto EST-E2E-007.
    assert.equal(await dodRow('SO-E2E-007'), undefined);
    assert.equal(await dodRow('INV-E2E-007'), undefined);
  });

  // ── Scheduling, gating and re-run safety ───────────────────────────────

  test('DOD ran; every other due report type was skipped for want of a prior snapshot', () => {
    const dod = outcomes.find(o => o.reportType === 'DOD');
    assert.ok(dod, 'DOD is always planned');
    assert.equal(dod.status, 'ok');

    // Whatever else today's date makes due (WOW on a Monday, MOM on the 1st,
    // QOQ on a quarter start), only YESTERDAY and TODAY have complete
    // snapshots, so the rest must be skipped rather than failing or silently
    // comparing against a missing date.
    assert.equal(outcomes.length, planComparisons(TODAY).length);
    for (const outcome of outcomes.filter(o => o.reportType !== 'DOD')) {
      assert.equal(outcome.status, 'skipped', `${outcome.reportType} should be skipped`);
      assert.match((outcome as { reason: string }).reason, /not complete in revenue_sync_signal_log/);
    }
  });

  test('the job ran comparisons itself — the second call inserted nothing new', async () => {
    // `outcomes` above came from a SECOND runAllComparisons call. The rows it
    // reports were already written by the job, so its own upsert only
    // re-affirms them (row count must not grow).
    const rows = await db.select({ n: raw<number>`count(*)::int` })
      .from(revenueComparison)
      .where(and(
        eq(revenueComparison.reportType, 'DOD'),
        eq(revenueComparison.currentSnapshotPeriod, TODAY),
      ));
    // 7 anchors: EST 001, 002 (deleted), 003 (new), 004, 005 (merged with its
    // SO), 006, 007 (merged with its SO and invoice). Budget never appears.
    assert.equal(rows[0].n, 7, 'one row per anchor, cross-stage anchors merged, no duplicates');

    // A third run must still not duplicate.
    await runAllComparisons(db, TODAY);
    const after = await db.select({ n: raw<number>`count(*)::int` })
      .from(revenueComparison)
      .where(and(
        eq(revenueComparison.reportType, 'DOD'),
        eq(revenueComparison.currentSnapshotPeriod, TODAY),
      ));
    assert.equal(after[0].n, 7, 'still 7 after a third run');
  });

  test('an incomplete prior snapshot blocks the comparison', async () => {
    // Flip yesterday to failed and re-run against a fresh report type.
    await db.update(revenueSyncSignalLog).set({ status: 'failed' })
      .where(and(eq(revenueSyncSignalLog.runDate, YESTERDAY), eq(revenueSyncSignalLog.sourceType, 'ALL')));

    const blocked = await runAllComparisons(db, TODAY);
    const dod = blocked.find(o => o.reportType === 'DOD');
    assert.equal(dod?.status, 'skipped');
    assert.match((dod as { reason: string }).reason, new RegExp(`prior snapshot ${YESTERDAY}`));

    await db.update(revenueSyncSignalLog).set({ status: 'complete' })
      .where(and(eq(revenueSyncSignalLog.runDate, YESTERDAY), eq(revenueSyncSignalLog.sourceType, 'ALL')));
  });
});
