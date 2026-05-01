/**
 * SHIPPING GROUP APIs
 *
 *  GET   /api/v1/netsuite/shipping-groups
 *  GET   /api/v1/netsuite/shipping-groups/:nsId
 *  POST  /api/v1/netsuite/shipping-groups
 *  PUT   /api/v1/netsuite/shipping-groups/:nsId
 *  PATCH /api/v1/netsuite/shipping-groups/:nsId/status
 *
 * Body for POST/PUT:
 *  { "netsuiteInternalId": "1", "name": "Standard", "volumetricDivisor": "5000" }
 */

import { shippingGroups } from '../../db/schema/index.js';
import { buildDropdownRoutes } from './_routeBuilder.js';

export default buildDropdownRoutes(shippingGroups, 'shipping_groups');
