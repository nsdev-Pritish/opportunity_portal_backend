/**
 * Cost Sheet Routes — Sub-router
 * Base prefix: /api/v1/netsuite/cost-sheet
 *
 *  /factory-names    → factoryNames.ts
 *  /product-classes  → productClasses.ts
 *  /sustainability   → sustainability.ts
 *  /vendors          → vendors.ts
 *  /vendor-addresses  → vendorAddresses.ts
 *  /vendor-incoterms  → vendorIncoterms.ts
 *  /items             → csItems.ts
 */

import { FastifyInstance } from 'fastify';
import factoryNameRoutes    from './factoryNames.js';
import productClassRoutes   from './productClasses.js';
import sustainabilityRoutes from './sustainability.js';
import vendorRoutes         from './vendors.js';
import vendorAddressRoutes  from './vendorAddresses.js';
import vendorIncotermRoutes from './vendorIncoterms.js';
import csItemRoutes         from './csItems.js';

export default async function costSheetRoutes(app: FastifyInstance) {
  await app.register(factoryNameRoutes,    { prefix: '/factory-names' });
  await app.register(productClassRoutes,   { prefix: '/product-classes' });
  await app.register(sustainabilityRoutes, { prefix: '/sustainability' });
  await app.register(vendorRoutes,         { prefix: '/vendors' });
  await app.register(vendorAddressRoutes,  { prefix: '/vendor-addresses' });
  await app.register(vendorIncotermRoutes, { prefix: '/vendor-incoterms' });
  await app.register(csItemRoutes,         { prefix: '/items' });
}
