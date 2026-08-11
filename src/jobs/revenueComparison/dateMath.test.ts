// Pure tests — no database, no clock. Run with: npm test
//
// Uses node:test (built into Node) rather than a new framework: the repo had
// no test runner and no test dependency of any kind before this, and node's
// runner needs neither. tsx, already a devDependency, handles the TypeScript.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, addMonths, daysInMonth, dayOfWeek, isMonday, isFirstOfMonth, isQuarterStart } from './dateMath.js';
import { planComparisons } from './index.js';

describe('addDays', () => {
  test('steps within a month', () => {
    assert.equal(addDays('2026-08-10', -1), '2026-08-09');
  });

  test('crosses a month boundary backwards', () => {
    assert.equal(addDays('2026-08-01', -1), '2026-07-31');
  });

  test('crosses a year boundary backwards', () => {
    assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  });

  test('a week back from a Monday is the previous Monday', () => {
    assert.equal(addDays('2026-08-10', -7), '2026-08-03');
    assert.equal(dayOfWeek('2026-08-03'), 1);
  });

  test('handles leap day', () => {
    assert.equal(addDays('2024-03-01', -1), '2024-02-29');
    assert.equal(addDays('2025-03-01', -1), '2025-02-28');
  });
});

describe('addMonths', () => {
  test('keeps the day of month when it exists in the target month', () => {
    assert.equal(addMonths('2026-08-10', -1), '2026-07-10');
    assert.equal(addMonths('2026-08-01', -3), '2026-05-01');
  });

  test('Jan 31 minus 1 month clamps to Dec 31, never rolling forward', () => {
    assert.equal(addMonths('2026-01-31', -1), '2025-12-31');
  });

  test('Mar 31 minus 1 month clamps to the last day of February', () => {
    assert.equal(addMonths('2026-03-31', -1), '2026-02-28');
    assert.equal(addMonths('2024-03-31', -1), '2024-02-29'); // leap year
  });

  test('Mar 31 minus 3 months clamps to Dec 31 of the prior year', () => {
    assert.equal(addMonths('2026-03-31', -3), '2025-12-31');
  });

  test('May 31 minus 1 month clamps into April, which has 30 days', () => {
    assert.equal(addMonths('2026-05-31', -1), '2026-04-30');
  });

  test('crosses a year boundary backwards', () => {
    assert.equal(addMonths('2026-01-01', -1), '2025-12-01');
    assert.equal(addMonths('2026-01-01', -3), '2025-10-01');
  });
});

describe('daysInMonth', () => {
  test('knows February in leap and common years', () => {
    assert.equal(daysInMonth(2024, 2), 29);
    assert.equal(daysInMonth(2025, 2), 28);
    assert.equal(daysInMonth(2000, 2), 29); // divisible by 400
    assert.equal(daysInMonth(1900, 2), 28); // divisible by 100 but not 400
  });

  test('knows 30- and 31-day months', () => {
    assert.equal(daysInMonth(2026, 4), 30);
    assert.equal(daysInMonth(2026, 12), 31);
  });
});

describe('cadence predicates', () => {
  test('isMonday', () => {
    assert.equal(isMonday('2026-08-10'), true);
    assert.equal(isMonday('2026-08-11'), false);
  });

  test('isFirstOfMonth', () => {
    assert.equal(isFirstOfMonth('2026-08-01'), true);
    assert.equal(isFirstOfMonth('2026-08-31'), false);
  });

  test('isQuarterStart is true only on Jan/Apr/Jul/Oct 1', () => {
    for (const d of ['2026-01-01', '2026-04-01', '2026-07-01', '2026-10-01']) {
      assert.equal(isQuarterStart(d), true, d);
    }
    for (const d of ['2026-02-01', '2026-03-01', '2026-01-02', '2026-12-01']) {
      assert.equal(isQuarterStart(d), false, d);
    }
  });
});

describe('planComparisons', () => {
  const types = (date: string) => planComparisons(date).map(p => p.reportType);

  test('an ordinary mid-week day runs DOD only', () => {
    // 2026-08-12 is a Wednesday.
    assert.deepEqual(types('2026-08-12'), ['DOD']);
    assert.deepEqual(planComparisons('2026-08-12')[0], {
      reportType: 'DOD', priorDate: '2026-08-11', currentDate: '2026-08-12',
    });
  });

  test('a Monday adds WOW against 7 days back', () => {
    assert.deepEqual(types('2026-08-10'), ['DOD', 'WOW']);
    const wow = planComparisons('2026-08-10').find(p => p.reportType === 'WOW');
    assert.equal(wow?.priorDate, '2026-08-03');
  });

  test('the 1st of a non-quarter month adds MOM but not QOQ', () => {
    // 2026-08-01 is a Saturday, so WOW must not appear either.
    assert.deepEqual(types('2026-08-01'), ['DOD', 'MOM']);
    const mom = planComparisons('2026-08-01').find(p => p.reportType === 'MOM');
    assert.equal(mom?.priorDate, '2026-07-01');
  });

  test('the 1st of a quarter adds both MOM and QOQ', () => {
    assert.deepEqual(types('2026-10-01'), ['DOD', 'MOM', 'QOQ']);
    const plans = planComparisons('2026-10-01');
    assert.equal(plans.find(p => p.reportType === 'MOM')?.priorDate, '2026-09-01');
    assert.equal(plans.find(p => p.reportType === 'QOQ')?.priorDate, '2026-07-01');
  });

  test('all four fire when a quarter start falls on a Monday', () => {
    // 2029-01-01 is a Monday.
    assert.deepEqual(types('2029-01-01'), ['DOD', 'WOW', 'MOM', 'QOQ']);
    const plans = planComparisons('2029-01-01');
    assert.equal(plans.find(p => p.reportType === 'DOD')?.priorDate, '2028-12-31');
    assert.equal(plans.find(p => p.reportType === 'WOW')?.priorDate, '2028-12-25');
    assert.equal(plans.find(p => p.reportType === 'MOM')?.priorDate, '2028-12-01');
    assert.equal(plans.find(p => p.reportType === 'QOQ')?.priorDate, '2028-10-01');
  });
});
