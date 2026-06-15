/**
 * ESTIMATE QUOTE INTEGRATION
 * Called by NetSuite when a Quote is created for an existing Estimate.
 *
 *  POST  /api/v1/netsuite/estimate-quotes
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
import { receiveQuoteFromNetsuite, getQuotesForEstimate } from '../../services/estimateQuote.service.js';
import { logger } from '../../utils/logger.js';

const ReceiveQuoteSchema = z.object({
  estimateInternalId    : z.string().min(1, 'estimateInternalId is required'),
  estimateDocumentNumber: z.string().optional().nullable(),
  quoteInternalId       : z.string().min(1, 'quoteInternalId is required'),
  quoteDocumentNumber   : z.string().min(1, 'quoteDocumentNumber is required'),
  lineItemInternalIds   : z.array(z.string()).optional().default([]),
});

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
