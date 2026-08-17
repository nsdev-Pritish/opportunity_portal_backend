/**
 * WRIKE REQUEST LIST APIs — Sub-router
 * Base prefix: /api/v1/netsuite/wrike
 *
 *  /creative-request-types        → creative_request_types
 *  /creative-request-categories   → creative_request_categories
 *  /new-clients                   → new_clients            (Yes / No list)
 *  /creative-request-assets       → creative_request_assets
 *  /creative-request-scope-work   → creative_request_scope_work
 *  /about-us-info                 → about_us_info          (Yes / No list)
 *  /requestors                    → requestors             (+ wrikeId)
 *
 * Each prefix exposes the same endpoints (see _wrikeListRoutes.ts):
 *  GET / · GET /:nsId · POST / · PUT /:nsId · PUT /:nsId/activate ·
 *  PUT /:nsId/inactivate · PUT /:nsId/status
 *
 * Body for POST: { "netsuiteInternalId": "123", "name": "Packaging" }
 * Requestors also accept "wrikeId": { "netsuiteInternalId": "5", "name": "Jane Doe", "wrikeId": "KUAAAAAA" }
 */

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  creativeRequestTypes, creativeRequestCategories, newClients, creativeRequestAssets,
  creativeRequestScopeWork, aboutUsInfo, requestors,
} from '../../../db/schema/index.js';
import { buildWrikeListRoutes } from './_wrikeListRoutes.js';

export default async function wrikeRoutes(app: FastifyInstance) {
  await app.register(
    buildWrikeListRoutes(creativeRequestTypes, 'Creative Request Type', 'creative_request_types'),
    { prefix: '/creative-request-types' },
  );
  await app.register(
    buildWrikeListRoutes(creativeRequestCategories, 'Creative Request Category', 'creative_request_categories'),
    { prefix: '/creative-request-categories' },
  );
  await app.register(
    buildWrikeListRoutes(newClients, 'New Client', 'new_clients'),
    { prefix: '/new-clients' },
  );
  await app.register(
    buildWrikeListRoutes(creativeRequestAssets, 'Creative Request Asset', 'creative_request_assets'),
    { prefix: '/creative-request-assets' },
  );
  await app.register(
    buildWrikeListRoutes(creativeRequestScopeWork, 'Creative Request Scope of Work', 'creative_request_scope_work'),
    { prefix: '/creative-request-scope-work' },
  );
  await app.register(
    buildWrikeListRoutes(aboutUsInfo, 'About Us Info', 'about_us_info'),
    { prefix: '/about-us-info' },
  );
  await app.register(
    buildWrikeListRoutes(requestors, 'Requestor', 'requestors', {
      wrikeId: z.string().max(100).nullable().optional(),
    }),
    { prefix: '/requestors' },
  );
}