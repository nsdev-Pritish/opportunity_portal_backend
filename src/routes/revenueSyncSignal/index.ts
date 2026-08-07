/**
 * REVENUE SYNC SIGNAL module — NetSuite routes
 * Base prefix: /api/v1/revenue-sync-signal
 *
 * NetSuite's daily scheduled script calls these once per source, at the
 * start, end, or fail of that source's sync batch for the day:
 *   POST /start  { source: 'PIPELINE' | 'SO' | 'INVOICE' | 'BUDGET' }
 *   POST /end    { source, recordCount? }
 *   POST /fail   { source, reason }
 *
 * Once all 4 sources have reported /end for the same day, the Revenue
 * Snapshot insert is scheduled automatically 1 minute later — see
 * src/jobs/revenueSnapshot/syncSignalHandler.ts. If any source reports
 * /fail instead, that day's insert never fires until it's re-run and
 * reports /end successfully.
 *
 * A 4th, read-only endpoint exists purely for testing/diagnostics — not
 * called by NetSuite:
 *   GET /status?date=YYYY-MM-DD   (date optional, defaults to today)
 * Returns today's (or the given date's) signal log rows plus a live count
 * of what's actually in fact_revenue_snapshot for that date, so you can
 * confirm the insert really happened without a separate DB client.
 */

import { FastifyInstance } from 'fastify';
import { apiKeyAuth } from '../../middleware/apiKeyAuth.js';
import {
  SyncSignalSchema,
  SyncEndSchema,
  SyncFailSchema,
  recordSyncStart,
  recordSyncEnd,
  recordSyncFail,
  getTodayStatus,
} from '../../services/revenueSyncSignal/revenueSyncSignal.service.js';

export default async function revenueSyncSignalRoutes(app: FastifyInstance) {
  // Auth: X-API-Key, same as the other NetSuite -> Portal sync modules.
  app.addHook('preHandler', apiKeyAuth);

  app.post<{ Body: unknown }>('/start', async (req, reply) => {
    const input = SyncSignalSchema.parse(req.body);
    const result = await recordSyncStart(input);
    return reply.status(200).send(result);
  });

  app.post<{ Body: unknown }>('/end', async (req, reply) => {
    const input = SyncEndSchema.parse(req.body);
    const result = await recordSyncEnd(input);
    return reply.status(200).send(result);
  });

  app.post<{ Body: unknown }>('/fail', async (req, reply) => {
    const input = SyncFailSchema.parse(req.body);
    const result = await recordSyncFail(input);
    return reply.status(200).send(result);
  });

  app.get<{ Querystring: { date?: string } }>('/status', async (req, reply) => {
    const result = await getTodayStatus(req.query.date);
    return reply.status(200).send(result);
  });
}
