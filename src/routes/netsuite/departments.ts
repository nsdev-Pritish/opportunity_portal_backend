/**
 * DEPARTMENT APIs
 *
 *  GET   /api/v1/netsuite/departments
 *  GET   /api/v1/netsuite/departments/:nsId
 *  POST  /api/v1/netsuite/departments
 *  PUT   /api/v1/netsuite/departments/:nsId
 *  PATCH /api/v1/netsuite/departments/:nsId/status
 *
 * Body for POST/PUT:
 *  { "netsuiteInternalId": "91", "name": "Sales", "description": "Sales dept" }
 */

import { departments } from '../../db/schema/index.js';
import { buildDropdownRoutes } from './_routeBuilder.js';

export default buildDropdownRoutes(departments, 'departments');
