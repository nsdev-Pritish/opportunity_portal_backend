/**
 * ACCOUNT MANAGER APIs
 *
 *  GET   /api/v1/netsuite/account-managers
 *  GET   /api/v1/netsuite/account-managers/:nsId
 *  POST  /api/v1/netsuite/account-managers
 *  PUT   /api/v1/netsuite/account-managers/:nsId
 *  PATCH /api/v1/netsuite/account-managers/:nsId/status
 *
 * Body for POST/PUT:
 *  { "netsuiteInternalId": "123", "name": "John Doe" }
 */

import { accountManagers } from '../../../db/schema/index.js';
import { buildDropdownRoutes } from '../_routeBuilder.js';

export default buildDropdownRoutes(accountManagers, 'account_managers');
