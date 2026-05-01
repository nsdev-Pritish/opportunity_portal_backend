/**
 * PRODUCT CLASS APIs
 *
 *  GET   /api/v1/netsuite/product-classes
 *  GET   /api/v1/netsuite/product-classes/:nsId
 *  POST  /api/v1/netsuite/product-classes
 *  PUT   /api/v1/netsuite/product-classes/:nsId
 *  PATCH /api/v1/netsuite/product-classes/:nsId/status
 *
 * Body for POST/PUT:
 *  { "netsuiteInternalId": "1", "name": "Bags", "tariffDefaultPct": "10" }
 */

import { productClasses } from '../../db/schema/index.js';
import { buildDropdownRoutes } from './_routeBuilder.js';

export default buildDropdownRoutes(productClasses, 'product_classes');
