/**
 * ESTIMATE QUOTE module — Portal/NetSuite routes
 * Base prefix: /api/v1/estimate-quotes
 *
 * Two endpoints, both accepting a single OBJECT or an ARRAY (bulk):
 *   POST  /   create record(s)  -> estimate_quote_search
 *   PATCH /   update record(s)  (located by netsuiteInternalId)
 *
 * All ids in the body are NetSuite internal ids; reference fields (*InternalId)
 * are resolved to portal DB ids by the service. Responses:
 *   single -> the row (201 create / 200 update), or the record's error status
 *   bulk   -> batch summary { total, successCount, failureCount, succeeded[], failed[] }
 *             (201/200 when all succeed, 207 when some fail)
 */

import { FastifyInstance } from 'fastify';
import { apiKeyAuth } from '../../middleware/apiKeyAuth.js';
import {
  EstimateQuoteCreateSchema,
  EstimateQuoteUpdateSchema,
  normalizeToArray,
  unwrapSingle,
  createEstimateQuotes,
  updateEstimateQuotes,
} from '../../services/estimateQuotesSearch/estimateQuote.service.js';

export default async function estimateQuoteRoutes(app: FastifyInstance) {
  // Auth: X-API-Key on every request. This is a NetSuite → Portal sync module,
  // so it is protected the same way as the /api/v1/netsuite/* routes rather than
  // with the portal JWT.
  app.addHook('preHandler', apiKeyAuth);

  // POST /api/v1/estimate-quotes — create (single object or array)
  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const { records, wasSingle } = normalizeToArray(req.body, EstimateQuoteCreateSchema);
    const result = await createEstimateQuotes(records);

    if (wasSingle) {
      return reply.status(201).send(unwrapSingle(result));
    }
    return reply.status(result.failureCount === 0 ? 201 : 207).send(result);
  });

  // PATCH /api/v1/estimate-quotes — update (single object or array)
  app.patch<{ Body: unknown }>('/', async (req, reply) => {
    const { records, wasSingle } = normalizeToArray(req.body, EstimateQuoteUpdateSchema);
    const result = await updateEstimateQuotes(records);

    if (wasSingle) {
      return reply.status(200).send(unwrapSingle(result));
    }
    return reply.status(result.failureCount === 0 ? 200 : 207).send(result);
  });
}
