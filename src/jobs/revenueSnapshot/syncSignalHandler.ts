// Core orchestration for the signal-driven design: NetSuite calls "sync
// start" and "sync end" once per source per day; this module reacts to
// those two events. No timer, no scheduler, no polling — the arrival of the
// 4th "sync end" signal for a given day IS the trigger. The only delay is a
// single one-shot wait (INSERT_DELAY_MS) between that trigger and the actual
// insert, per the requested "wait 1 minute after all 4 complete" behavior.

import {
  markSourceStarted,
  markSourceCompleted,
  markSourceFailed,
  allSourcesCompleted,
  tryClaimInsertSlot,
  markInsertRunning,
  markInsertComplete,
  markInsertFailed,
} from './signalLog.repository.js';
import { buildRevenueSnapshotSequential } from './snapshotBuilder.js';
import { runAllComparisons } from '../revenueComparison/index.js';
import { buildChangeLog } from '../revenueChangeLog/changeLogBuilder.js';
import { INSERT_DELAY_MS, type SourceType } from './config.js';
import type { DB } from '../../config/database.js';

export function todayDateString(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Call when NetSuite reports it has started today's sync for a source. Informational only. */
export async function handleSyncStart(db: DB, sourceType: SourceType): Promise<void> {
  await markSourceStarted(db, todayDateString(), sourceType);
}

/**
 * Call when NetSuite reports today's sync for a source has finished.
 * If this happens to be the 4th source to report completion today, this
 * claims the insert slot and schedules the actual insert 1 minute later.
 *
 * This is also the retry entry point: if a previous attempt for the same day
 * failed (or was abandoned when its process died), the claim below succeeds
 * again — so re-running ANY one source's sync end-to-end retries the day. See
 * tryClaimInsertSlot for which states are re-claimable and why that can't
 * duplicate rows.
 */
export async function handleSyncEnd(db: DB, sourceType: SourceType, recordCount?: number): Promise<{ scheduledInsert: boolean }> {
  const runDate = todayDateString();
  await markSourceCompleted(db, runDate, sourceType, recordCount);

  const allDone = await allSourcesCompleted(db, runDate);
  if (!allDone) return { scheduledInsert: false };

  // Atomic claim — only the ONE caller that wins this race schedules the insert,
  // even if two "sync end" signals complete the set at nearly the same instant.
  const claimed = await tryClaimInsertSlot(db, runDate);
  if (!claimed) return { scheduledInsert: false };

  setTimeout(() => {
    runScheduledInsert(db, runDate).catch(err => {
      console.error(`[revenue-snapshot] scheduled insert for ${runDate} failed:`, err);
    });
  }, INSERT_DELAY_MS);

  return { scheduledInsert: true };
}

/**
 * Call when NetSuite reports today's sync for a source has failed. That
 * source's row is marked `failed` and never counts toward
 * allSourcesCompleted() — the day's insert simply never fires until someone
 * re-runs that source's sync and it reports `end` successfully instead.
 */
export async function handleSyncFail(db: DB, sourceType: SourceType, reason: string): Promise<void> {
  const runDate = todayDateString();
  await markSourceFailed(db, runDate, sourceType, reason);
  console.error(`[revenue-snapshot] ${runDate} — ${sourceType} sync reported FAILED: ${reason}`);
}

async function runScheduledInsert(db: DB, runDate: string): Promise<void> {
  await markInsertRunning(db, runDate);
  try {
    const result = await buildRevenueSnapshotSequential(db, runDate, new Date());
    await markInsertComplete(db, runDate);
    console.log(`[revenue-snapshot] ${runDate} — inserted ${result.inserted} rows`, result.bySource);

    // Comparisons run off the snapshot that just committed — never on their
    // own schedule. Deliberately AFTER markInsertComplete: runAllComparisons
    // checks revenue_sync_signal_log to confirm both snapshot dates are
    // complete before comparing, so today's row has to be marked first.
    // runAllComparisons never throws and isolates each report type
    // internally, so a comparison problem is logged but cannot flip this
    // day's snapshot — already committed and marked complete — to failed.
    const outcomes = await runAllComparisons(db, runDate);

    // The change log reads revenue_comparison's own DOD row for its lifecycle
    // detection (see changeLogBuilder.ts), so it only ever runs off the DOD
    // outcome specifically — WOW/MOM/QOQ are broader rollups that don't map
    // to "what happened on this one day" the way the change log needs.
    // Isolated in its own try/catch for the same reason runAllComparisons is:
    // a change-log problem must not be reported as a snapshot failure.
    const dod = outcomes.find(o => o.reportType === 'DOD');
    if (dod?.status === 'ok') {
      try {
        const clResult = await buildChangeLog(db, dod.priorDate, dod.currentDate);
        console.log(`[revenue-change-log] ${dod.priorDate} -> ${dod.currentDate} — OK: ${clResult.inserted} row(s)`);
      } catch (clErr) {
        console.error(`[revenue-change-log] ${dod.priorDate} -> ${dod.currentDate} — FAILED:`, clErr);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markInsertFailed(db, runDate, message);
    throw err;
  }
}
