/**
 * Freight Cost Routes — Sub-router
 * Base prefix: /api/v1/netsuite/freight-cost
 *
 *  /lcl-rates        → lclRates.ts
 *  /fcl-rates        → fclRates.ts
 *  /air-rates        → airRates.ts
 *  /additional-fees  → additionalFees.ts
 */

import { FastifyInstance } from 'fastify';
import lclRateRoutes       from './lclRates.js';
import fclRateRoutes       from './fclRates.js';
import airRateRoutes       from './airRates.js';
import additionalFeeRoutes from './additionalFees.js';

export default async function freightCostRoutes(app: FastifyInstance) {
  await app.register(lclRateRoutes,       { prefix: '/lcl-rates' });
  await app.register(fclRateRoutes,       { prefix: '/fcl-rates' });
  await app.register(airRateRoutes,       { prefix: '/air-rates' });
  await app.register(additionalFeeRoutes, { prefix: '/additional-fees' });
}
