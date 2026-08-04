/**
 * ESTIMATE QUOTE INTEGRATION
 * Called by NetSuite when a Quote is created for an existing Estimate.
 *
 *  POST  /api/v1/netsuite/estimate-quotes             → receive ONE new quote
 *  POST  /api/v1/netsuite/estimate-quotes/sync-all    → BULK UPSERT every existing NS quote
 *  GET   /api/v1/netsuite/estimate-quotes             → list synced quotes (verify a backfill)
 *  GET   /api/v1/netsuite/estimate-quotes/:estimateId → quotes of one estimate (portal id)
 *
 * Auth: X-API-Key (inherited from the parent netsuite router).
 *
 * NetSuite sends:
 *   estimateInternalId     — NS internal ID of the parent Estimate
 *   estimateDocumentNumber — NS document number of the Estimate (optional)
 *   quoteInternalId        — NS internal ID of the newly created Quote
 *   quoteDocumentNumber    — NS document number of the Quote
 *   lineItemInternalIds    — NS internal IDs of the line items included in the Quote
 *
 * The handler:
 *   1. Finds the portal Estimate by estimateInternalId.
 *   2. Stores the Quote in estimate_quotes (idempotent — skips duplicates).
 *   3. Marks matching line items as converted = true.
 */

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  receiveQuoteFromNetsuite,
  getQuotesForEstimate,
  syncAllQuotesFromNetsuite,
  listSyncedQuotes,
} from '../../services/estimateQuote.service.js';
import { logger } from '../../utils/logger.js';

const ReceiveQuoteSchema = z.object({
  estimateInternalId    : z.string().min(1, 'estimateInternalId is required'),
  estimateDocumentNumber: z.string().optional().nullable(),
  quoteInternalId       : z.string().min(1, 'quoteInternalId is required'),
  quoteDocumentNumber   : z.string().min(1, 'quoteDocumentNumber is required'),
  lineItemInternalIds   : z.array(z.string()).optional().default([]),
});

// ── Bulk sync ────────────────────────────────────────────────────────────────
// NetSuite is loosely typed on the wire: internal ids arrive as numbers as often
// as strings, and select fields as { value, text }. Normalise before validating.
const nsId = z.preprocess((v) => {
  if (v == null || v === '') return undefined;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const cand = o.value ?? o.id ?? o.text;
    return cand == null ? undefined : String(cand);
  }
  return v;
}, z.string().min(1).max(50).optional());

const SyncQuoteRecordSchema = z
  .object({
    estimateInternalId    : nsId,
    estimateDocumentNumber: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.string().max(100).optional()),
    quoteInternalId       : nsId,
    quoteDocumentNumber   : z.preprocess((v) => {
      if (v === '' || v == null) return undefined;
      return typeof v === 'number' ? String(v) : v;
    }, z.string().max(100).optional()),
    status                : z.enum(['active', 'replaced']).optional(),
    lineItemInternalIds   : z
      .array(z.union([z.string(), z.number()]))
      .optional()
      .transform((arr) => (arr ?? []).map(String).filter((s) => s !== '')),
  })
  .refine((r) => !!r.quoteInternalId, {
    message: 'quoteInternalId is required',
    path   : ['quoteInternalId'],
  })
  .refine((r) => !!r.estimateInternalId || !!r.estimateDocumentNumber, {
    message: 'estimateInternalId (or estimateDocumentNumber) is required',
    path   : ['estimateInternalId'],
  });

/** Accepts a bare array, a single object, or { quotes: [...] } / { data: [...] }. */
const SyncAllBodySchema = z.preprocess((body) => {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>;
    if (Array.isArray(o.quotes)) return o.quotes;
    if (Array.isArray(o.records)) return o.records;
    if (Array.isArray(o.data)) return o.data;
    return [body];
  }
  return body;
}, z.array(SyncQuoteRecordSchema));

export default async function estimateQuoteNsRoutes(app: FastifyInstance) {

  /**
   * POST /api/v1/netsuite/estimate-quotes
   *
   * Example body:
   * {
   *   "estimateInternalId": "1001",
   *   "estimateDocumentNumber": "EST-001",
   *   "quoteInternalId": "5001",
   *   "quoteDocumentNumber": "QT-001",
   *   "lineItemInternalIds": ["201", "202", "203"]
   * }
   */
  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const body = ReceiveQuoteSchema.parse(req.body);

    logger.info(
      { estimateInternalId: body.estimateInternalId, quoteInternalId: body.quoteInternalId },
      'NetSuite → Portal: receiving quote',
    );

    const result = await receiveQuoteFromNetsuite({
      estimateInternalId    : body.estimateInternalId,
      estimateDocumentNumber: body.estimateDocumentNumber,
      quoteInternalId       : body.quoteInternalId,
      quoteDocumentNumber   : body.quoteDocumentNumber,
      lineItemInternalIds   : body.lineItemInternalIds,
    });

    return reply.status(result._action === 'created' ? 201 : 200).send(result);
  });

  /**
   * POST /api/v1/netsuite/estimate-quotes/sync-all
   *
   * BULK UPSERT — pushes every Quote that already exists in NetSuite into the
   * portal. Safe to re-run: each quote is matched on quoteInternalId and either
   * created or updated, never duplicated.
   *
   * Body — a bare array (or { "quotes": [ ... ] }):
   * [
   *   {
   *     "estimateInternalId": "1001",
   *     "estimateDocumentNumber": "EST0001001",
   *     "quoteInternalId": "5001",
   *     "quoteDocumentNumber": "QT0005001",
   *     "status": "active",
   *     "lineItemInternalIds": ["201", "202"]
   *   }
   * ]
   *
   * Query: ?dryRun=true → resolve and report only, writes nothing.
   *
   * Response: { total, successCount, failureCount, created, updated,
   *             lineItemsMarkedConverted, succeeded[], failed[] }
   * Status:   201 all created/updated · 207 partial (some records failed)
   *
   * Send at most 2000 quotes per call — page beyond that.
   */
  app.post<{ Body: unknown; Querystring: { dryRun?: string } }>('/sync-all', async (req, reply) => {
    const records = SyncAllBodySchema.parse(req.body);
    const dryRun  = req.query.dryRun === 'true' || req.query.dryRun === '1';

    logger.info({ count: records.length, dryRun }, 'NetSuite → Portal: sync-all quotes received');

    const result = await syncAllQuotesFromNetsuite(
      records.map((r) => ({
        estimateInternalId    : r.estimateInternalId,
        estimateDocumentNumber: r.estimateDocumentNumber,
        quoteInternalId       : r.quoteInternalId as string, // guaranteed by the schema refine
        quoteDocumentNumber   : r.quoteDocumentNumber,
        status                : r.status,
        lineItemInternalIds   : r.lineItemInternalIds,
      })),
      { dryRun },
    );

    return reply.status(result.failureCount === 0 ? 201 : 207).send(result);
  });

  /**
   * GET /api/v1/netsuite/estimate-quotes
   *
   * Lists the quotes stored in the portal — use it to verify a backfill.
   * Query: page, limit (max 500), estimateInternalId, status.
   */
  app.get<{
    Querystring: { page?: string; limit?: string; estimateInternalId?: string; status?: string };
  }>('/', async (req) => {
    const q = z
      .object({
        page              : z.coerce.number().int().positive().optional(),
        limit             : z.coerce.number().int().positive().optional(),
        estimateInternalId: z.string().min(1).optional(),
        status            : z.enum(['active', 'replaced']).optional(),
      })
      .parse(req.query);

    return listSyncedQuotes(q);
  });

  /**
   * GET /api/v1/netsuite/estimate-quotes/:estimateId
   *
   * Returns how many quotes exist for a given estimate (by Portal primary key),
   * along with the quotes themselves.
   *
   * Example: GET /api/v1/netsuite/estimate-quotes/126
   * Response: { estimateId, estimateInternalId, estimateDocumentNumber, quoteCount, quotes: [...] }
   */
  app.get<{ Params: { estimateId: string } }>(
    '/:estimateId',
    async (req) => {
      const estimateId = z.coerce.number().int().positive().parse(req.params.estimateId);
      return getQuotesForEstimate(estimateId);
    },
  );
}
