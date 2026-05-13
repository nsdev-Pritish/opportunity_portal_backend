/**
 * HK PARTNER APIs
 *
 *  GET   /api/v1/netsuite/hk-partners
 *  GET   /api/v1/netsuite/hk-partners/:nsId
 *  POST  /api/v1/netsuite/hk-partners
 *  PUT   /api/v1/netsuite/hk-partners/:nsId
 *  PUT   /api/v1/netsuite/hk-partners/:nsId/status
 *
 * Body for POST/PUT:
 *  { "netsuiteInternalId": "60", "name": "HK Trading Co" }
 */

import { hkPartners } from '../../../db/schema/index.js';
import { buildDropdownRoutes } from '../_routeBuilder.js';

export default buildDropdownRoutes(hkPartners, 'hk_partners');
