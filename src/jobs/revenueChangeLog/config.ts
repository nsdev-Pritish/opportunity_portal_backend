// Tuning knobs for the change-log builder. Nothing else in the app reads
// this — safe to adjust without touching the job's logic.

/** Max rows per single insert into fact_revenue_change_log. */
export const CHANGELOG_INSERT_CHUNK_SIZE = 500;

/** Half a cent of tolerance on every amount comparison — same rationale as revenueComparison's AMOUNT_EPSILON: absorbs float noise, not a business threshold. */
export const AMOUNT_EPSILON = 0.01;

/**
 * Tolerance for "did the exchange rate move?". Rates are numeric(18,8), so a
 * genuine rate change is never smaller than 1e-8; this sits two orders of
 * magnitude above that to absorb round-trip float noise while still catching
 * every real movement. Not a business threshold either.
 */
export const RATE_EPSILON = 1e-6;
