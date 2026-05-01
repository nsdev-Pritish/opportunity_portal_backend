/**
 * ITEM TYPE APIs
 *
 *  GET   /api/v1/netsuite/item-types
 *  GET   /api/v1/netsuite/item-types/:nsId
 *  POST  /api/v1/netsuite/item-types
 *  PUT   /api/v1/netsuite/item-types/:nsId
 *  PATCH /api/v1/netsuite/item-types/:nsId/status
 *
 * Body for POST/PUT:
 *  { "netsuiteInternalId": "1", "name": "Apparel", "description": "Clothing items", "requiresHts": true }
 */

import { itemTypes } from '../../db/schema/index.js';
import { buildDropdownRoutes } from './_routeBuilder.js';

export default buildDropdownRoutes(itemTypes, 'item_types');
