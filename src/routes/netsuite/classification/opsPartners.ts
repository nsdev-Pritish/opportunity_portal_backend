/**
 * OPS PARTNER APIs
 *
 *  GET   /api/v1/netsuite/ops-partners
 *  GET   /api/v1/netsuite/ops-partners/:nsId
 *  POST  /api/v1/netsuite/ops-partners
 *  PUT   /api/v1/netsuite/ops-partners/:nsId
 *  PUT   /api/v1/netsuite/ops-partners/:nsId/status
 *
 * Body for POST/PUT:
 *  { "netsuiteInternalId": "70", "name": "OPS Asia" }
 */

import { opsPartners } from '../../../db/schema/index.js';
import { buildDropdownRoutes } from '../_routeBuilder.js';

export default buildDropdownRoutes(opsPartners, 'ops_partners');
