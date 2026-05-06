/**
 * SALES CHANNEL APIs
 *
 *  GET   /api/v1/netsuite/sales-channels
 *  GET   /api/v1/netsuite/sales-channels/:nsId
 *  POST  /api/v1/netsuite/sales-channels
 *  PUT   /api/v1/netsuite/sales-channels/:nsId
 *  PATCH /api/v1/netsuite/sales-channels/:nsId/status
 *
 * Body for POST/PUT:
 *  { "netsuiteInternalId": "10", "name": "Direct", "description": "Direct sales channel" }
 */

import { salesChannels } from '../../../db/schema/index.js';
import { buildDropdownRoutes } from '../_routeBuilder.js';

export default buildDropdownRoutes(salesChannels, 'sales_channels');
