/**
 * INVOICE SEARCH module — NetSuite → Portal sync routes
 * Base prefix: /api/v1/invoices
 *
 * Two endpoints, both accepting a single OBJECT or an ARRAY (bulk):
 *   POST  /   create record(s)  -> invoice_search
 *   PATCH /   update record(s)  (located by netsuiteInternalId)
 *
 * All ids in the body are NetSuite internal ids; reference fields (*InternalId)
 * are resolved to portal DB ids by the service. Responses:
 *   single -> the row (201 create / 200 update), or the record's error status
 *   bulk   -> batch summary { total, successCount, failureCount, succeeded[], failed[] }
 *             (201/200 when all succeed, 207 when some fail)
 *
 * Mirrors src/routes/estimateQuotesSearch/index.ts.
 */

import { FastifyInstance } from 'fastify';
import { apiKeyAuth } from '../../middleware/apiKeyAuth.js';
import {
  InvoiceCreateSchema,
  InvoiceUpdateSchema,
  normalizeToArray,
  unwrapSingle,
  createInvoices,
  updateInvoices,
} from '../../services/invoiceSearch/invoice.service.js';

export default async function invoiceRoutes(app: FastifyInstance) {
  // Auth: X-API-Key on every request. This is a NetSuite → Portal sync module,
  // so it is protected the same way as the /api/v1/netsuite/* routes rather than
  // with the portal JWT.
  app.addHook('preHandler', apiKeyAuth);

  // POST /api/v1/invoices — create (single object or array)
  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const { records, wasSingle } = normalizeToArray(req.body, InvoiceCreateSchema);
    const result = await createInvoices(records);

    if (wasSingle) {
      return reply.status(201).send(unwrapSingle(result));
    }
    return reply.status(result.failureCount === 0 ? 201 : 207).send(result);
  });

  // PATCH /api/v1/invoices — update (single object or array)
  app.patch<{ Body: unknown }>('/', async (req, reply) => {
    const { records, wasSingle } = normalizeToArray(req.body, InvoiceUpdateSchema);
    const result = await updateInvoices(records);

    if (wasSingle) {
      return reply.status(200).send(unwrapSingle(result));
    }
    return reply.status(result.failureCount === 0 ? 200 : 207).send(result);
  });
}
