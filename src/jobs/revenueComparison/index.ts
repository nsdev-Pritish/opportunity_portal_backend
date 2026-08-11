// Decides WHICH comparisons today calls for, then runs them.
//
// Called once, straight after the daily fact_revenue_snapshot insert reports
// success (see syncSignalHandler.runScheduledInsert). There is deliberately
// no cron, no timer and no second job runner here — the snapshot job is
// signal-driven (NetSuite's 4th "sync end" of the day is the trigger), and
// bolting a schedule onto the comparison step would let it fire on a day
// whose snapshot hadn't landed yet. Hanging off the snapshot's own completion
// is what guarantees the current side of every comparison actually exists.
//
// Cadence:
//   DOD — every day, against yesterday.
//   WOW — Mondays only, against the Monday 7 days back.
//   MOM — the 1st of a month only, against the 1st of the previous month.
//   QOQ — Jan/Apr/Jul/Oct 1st only, against the 1st three months back.
// On Jan 1 all four fire; each is independent, and one failing never stops
// the others.

import { eq, and } from 'drizzle-orm';
import { revenueSyncSignalLog } from '../../db/schema/index.js';
import type { DB } from '../../config/database.js';
import { runComparison, type ComparisonResult } from './comparisonBuilder.js';
import { runChangeLogForBatch } from '../revenueChangeLog/revenueChangeLog.js';
import { MONTHS_BACK, type ReportType } from './config.js';
import { addDays, addMonths, isMonday, isFirstOfMonth, isQuarterStart } from './dateMath.js';

export { runComparison, type ComparisonResult } from './comparisonBuilder.js';

export interface PlannedComparison {
  reportType: ReportType;
  priorDate: string;
  currentDate: string;
}

export type ComparisonOutcome =
  | ({ status: 'ok' } & ComparisonResult)
  | ({ status: 'skipped'; reason: string } & PlannedComparison)
  | ({ status: 'failed'; error: string } & PlannedComparison);

/**
 * The comparisons due on a given date, in run order. Pure — no database, no
 * clock — so the cadence rules can be tested directly for any date.
 */
export function planComparisons(currentDate: string): PlannedComparison[] {
  const planned: PlannedComparison[] = [
    { reportType: 'DOD', priorDate: addDays(currentDate, -1), currentDate },
  ];

  if (isMonday(currentDate)) {
    planned.push({ reportType: 'WOW', priorDate: addDays(currentDate, -7), currentDate });
  }

  if (isFirstOfMonth(currentDate)) {
    planned.push({ reportType: 'MOM', priorDate: addMonths(currentDate, -MONTHS_BACK.MOM!), currentDate });
  }

  if (isQuarterStart(currentDate)) {
    planned.push({ reportType: 'QOQ', priorDate: addMonths(currentDate, -MONTHS_BACK.QOQ!), currentDate });
  }

  return planned;
}

/**
 * True once that date's snapshot has fully landed.
 *
 * revenue_sync_signal_log is this repo's completeness tracker: the synthetic
 * 'ALL' row reaches status 'complete' only after all 4 sources reported
 * 'completed' AND the insert transaction committed. Any other state — no row,
 * 'failed', still 'running' — means the date's snapshot is partial or absent,
 * and comparing against it would report business changes that are really just
 * missing rows.
 */
export async function isSnapshotComplete(db: DB, runDate: string): Promise<boolean> {
  const rows = await db.select({ status: revenueSyncSignalLog.status })
    .from(revenueSyncSignalLog)
    .where(and(
      eq(revenueSyncSignalLog.runDate, runDate),
      eq(revenueSyncSignalLog.sourceType, 'ALL'),
    ))
    .limit(1);

  return rows[0]?.status === 'complete';
}

/**
 * Runs every comparison due for `currentDate`.
 *
 * Never throws. Each comparison is isolated in its own try/catch, so a WOW
 * failure cannot stop DOD from completing (or vice versa) — the caller is the
 * daily snapshot job, and a comparison problem must not be reported as a
 * snapshot failure. The outcome of every comparison is returned for callers
 * that want it, and logged either way.
 */
export async function runAllComparisons(db: DB, currentDate: string): Promise<ComparisonOutcome[]> {
  const planned = planComparisons(currentDate);
  const outcomes: ComparisonOutcome[] = [];

  for (const plan of planned) {
    const { reportType, priorDate } = plan;
    const window = `${priorDate} -> ${currentDate}`;

    try {
      const incomplete = await findIncompleteSide(db, priorDate, currentDate);
      if (incomplete) {
        console.warn(`[revenue-comparison] ${reportType} ${window} — SKIPPED: ${incomplete}`);
        outcomes.push({ status: 'skipped', reason: incomplete, ...plan });
        continue;
      }

      const result = await runComparison(db, reportType, priorDate, currentDate);
      console.log(
        `[revenue-comparison] ${reportType} ${window} — OK: ${result.inserted} row(s) inserted, ${result.labelled} labelled`,
      );
      outcomes.push({ status: 'ok', ...result });

      // revenue_change_log is derived straight from the rows runComparison
      // just wrote, so it runs here — immediately after this report type's
      // comparison succeeded — rather than on its own schedule. Isolated in
      // its own try/catch: the comparison itself is already committed and
      // reported OK above, and a change-log problem must not retroactively
      // turn this comparison into a failure or stop the next report type.
      try {
        await runChangeLogForBatch(db, reportType, currentDate);
      } catch (clErr) {
        const message = clErr instanceof Error ? clErr.message : String(clErr);
        console.error(`[revenue-change-log] ${reportType} ${window} — FAILED: ${message}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[revenue-comparison] ${reportType} ${window} — FAILED: ${message}`);
      outcomes.push({ status: 'failed', error: message, ...plan });
    }
  }

  return outcomes;
}

/**
 * Returns a human-readable reason if either side's snapshot is unusable, or
 * null when both are complete.
 *
 * The current side is normally complete by the time this runs (the snapshot
 * job just committed it); the prior side is the one that genuinely varies —
 * it may predate this job, may have failed, or, on the very first run ever,
 * may not exist at all.
 */
async function findIncompleteSide(db: DB, priorDate: string, currentDate: string): Promise<string | null> {
  for (const [label, date] of [['prior', priorDate], ['current', currentDate]] as const) {
    if (!(await isSnapshotComplete(db, date))) {
      return `${label} snapshot ${date} is not complete in revenue_sync_signal_log`;
    }
  }
  return null;
}
