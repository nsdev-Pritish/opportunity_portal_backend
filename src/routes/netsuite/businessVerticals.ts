/**
 * BUSINESS VERTICAL APIs
 *
 *  GET   /api/v1/netsuite/business-verticals
 *  GET   /api/v1/netsuite/business-verticals/:nsId
 *  POST  /api/v1/netsuite/business-verticals
 *  PUT   /api/v1/netsuite/business-verticals/:nsId
 *  PATCH /api/v1/netsuite/business-verticals/:nsId/status
 *
 * Body for POST/PUT:
 *  { "netsuiteInternalId": "20", "name": "Retail", "description": "Retail vertical" }
 */

import { businessVerticals } from '../../db/schema/index.js';
import { buildDropdownRoutes } from './_routeBuilder.js';

export default buildDropdownRoutes(businessVerticals, 'business_verticals');
