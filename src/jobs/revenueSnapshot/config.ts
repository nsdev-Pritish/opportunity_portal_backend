// Tuning knob for the signal-driven Revenue Snapshot job. Nothing else in
// the app reads this — safe to adjust without touching the job's logic.

/** Wait this long after the last source reports "sync end" before inserting. */
export const INSERT_DELAY_MS = 60_000; // 1 minute

/**
 * Max rows per single INSERT into fact_revenue_snapshot (25 columns today).
 * Postgres hard-caps a query at 65,535 parameters (65,535 / 25 ≈ 2,621 rows);
 * 1,000 leaves comfortable headroom even as more columns get added later.
 */
export const SNAPSHOT_INSERT_CHUNK_SIZE = 1000;

// The daily insert fires once EVERY source below has reported "sync end" for
// the day (see signalLog.repository.ts#allSourcesCompleted) — adding a
// source here means the insert now waits on it too, so add one only once its
// NetSuite script is actually scheduled to run daily; otherwise the whole
// snapshot can stall waiting on a signal that never arrives.
export const SOURCE_TYPES = ['PIPELINE', 'SO', 'INVOICE', 'BUDGET', 'CREDIT_MEMO'] as const;
export type SourceType = typeof SOURCE_TYPES[number];
