/**
 * BUSINESS TYPE APIs
 *
 *  GET   /api/v1/netsuite/business-types
 *  GET   /api/v1/netsuite/business-types/:nsId
 *  POST  /api/v1/netsuite/business-types
 *  PUT   /api/v1/netsuite/business-types/:nsId
 *  PATCH /api/v1/netsuite/business-types/:nsId/status
 *
 * Body for POST/PUT:
 *  { "netsuiteInternalId": "30", "name": "B2B", "description": "Business to business" }
 */

import { businessTypes } from '../../../db/schema/index.js';
import { buildDropdownRoutes } from '../_routeBuilder.js';

export default buildDropdownRoutes(businessTypes, 'business_types');
