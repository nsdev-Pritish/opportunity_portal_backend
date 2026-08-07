// Tuning knob for the signal-driven Revenue Snapshot job. Nothing else in
// the app reads this — safe to adjust without touching the job's logic.

/** Wait this long after the 4th source reports "sync end" before inserting. */
export const INSERT_DELAY_MS = 60_000; // 1 minute

export const SOURCE_TYPES = ['PIPELINE', 'SO', 'INVOICE', 'BUDGET'] as const;
export type SourceType = typeof SOURCE_TYPES[number];
