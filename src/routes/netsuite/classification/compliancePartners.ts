/**
 * COMPLIANCE PARTNER APIs
 *
 *  GET   /api/v1/netsuite/compliance-partners
 *  GET   /api/v1/netsuite/compliance-partners/:nsId
 *  POST  /api/v1/netsuite/compliance-partners
 *  PUT   /api/v1/netsuite/compliance-partners/:nsId
 *  PATCH /api/v1/netsuite/compliance-partners/:nsId/status
 *
 * Body for POST/PUT:
 *  { "netsuiteInternalId": "80", "name": "SGS Global" }
 */

import { compliancePartners } from '../../../db/schema/index.js';
import { buildDropdownRoutes } from '../_routeBuilder.js';

export default buildDropdownRoutes(compliancePartners, 'compliance_partners');
