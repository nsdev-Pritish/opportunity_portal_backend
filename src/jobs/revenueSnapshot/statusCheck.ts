// Read-only diagnostic used by the /status endpoint — combines today's
// signal log rows with a live count of what actually landed in
// fact_revenue_snapshot, so testing doesn't require a separate DB client.

import { eq, sql } from 'drizzle-orm';
import { factRevenueSnapshot } from '../../db/schema/index.js';
import type { DB } from '../../config/database.js';
import { getSignalRows } from './signalLog.repository.js';

export async function getDailyStatus(db: DB, runDate: string) {
  const signals = await getSignalRows(db, runDate);

  const snapshotCounts = await db.select({
    sourceType: factRevenueSnapshot.sourceType,
    count: sql<number>`count(*)::int`,
  })
    .from(factRevenueSnapshot)
    .where(eq(factRevenueSnapshot.snapshotDate, runDate))
    .groupBy(factRevenueSnapshot.sourceType);

  const bySource: Record<string, number> = {};
  let totalSnapshotRows = 0;
  for (const row of snapshotCounts) {
    bySource[row.sourceType] = row.count;
    totalSnapshotRows += row.count;
  }

  return {
    runDate,
    signals,
    snapshot: {
      totalRows: totalSnapshotRows,
      bySource,
    },
  };
}
