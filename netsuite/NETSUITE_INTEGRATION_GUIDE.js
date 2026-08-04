/**
 * ════════════════════════════════════════════════════════════════
 *  PRISM API — NetSuite SuiteScript Integration Guide
 *  Give this file to your NetSuite developer.
 * ════════════════════════════════════════════════════════════════
 *
 *  Base URL:  https://your-prism-domain.com
 *  Auth:      Every request must include header: X-API-Key: <NS_API_KEY>
 *
 *  KEY RULE:
 *  Every record you create/update must include "netsuiteInternalId"
 *  which is the NS internalId of that record.
 *  This prevents duplicates and links the NS record to the portal record.
 */


// ════════════════════════════════════════════════════════════════
//  CONFIGURATION  — set once in a SuiteScript library file
// ════════════════════════════════════════════════════════════════

var PRISM_CONFIG = {
  baseUrl: 'https://your-prism-domain.com/api/v1/netsuite',
  apiKey:  'paste-your-NS_API_KEY-value-here',
};


// ════════════════════════════════════════════════════════════════
//  HELPER — makes an authenticated request to PRISM API
// ════════════════════════════════════════════════════════════════

/**
 * @param {string} method  - GET, POST, PUT, PATCH, DELETE
 * @param {string} path    - e.g. '/dropdowns/customers'
 * @param {Object} [body]  - request body for POST/PUT/PATCH
 * @returns {Object} parsed JSON response
 */
function prismRequest(method, path, body) {
  var https   = require('/SuiteScripts/https');   // or use N/https in NS 2.x
  var url     = PRISM_CONFIG.baseUrl + path;

  var options = {
    url: url,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key':    PRISM_CONFIG.apiKey,
    },
  };

  if (body) options.body = JSON.stringify(body);

  var response;
  switch (method.toUpperCase()) {
    case 'GET':    response = https.get(options);    break;
    case 'POST':   response = https.post(options);   break;
    case 'PUT':    response = https.put(options);    break;
    case 'PATCH':  response = https.patch(options);  break;
    case 'DELETE': response = https.delete(options); break;
  }

  if (response.code < 200 || response.code >= 300) {
    log.error('PRISM API error', 'Status: ' + response.code + ' Body: ' + response.body);
    throw new Error('PRISM API call failed: ' + response.code);
  }

  return JSON.parse(response.body);
}


// ════════════════════════════════════════════════════════════════
//  SECTION 1 — DROPDOWN / MASTER DATA
// ════════════════════════════════════════════════════════════════

/**
 * EXAMPLE 1A — Create a Customer in PRISM when created in NetSuite
 *
 * Trigger: User Event Script (afterSubmit) on Customer record
 * Type: UserEventScript
 */
function afterSubmitCustomer(context) {
  var record = context.newRecord;

  // Only run on CREATE or EDIT
  if (context.type !== context.UserEventType.CREATE &&
      context.type !== context.UserEventType.EDIT) return;

  var payload = {
    netsuiteInternalId: String(record.id),          // NS internalId — REQUIRED
    name:  record.getValue({ fieldId: 'companyname' }),
    email: record.getValue({ fieldId: 'email' }),
    phone: record.getValue({ fieldId: 'phone' }),
  };

  // POST creates if new, updates if same netsuiteInternalId already exists
  var result = prismRequest('POST', '/dropdowns/customers', payload);
  log.debug('PRISM customer synced', JSON.stringify(result));
}


/**
 * EXAMPLE 1B — Update a Customer when edited in NetSuite
 * Same function handles both create and edit — the API is idempotent.
 * (See afterSubmitCustomer above — it works for both CREATE and EDIT)
 */


/**
 * EXAMPLE 1C — Deactivate a Customer when inactivated in NetSuite
 *
 * Trigger: User Event Script (afterSubmit) on Customer record
 */
function afterSubmitCustomerStatus(context) {
  var record   = context.newRecord;
  var oldRecord = context.oldRecord;

  // Detect inactive toggle change
  var wasActive = !oldRecord.getValue({ fieldId: 'isinactive' });
  var isActive  = !record.getValue({ fieldId: 'isinactive' });

  if (wasActive === isActive) return; // no change

  var nsId = String(record.id);
  prismRequest('PATCH', '/dropdowns/customers/' + nsId + '/status', {
    isActive: isActive,
  });

  log.debug('PRISM customer status updated', nsId + ' → isActive=' + isActive);
}


/**
 * EXAMPLE 1D — Sync all dropdown entities (use same pattern for each)
 *
 * Entities available:
 *   customers, contacts, addresses, currencies, project_types,
 *   likely_to_close, departments, sales_channels, business_verticals,
 *   business_types, employees, hk_partners, ops_partners,
 *   compliance_partners, incoterms, shipping_methods, vendors,
 *   vendor_addresses, factories, item_types, product_classes,
 *   sustainability_options, shipping_groups
 */

// Vendor — same pattern as customer
function afterSubmitVendor(context) {
  var record = context.newRecord;
  if (context.type !== context.UserEventType.CREATE &&
      context.type !== context.UserEventType.EDIT) return;

  prismRequest('POST', '/dropdowns/vendors', {
    netsuiteInternalId: String(record.id),
    name:  record.getValue({ fieldId: 'companyname' }),
    email: record.getValue({ fieldId: 'email' }),
  });
}

// Employee — same pattern
function afterSubmitEmployee(context) {
  var record = context.newRecord;
  if (context.type !== context.UserEventType.CREATE &&
      context.type !== context.UserEventType.EDIT) return;

  prismRequest('POST', '/dropdowns/employees', {
    netsuiteInternalId: String(record.id),
    firstName: record.getValue({ fieldId: 'firstname' }),
    lastName:  record.getValue({ fieldId: 'lastname' }),
    email:     record.getValue({ fieldId: 'email' }),
  });
}


// ════════════════════════════════════════════════════════════════
//  SECTION 2 — ESTIMATES
// ════════════════════════════════════════════════════════════════

/**
 * EXAMPLE 2A — Create an Estimate in PRISM when saved in NetSuite
 *
 * Trigger: User Event Script (afterSubmit) on Estimate/Opportunity record
 *
 * IMPORTANT: Before sending the estimate, the customer MUST already exist
 * in PRISM. Make sure the Customer sync (Section 1) runs first.
 */
function afterSubmitEstimate(context) {
  var record = context.newRecord;

  if (context.type !== context.UserEventType.CREATE &&
      context.type !== context.UserEventType.EDIT) return;

  // Build estimate payload
  // Use *NsId fields to pass NS internalIds — PRISM resolves them to portal FKs
  var payload = {
    netsuiteInternalId: String(record.id),           // REQUIRED
    projectName:        record.getValue({ fieldId: 'custbody_project_name' }),
    customerNsId:       String(record.getValue({ fieldId: 'entity' })),
    customerPo:         record.getValue({ fieldId: 'custbody_customer_po' }),
    expectedCloseDate:  record.getValue({ fieldId: 'expectedclosedate' }),
    projectedTotalAmt:  String(record.getValue({ fieldId: 'custbody_projected_total' }) || '0'),
    memo:               record.getValue({ fieldId: 'memo' }),

    // Classification fields — pass NS internalId of each lookup value
    departmentNsId:       String(record.getValue({ fieldId: 'department' }) || ''),
    acctManagerNsId:      String(record.getValue({ fieldId: 'custbody_acct_manager' }) || ''),
    salesChannelNsId:     String(record.getValue({ fieldId: 'custbody_sales_channel' }) || ''),
    businessVerticalNsId: String(record.getValue({ fieldId: 'custbody_biz_vertical' }) || ''),
    sellCurrencyNsId:     String(record.getValue({ fieldId: 'currency' }) || ''),

    // Checkbox fields
    deckRequest:        record.getValue({ fieldId: 'custbody_deck_request' }),
    artSetupRequest:    record.getValue({ fieldId: 'custbody_art_setup' }),
  };

  // POST = create or update (idempotent on netsuiteInternalId)
  var result = prismRequest('POST', '/estimates', payload);
  log.debug('PRISM estimate synced', 'Portal ID: ' + result.id);

  // After header is saved, sync line items (cost sheet)
  syncLineItems(record, result.id, String(record.id));
}


/**
 * EXAMPLE 2B — Sync line items (cost sheet rows)
 */
function syncLineItems(record, portalEstimateId, nsEstimateId) {
  var lineCount = record.getLineCount({ sublistId: 'item' });
  if (lineCount <= 0) return;

  var items = [];

  for (var i = 0; i < lineCount; i++) {
    items.push({
      netsuiteInternalId: nsEstimateId + '_line_' + i,  // unique per line
      shortDescription:   record.getSublistValue({ sublistId: 'item', fieldId: 'description', line: i }),
      quantity:           String(record.getSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i }) || '0'),
      sellPricePerUnit:   String(record.getSublistValue({ sublistId: 'item', fieldId: 'rate', line: i }) || '0'),
      factoryCostPerUnit: String(record.getSublistValue({ sublistId: 'item', fieldId: 'custcol_factory_cost', line: i }) || '0'),
      tariffPct:          String(record.getSublistValue({ sublistId: 'item', fieldId: 'custcol_tariff_pct', line: i }) || '10'),
      countryOfOrigin:    record.getSublistValue({ sublistId: 'item', fieldId: 'custcol_country_origin', line: i }),
      htsCode:            record.getSublistValue({ sublistId: 'item', fieldId: 'custcol_hts_code', line: i }),
    });
  }

  // Use bulk endpoint for multiple items
  prismRequest('POST', '/estimates/' + nsEstimateId + '/line-items/bulk', {
    items: items,
  });

  log.debug('PRISM line items synced', items.length + ' items for estimate ' + nsEstimateId);
}


/**
 * EXAMPLE 2C — Update estimate status / fields when changed
 */
function updateEstimateStatus(context) {
  var record = context.newRecord;
  var nsId   = String(record.id);

  prismRequest('PUT', '/estimates/' + nsId, {
    memo:   record.getValue({ fieldId: 'memo' }),
    status: record.getValue({ fieldId: 'status' }),
  });
}


/**
 * EXAMPLE 2D — Delete/deactivate estimate
 */
function afterDeleteEstimate(context) {
  var record = context.oldRecord;
  var nsId   = String(record.id);

  prismRequest('DELETE', '/estimates/' + nsId);
  log.debug('PRISM estimate deactivated', nsId);
}


// ════════════════════════════════════════════════════════════════
//  SECTION 2.5 — BULK QUOTE SYNC (backfill every existing NS quote)
//
//  POST /api/v1/netsuite/estimate-quotes/sync-all
//
//  One-time (or scheduled) push of EVERY Quote that already exists in
//  NetSuite. It is a bulk UPSERT keyed on quoteInternalId, so re-running it
//  never creates duplicates — it refreshes the rows it already has.
//
//  Send at most 2000 quotes per call. Add ?dryRun=true to see exactly what
//  would be created/updated without writing anything — always run that first.
//
//  Response (201 all good / 207 some records failed):
//  { total, successCount, failureCount, created, updated,
//    lineItemsMarkedConverted, succeeded: [...], failed: [...] }
//
//  IMPORTANT: the parent Estimate must already exist in PRISM. A quote whose
//  estimate is missing lands in failed[] with code ESTIMATE_NOT_FOUND — the
//  rest of the batch is still written. Run the Estimate sync first.
// ════════════════════════════════════════════════════════════════

/**
 * EXAMPLE 2E — Backfill all quotes from a saved search
 *
 * Trigger: Scheduled Script or Map/Reduce over a Quote saved search.
 * Pages the results and posts them in chunks of 500.
 */
function syncAllQuotesToPrism() {
  var search = require('N/search');

  var quoteSearch = search.create({
    type: search.Type.ESTIMATE,          // NS "Quote" transactions
    filters: [['mainline', 'is', 'T']],
    columns: ['internalid', 'tranid', 'custbody_created_from_estimate'],
  });

  var batch = [];
  var CHUNK = 500;
  var totals = { created: 0, updated: 0, failed: 0 };

  quoteSearch.run().each(function (result) {
    batch.push({
      quoteInternalId    : String(result.id),
      quoteDocumentNumber: result.getValue('tranid'),

      // Parent estimate — send the internal id when you have it, otherwise the
      // document number ("EST0008946"); PRISM resolves either one.
      estimateInternalId : String(result.getValue('custbody_created_from_estimate') || ''),
      // estimateDocumentNumber: result.getText('custbody_created_from_estimate'),

      status             : 'active',     // or 'replaced'
      lineItemInternalIds: [],           // NS ids of the estimate lines this quote covers
    });

    if (batch.length >= CHUNK) {
      postQuoteChunk(batch, totals);
      batch = [];
    }
    return true;                          // keep iterating
  });

  if (batch.length) postQuoteChunk(batch, totals);

  log.audit('PRISM quote backfill complete', JSON.stringify(totals));
}

function postQuoteChunk(quotes, totals) {
  // Drop records with no parent reference — PRISM would reject them anyway.
  var payload = quotes.filter(function (q) {
    return q.estimateInternalId || q.estimateDocumentNumber;
  });
  if (!payload.length) return;

  var res = prismRequest('POST', '/estimate-quotes/sync-all', payload);

  totals.created += res.created;
  totals.updated += res.updated;
  totals.failed  += res.failureCount;

  if (res.failureCount) {
    // failed[] = [{ index, quoteInternalId, error, code, statusCode }]
    log.error('PRISM quote sync — failed records', JSON.stringify(res.failed));
  }
}


// ════════════════════════════════════════════════════════════════
//  SECTION 3 — READING DROPDOWNS FROM PRISM INTO NS FORM
//  (optional — if NS form needs to show portal data)
// ════════════════════════════════════════════════════════════════

/**
 * EXAMPLE 3A — Load all dropdowns from PRISM to populate a Suitelet form
 */
function loadDropdownsForForm() {
  var dropdowns = prismRequest('GET', '/dropdowns');

  // dropdowns.customers = [{ portalId, nsInternalId, name, isActive }, ...]
  // dropdowns.departments = [...]
  // etc.

  return dropdowns;
}

/**
 * EXAMPLE 3B — Load scoped contacts for a specific customer
 * (contacts are filtered by customer)
 */
function loadContactsForCustomer(customerNsId) {
  // First get the portal customer
  var customers = prismRequest('GET', '/dropdowns/customers');
  var customer  = customers.find(function(c) { return c.nsInternalId === String(customerNsId); });
  if (!customer) return [];

  // Get contacts scoped to that customer (using portal id as scopeId)
  var contacts = prismRequest('GET', '/dropdowns/contacts?scopeId=' + customer.id);
  return contacts;
}


// ════════════════════════════════════════════════════════════════
//  SECTION 4 — NETSUIT 2.x MODULE SYNTAX (modern SuiteScript)
// ════════════════════════════════════════════════════════════════

/**
 * If your NS version uses SuiteScript 2.x (recommended), use N/https module:
 */

define(['N/https', 'N/log', 'N/record'], function(https, log, record) {

  var BASE_URL = 'https://your-prism-domain.com/api/v1/netsuite';
  var API_KEY  = 'paste-NS_API_KEY-here';

  function prismCall(method, path, body) {
    var options = {
      url: BASE_URL + path,
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': API_KEY,
      },
    };

    if (body) options.body = JSON.stringify(body);

    var response = https[method.toLowerCase()](options);

    if (response.code < 200 || response.code >= 300) {
      log.error({ title: 'PRISM Error', details: response.body });
      throw new Error('PRISM API failed: ' + response.code);
    }

    return JSON.parse(response.body);
  }

  // afterSubmit entry point
  function afterSubmit(context) {
    var rec = context.newRecord;

    if (context.type === context.UserEventType.CREATE ||
        context.type === context.UserEventType.EDIT) {

      prismCall('POST', '/dropdowns/customers', {
        netsuiteInternalId: String(rec.id),
        name:  rec.getValue('companyname'),
        email: rec.getValue('email'),
      });
    }
  }

  return { afterSubmit: afterSubmit };
});


// ════════════════════════════════════════════════════════════════
//  SECTION 5 — RESPONSE SHAPES
//  What PRISM returns on each call
// ════════════════════════════════════════════════════════════════

/*
POST /dropdowns/customers
→ 201 Created
{
  "id": 42,                          ← portal auto-increment id
  "netsuiteInternalId": "1234",      ← the nsId you sent
  "name": "Acme Corp",
  "email": "...",
  "isActive": true,
  "source": "netsuite",
  "syncStatus": "synced",
  "createdAt": "2025-01-15T10:00:00Z"
}

PUT /dropdowns/customers/1234
→ 200 OK
{ same shape as above, updated fields }

PATCH /dropdowns/customers/1234/status
→ 200 OK
{ "id": 42, "isActive": false }

POST /estimates
→ 201 Created
{
  "id": 7,
  "netsuiteInternalId": "EST-001",
  "projectName": "Q3 Promo",
  "customerId": 42,           ← portal FK id (resolved from customerNsId)
  "status": "draft",
  ...all other fields
}

POST /estimate-quotes/sync-all
→ 201 Created (all records OK)  ·  207 Multi-Status (some failed)
{
  "dryRun": false,
  "total": 500,
  "successCount": 498,
  "failureCount": 2,
  "created": 471,
  "updated": 27,
  "lineItemsMarkedConverted": 1204,
  "durationMs": 3820,
  "succeeded": [
    { "index": 0, "quoteInternalId": "5001", "quoteDocumentNumber": "QT0005001",
      "action": "created", "quoteId": 310, "estimateId": 8410, "updatedLineItems": 3 }
  ],
  "failed": [
    { "index": 12, "quoteInternalId": "5013",
      "error": "Parent estimate '1099' not found in the portal — sync the estimate first",
      "code": "ESTIMATE_NOT_FOUND", "statusCode": 404 }
  ]
}
   action: "created" | "updated" | "adopted"   (dry run: "would_create" | "would_update")
   "adopted" = the row already existed from an OTB conversion whose NetSuite
   write-back never completed; the sync attached the NS quote id to it.

GET /estimate-quotes?page=1&limit=50&estimateInternalId=1001&status=active
→ 200 OK
{ "data": [ { "id", "quoteInternalId", "quoteDocumentNumber", "status",
              "syncStatus", "syncedAt", "estimateId", "estimateInternalId",
              "estimateDocumentNumber", "createdAt" } ],
  "page": 1, "limit": 50, "total": 83 }

GET /dropdowns
→ 200 OK
{
  "currencies": [
    { "id": 1, "nsInternalId": "1", "code": "USD", "name": "US Dollar", "isActive": true }
  ],
  "departments": [ ... ],
  "sales_channels": [ ... ],
  ...all dropdown entities
}
*/
