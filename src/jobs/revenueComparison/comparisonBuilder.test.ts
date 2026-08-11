// Integration tests for runComparison — these need a real PostgreSQL database,
// because the entire comparison IS the SQL/aggregation over real rows. There
// is nothing meaningful left to assert once you mock the database away.
//
// Guarded on TEST_DATABASE_URL rather than falling back to DATABASE_URL: this
// suite writes to fact_revenue_snapshot and revenue_comparison, and silently
// picking up a .env pointing at a shared or production database would seed
// junk rows into real reporting tables. Without TEST_DATABASE_URL the whole
// suite is skipped with a message instead.
//
//   TEST_DATABASE_URL=postgres://... npm test
//
// Every row written here uses an anchor_id under the TEST-RC- prefix and two
// snapshot dates in 1990, so it can be identified and removed precisely, and
// cannot collide with real snapshot data.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq, like, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../db/schema/index.js';
import { factRevenueSnapshot, revenueComparison } from '../../db/schema/index.js';
import { runComparison } from './comparisonBuilder.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const PRIOR = '1990-01-01';
const CURRENT = '1990-01-02';
const UNRELATED = '1990-01-03'; // a third date neither side of the comparison looks at
const ANCHOR_PREFIX = 'TEST-RC-';

type SnapshotSeed = {
  anchor: string;
  date: string;
  sourceType: 'PIPELINE' | 'SO' | 'INVOICE' | 'BUDGET';
  amount: string;
  revenueDate?: string;
  exchangeRate?: string;
};

/** Fills in the columns every snapshot row needs but no assertion here cares about. */
function seedRow(s: SnapshotSeed): typeof factRevenueSnapshot.$inferInsert {
  return {
    snapshotDate: s.date,
    snapshotTs: new Date(`${s.date}T00:00:00.000Z`),
    sourceType: s.sourceType,
    internalId: `${s.anchor}-${s.sourceType}-${s.date}`,
    anchorId: s.anchor,
    documentNumber: `${s.anchor}-DOC`,
    consolidatedCustomer: 'Test Customer',
    projectName: 'Test Project',
    salesRep: 'Test Rep',
    department: 'Test Dept',
    subsidiary: 'Test Subsidiary',
    currency: 'USD',
    revenueDate: s.revenueDate ?? '1990-03-01',
    revenuePeriod: (s.revenueDate ?? '1990-03-01').slice(0, 7) + '-01',
    foreignAmount: s.amount,
    exchangeRate: s.exchangeRate ?? '1',
  };
}

describe('runComparison', { skip: TEST_DATABASE_URL ? false : 'set TEST_DATABASE_URL to run integration tests' }, () => {
  const client = postgres(TEST_DATABASE_URL ?? '', { max: 1, prepare: false });
  const db = drizzle(client, { schema });

  /** The single comparison row for a test anchor, or undefined if none was produced. */
  async function rowFor(anchor: string) {
    const rows = await db.select().from(revenueComparison).where(and(
      eq(revenueComparison.reportType, 'DOD'),
      eq(revenueComparison.anchorId, anchor),
      eq(revenueComparison.priorSnapshotPeriod, PRIOR),
      eq(revenueComparison.currentSnapshotPeriod, CURRENT),
    ));
    assert.ok(rows.length <= 1, `expected at most one row for ${anchor}, found ${rows.length}`);
    return rows[0];
  }

  /** numeric(18,2) comes back from the driver as a string — compare as numbers. */
  const num = (v: string | null) => (v === null ? null : Number(v));

  async function cleanup() {
    await db.delete(revenueComparison).where(like(revenueComparison.anchorId, `${ANCHOR_PREFIX}%`));
    // Deleted by snapshot_date, not by anchor prefix: the BUDGET fixtures below
    // deliberately carry anchor_id = NULL, which no LIKE can match. The three
    // 1990 dates belong to this suite alone.
    await db.delete(factRevenueSnapshot)
      .where(inArray(factRevenueSnapshot.snapshotDate, [PRIOR, CURRENT, UNRELATED]));
  }

  before(async () => {
    await cleanup();

    await db.insert(factRevenueSnapshot).values([
      // Pipeline -> Sales Order conversion. The pipeline leg empties, an SO of
      // the same size appears, and the SO's revenue date slips a month later.
      seedRow({ anchor: 'TEST-RC-CONV', date: PRIOR, sourceType: 'PIPELINE', amount: '100000.00', revenueDate: '1990-03-01' }),
      seedRow({ anchor: 'TEST-RC-CONV', date: CURRENT, sourceType: 'SO', amount: '100000.00', revenueDate: '1990-04-01' }),

      // Partial invoice: 40k of a 100k SO invoiced, 60k still open.
      seedRow({ anchor: 'TEST-RC-PARTIAL', date: PRIOR, sourceType: 'SO', amount: '100000.00' }),
      seedRow({ anchor: 'TEST-RC-PARTIAL', date: CURRENT, sourceType: 'SO', amount: '60000.00' }),
      seedRow({ anchor: 'TEST-RC-PARTIAL', date: CURRENT, sourceType: 'INVOICE', amount: '40000.00' }),

      // Full invoice: the SO is gone entirely, replaced by an invoice.
      seedRow({ anchor: 'TEST-RC-FULL', date: PRIOR, sourceType: 'SO', amount: '100000.00' }),
      seedRow({ anchor: 'TEST-RC-FULL', date: CURRENT, sourceType: 'INVOICE', amount: '100000.00' }),

      // Present in the prior snapshot, absent from the current one.
      seedRow({ anchor: 'TEST-RC-DELETED', date: PRIOR, sourceType: 'PIPELINE', amount: '50000.00' }),

      // Identical on both dates.
      seedRow({ anchor: 'TEST-RC-SAME', date: PRIOR, sourceType: 'PIPELINE', amount: '25000.00' }),
      seedRow({ anchor: 'TEST-RC-SAME', date: CURRENT, sourceType: 'PIPELINE', amount: '25000.00' }),

      // Brand new — nothing on the prior date at all.
      seedRow({ anchor: 'TEST-RC-NEW', date: CURRENT, sourceType: 'PIPELINE', amount: '15000.00' }),

      // Multiple active SOs sharing one anchor (split shipments) — must SUM, not pick one.
      seedRow({ anchor: 'TEST-RC-MULTI', date: PRIOR, sourceType: 'SO', amount: '30000.00' }),
      seedRow({ anchor: 'TEST-RC-MULTI', date: CURRENT, sourceType: 'SO', amount: '20000.00' }),

      // Exists in fact_revenue_snapshot, but on neither compared date.
      seedRow({ anchor: 'TEST-RC-ABSENT-BOTH', date: UNRELATED, sourceType: 'PIPELINE', amount: '77000.00' }),

      // Budget rows carry no anchor_id in this pipeline and must never appear.
      { ...seedRow({ anchor: 'TEST-RC-BUDGET', date: PRIOR, sourceType: 'BUDGET', amount: '90000.00' }), anchorId: null },
      { ...seedRow({ anchor: 'TEST-RC-BUDGET', date: CURRENT, sourceType: 'BUDGET', amount: '95000.00' }), anchorId: null },
    ]);

    // A second SO row for TEST-RC-MULTI, same anchor + stage, on both dates —
    // written separately so seedRow's internalId (which includes the date)
    // doesn't collide, proving multiple rows per (anchor, stage) really sum.
    await db.insert(factRevenueSnapshot).values([
      { ...seedRow({ anchor: 'TEST-RC-MULTI', date: PRIOR, sourceType: 'SO', amount: '70000.00' }), internalId: 'TEST-RC-MULTI-SO-2-PRIOR' },
      { ...seedRow({ anchor: 'TEST-RC-MULTI', date: CURRENT, sourceType: 'SO', amount: '55000.00' }), internalId: 'TEST-RC-MULTI-SO-2-CURRENT' },
    ]);

    await runComparison(db, 'DOD', PRIOR, CURRENT);
  });

  after(async () => {
    await cleanup();
    await client.end();
  });

  test('Pipeline -> Sales Order conversion', async () => {
    const row = await rowFor('TEST-RC-CONV');
    assert.ok(row, 'expected a comparison row');

    assert.equal(num(row.priorPipelineAmt), 100000);
    assert.equal(num(row.currentPipelineAmt), 0);
    assert.equal(num(row.pipelineAmountChange), -100000);

    assert.equal(num(row.priorOpenSoAmt), 0);
    assert.equal(num(row.currentOpenSoAmt), 100000);
    assert.equal(num(row.openSoAmountChange), 100000);

    assert.equal(num(row.totalPriorAmount), 100000);
    assert.equal(num(row.totalCurrentAmount), 100000);
    assert.equal(num(row.totalAmountChange), 0);

    assert.equal(row.soRevenueDateChange, '+1 month');
    assert.equal(row.lifecycleEvent, 'PIPELINE_CONVERTED_TO_SO');
  });

  test('SO partially invoiced', async () => {
    const row = await rowFor('TEST-RC-PARTIAL');
    assert.ok(row, 'expected a comparison row');

    assert.equal(num(row.priorOpenSoAmt), 100000);
    assert.equal(num(row.currentOpenSoAmt), 60000);
    assert.equal(num(row.openSoAmountChange), -40000);

    assert.equal(num(row.priorInvoiceAmt), 0);
    assert.equal(num(row.currentInvoiceAmt), 40000);
    assert.equal(num(row.invoiceAmountChange), 40000);

    // The SO and invoice legs offset exactly, so nothing moved overall.
    assert.equal(num(row.totalAmountChange), 0);
    assert.equal(row.lifecycleEvent, 'SO_PARTIALLY_INVOICED');
    assert.equal(row.checkFlag, true);
  });

  test('SO fully invoiced', async () => {
    const row = await rowFor('TEST-RC-FULL');
    assert.ok(row, 'expected a comparison row');

    assert.equal(num(row.priorOpenSoAmt), 100000);
    assert.equal(num(row.currentOpenSoAmt), 0);
    assert.equal(num(row.currentInvoiceAmt), 100000);
    assert.equal(num(row.totalAmountChange), 0);

    // Must win over 'SO_PARTIALLY_INVOICED', which its amounts also satisfy —
    // the priority order in the lifecycle ladder is what decides this.
    assert.equal(row.lifecycleEvent, 'SO_FULLY_INVOICED');
    assert.equal(row.checkFlag, true);
  });

  test('anchor deleted between the two snapshots', async () => {
    const row = await rowFor('TEST-RC-DELETED');
    assert.ok(row, 'expected a comparison row');

    assert.equal(num(row.priorPipelineAmt), 50000);
    assert.equal(num(row.currentPipelineAmt), 0);
    assert.equal(num(row.currentOpenSoAmt), 0);
    assert.equal(num(row.currentInvoiceAmt), 0);

    assert.equal(num(row.totalPriorAmount), 50000);
    assert.equal(num(row.totalCurrentAmount), 0);
    assert.equal(num(row.totalAmountChange), -50000);

    assert.equal(row.lifecycleEvent, 'PIPELINE_DELETED');
  });

  test('identical on both dates', async () => {
    const row = await rowFor('TEST-RC-SAME');
    assert.ok(row, 'expected a comparison row');

    assert.equal(num(row.totalAmountChange), 0);
    // NOT 'NO_CHANGE' — that code is reserved for an anchor with zero amount
    // on every stage both periods; a nonzero, unchanged Pipeline balance is
    // its own branch (pipelineChange === 0 falls out of the "currentPipelineAmt
    // > 0" ladder rung, same as any other nonzero-but-flat single-stage anchor).
    assert.equal(row.lifecycleEvent, 'PIPELINE_OPEN_NO_CHANGE');
    assert.equal(row.checkFlag, true);
  });

  test('brand new anchor on the current date', async () => {
    const row = await rowFor('TEST-RC-NEW');
    assert.ok(row, 'expected a comparison row');

    assert.equal(num(row.priorPipelineAmt), 0);
    assert.equal(num(row.currentPipelineAmt), 15000);
    assert.equal(num(row.totalAmountChange), 15000);
    assert.equal(row.lifecycleEvent, 'ADDED_TO_PIPELINE');
  });

  test('multiple active SO rows on one anchor are summed, not collapsed to one', async () => {
    const row = await rowFor('TEST-RC-MULTI');
    assert.ok(row, 'expected a comparison row');

    assert.equal(num(row.priorOpenSoAmt), 100000, '30000 + 70000');
    assert.equal(num(row.currentOpenSoAmt), 75000, '20000 + 55000');
    assert.equal(num(row.openSoAmountChange), -25000);
  });

  test('an anchor absent from both dates produces no row', async () => {
    assert.equal(await rowFor('TEST-RC-ABSENT-BOTH'), undefined);
  });

  test('budget rows are excluded (no anchor_id)', async () => {
    const rows = await db.select({ id: revenueComparison.id })
      .from(revenueComparison)
      .where(like(revenueComparison.anchorId, `${ANCHOR_PREFIX}BUDGET%`));
    assert.equal(rows.length, 0);
  });

  test('re-running the same comparison does not grow the row count', async () => {
    const before = await db.select({ id: revenueComparison.id })
      .from(revenueComparison)
      .where(and(
        eq(revenueComparison.reportType, 'DOD'),
        eq(revenueComparison.priorSnapshotPeriod, PRIOR),
        eq(revenueComparison.currentSnapshotPeriod, CURRENT),
        like(revenueComparison.anchorId, `${ANCHOR_PREFIX}%`),
      ));

    await runComparison(db, 'DOD', PRIOR, CURRENT);
    await runComparison(db, 'DOD', PRIOR, CURRENT);

    const after = await db.select({ id: revenueComparison.id })
      .from(revenueComparison)
      .where(and(
        eq(revenueComparison.reportType, 'DOD'),
        eq(revenueComparison.priorSnapshotPeriod, PRIOR),
        eq(revenueComparison.currentSnapshotPeriod, CURRENT),
        like(revenueComparison.anchorId, `${ANCHOR_PREFIX}%`),
      ));

    assert.equal(after.length, before.length, 'row count must not grow on re-run');

    // The lifecycle labels survive a re-run unchanged (values are recomputed
    // fresh each time from the same source rows, so they're stable).
    assert.equal((await rowFor('TEST-RC-FULL'))?.lifecycleEvent, 'SO_FULLY_INVOICED');
    assert.equal((await rowFor('TEST-RC-DELETED'))?.lifecycleEvent, 'PIPELINE_DELETED');
  });

  test('no prior snapshot at all inserts zero rows without throwing', async () => {
    // 1990-01-10 / 1990-01-11 hold no rows whatsoever — the first-run-ever case.
    const result = await runComparison(db, 'DOD', '1990-01-10', '1990-01-11');
    assert.equal(result.inserted, 0);
    assert.equal(result.labelled, 0);
  });
});
