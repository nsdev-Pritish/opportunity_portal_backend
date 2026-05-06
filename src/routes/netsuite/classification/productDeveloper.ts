/**
 * PRODUCT DEVELOPER APIs
 *
 *  GET   /api/v1/netsuite/product-developers
 *  GET   /api/v1/netsuite/product-developers/:nsId
 *  POST  /api/v1/netsuite/product-developers
 *  PUT   /api/v1/netsuite/product-developers/:nsId
 *  PATCH /api/v1/netsuite/product-developers/:nsId/status
 *
 * Body for POST/PUT:
 *  { "netsuiteInternalId": "456", "name": "Jane Smith" }
 */

import { productDevelopers } from '../../../db/schema/index.js';
import { buildDropdownRoutes } from '../_routeBuilder.js';

export default buildDropdownRoutes(productDevelopers, 'product_developers');
