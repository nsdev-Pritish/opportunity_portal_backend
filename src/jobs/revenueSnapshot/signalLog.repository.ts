// Reads/writes revenue_sync_signal_log — one row per (run_date, source_type),
// where source_type is PIPELINE/SO/INVOICE/BUDGET (the 4 real sources) or the
// synthetic 'ALL' row tracking the overall insert job's own lifecycle.

import { eq, and } from 'drizzle-orm';
import { revenueSyncSignalLog } from '../../db/schema/index.js';
import type { DB } from '../../config/database.js';
import { SOURCE_TYPES, type SourceType } from './config.js';

export type SignalStatus = 'pending' | 'started' | 'completed' | 'scheduled' | 'running' | 'complete' | 'failed';

/** Upserts a source's row to `started`, stamping started_at the first time only. */
export async function markSourceStarted(db: DB, runDate: string, sourceType: SourceType): Promise<void> {
  await db.insert(revenueSyncSignalLog)
    .values({ runDate, sourceType, status: 'started', startedAt: new Date() })
    .onConflictDoUpdate({
      target: [revenueSyncSignalLog.runDate, revenueSyncSignalLog.sourceType],
      set: { status: 'started', startedAt: new Date() },
    });
}

/** Upserts a source's row to `completed`, optionally recording how many records NetSuite reported. */
export async function markSourceCompleted(db: DB, runDate: string, sourceType: SourceType, recordCount?: number): Promise<void> {
  await db.insert(revenueSyncSignalLog)
    .values({ runDate, sourceType, status: 'completed', completedAt: new Date(), recordCount })
    .onConflictDoUpdate({
      target: [revenueSyncSignalLog.runDate, revenueSyncSignalLog.sourceType],
      set: { status: 'completed', completedAt: new Date(), recordCount },
    });
}

/**
 * Upserts a source's row to `failed`. A failed source is never counted by
 * allSourcesCompleted(), so the day's insert simply never triggers — someone
 * needs to look at error_message and re-run that source's sync.
 */
export async function markSourceFailed(db: DB, runDate: string, sourceType: SourceType, errorMessage: string): Promise<void> {
  await db.insert(revenueSyncSignalLog)
    .values({ runDate, sourceType, status: 'failed', errorMessage })
    .onConflictDoUpdate({
      target: [revenueSyncSignalLog.runDate, revenueSyncSignalLog.sourceType],
      set: { status: 'failed', errorMessage },
    });
}

/** True once every one of the 4 real sources shows `completed` for this run_date. */
export async function allSourcesCompleted(db: DB, runDate: string): Promise<boolean> {
  const rows = await db.select({ sourceType: revenueSyncSignalLog.sourceType, status: revenueSyncSignalLog.status })
    .from(revenueSyncSignalLog)
    .where(eq(revenueSyncSignalLog.runDate, runDate));

  const completed = new Set(rows.filter(r => r.status === 'completed').map(r => r.sourceType));
  return SOURCE_TYPES.every(s => completed.has(s));
}

/**
 * Atomically claims the day's insert job by flipping the synthetic 'ALL' row
 * from pending -> scheduled. Ensures the row exists first. Returns true only
 * for the ONE caller that wins the race — every other concurrent caller
 * (e.g. two "sync end" signals landing at nearly the same moment) gets false
 * and must not schedule a second insert.
 */
export async function tryClaimInsertSlot(db: DB, runDate: string): Promise<boolean> {
  await db.insert(revenueSyncSignalLog)
    .values({ runDate, sourceType: 'ALL', status: 'pending' })
    .onConflictDoNothing({ target: [revenueSyncSignalLog.runDate, revenueSyncSignalLog.sourceType] });

  const claimed = await db.update(revenueSyncSignalLog)
    .set({ status: 'scheduled' })
    .where(and(
      eq(revenueSyncSignalLog.runDate, runDate),
      eq(revenueSyncSignalLog.sourceType, 'ALL'),
      eq(revenueSyncSignalLog.status, 'pending'),
    ))
    .returning({ id: revenueSyncSignalLog.id });

  return claimed.length > 0;
}

export async function markInsertRunning(db: DB, runDate: string): Promise<void> {
  await db.update(revenueSyncSignalLog)
    .set({ status: 'running', startedAt: new Date() })
    .where(and(eq(revenueSyncSignalLog.runDate, runDate), eq(revenueSyncSignalLog.sourceType, 'ALL')));
}

export async function markInsertComplete(db: DB, runDate: string): Promise<void> {
  await db.update(revenueSyncSignalLog)
    .set({ status: 'complete', completedAt: new Date() })
    .where(and(eq(revenueSyncSignalLog.runDate, runDate), eq(revenueSyncSignalLog.sourceType, 'ALL')));
}

export async function markInsertFailed(db: DB, runDate: string, errorMessage: string): Promise<void> {
  await db.update(revenueSyncSignalLog)
    .set({ status: 'failed', errorMessage })
    .where(and(eq(revenueSyncSignalLog.runDate, runDate), eq(revenueSyncSignalLog.sourceType, 'ALL')));
}

/** Every row logged for a given run_date — the 4 real sources plus 'ALL', if present. */
export async function getSignalRows(db: DB, runDate: string) {
  return db.select({
    sourceType: revenueSyncSignalLog.sourceType,
    status: revenueSyncSignalLog.status,
    recordCount: revenueSyncSignalLog.recordCount,
    startedAt: revenueSyncSignalLog.startedAt,
    completedAt: revenueSyncSignalLog.completedAt,
    errorMessage: revenueSyncSignalLog.errorMessage,
  })
    .from(revenueSyncSignalLog)
    .where(eq(revenueSyncSignalLog.runDate, runDate))
    .orderBy(revenueSyncSignalLog.sourceType);
}
