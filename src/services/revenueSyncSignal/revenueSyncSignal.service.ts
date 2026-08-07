/**
 * REVENUE SYNC SIGNAL — Create-only service (no source data, just lifecycle events)
 *
 * NetSuite calls these once per source per day, at the start, end (success),
 * or fail of that source's daily sync batch. Not a data-sync module like the
 * other 4 — it carries no business fields, just which source, which
 * lifecycle event, and (on end/fail) optional diagnostic info.
 */

import { z } from 'zod';
import { getDb } from '../../config/database.js';
import { SOURCE_TYPES } from '../../jobs/revenueSnapshot/config.js';
import { handleSyncStart, handleSyncEnd, handleSyncFail, todayDateString } from '../../jobs/revenueSnapshot/syncSignalHandler.js';
import { getDailyStatus } from '../../jobs/revenueSnapshot/statusCheck.js';

export const SyncSignalSchema = z.object({
  source: z.enum(SOURCE_TYPES),
});

export const SyncEndSchema = SyncSignalSchema.extend({
  recordCount: z.number().int().nonnegative().optional(),
});

export const SyncFailSchema = SyncSignalSchema.extend({
  reason: z.string().min(1).max(1000),
});

export type SyncSignalInput = z.infer<typeof SyncSignalSchema>;
export type SyncEndInput = z.infer<typeof SyncEndSchema>;
export type SyncFailInput = z.infer<typeof SyncFailSchema>;

export async function recordSyncStart(input: SyncSignalInput): Promise<{ source: string; status: string }> {
  const db = getDb();
  await handleSyncStart(db, input.source);
  return { source: input.source, status: 'started' };
}

export async function recordSyncEnd(input: SyncEndInput): Promise<{ source: string; status: string; scheduledInsert: boolean }> {
  const db = getDb();
  const { scheduledInsert } = await handleSyncEnd(db, input.source, input.recordCount);
  return { source: input.source, status: 'completed', scheduledInsert };
}

export async function recordSyncFail(input: SyncFailInput): Promise<{ source: string; status: string }> {
  const db = getDb();
  await handleSyncFail(db, input.source, input.reason);
  return { source: input.source, status: 'failed' };
}

/** Diagnostic read: today's signal log rows plus how many rows actually landed in fact_revenue_snapshot. */
export async function getTodayStatus(runDate?: string) {
  const db = getDb();
  return getDailyStatus(db, runDate ?? todayDateString());
}
