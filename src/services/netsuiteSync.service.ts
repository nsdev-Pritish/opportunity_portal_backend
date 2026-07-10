/**
 * netsuiteSync.service.ts
 *
 * Builds the NetSuite suitelet payload from portal estimate data and posts it.
 * After NetSuite responds, stores the returned internal ID + document number
 * back on the estimates row.
 *
 * Called automatically from estimate.service.ts after create / update.
 * Safe to call even when NS_SUITELET_URL is not configured — it will skip silently.
 *
 * Phase 1: header-level fields.
 * Phase 2: line items.
 * Phase 3: freight groups (payload.freightGroups), built from estimate_freight_groups.
 */

import crypto from 'crypto';
import { eq, and, asc, inArray } from 'drizzle-orm';
import { getDb } from '../config/database.js';
import {
  estimates, estimateLineItems, estimateQuotes,
  subsidiaries, customers, contacts, currencies, projectNames, projectTypes, likelyToClose,
  departments, salesChannels, businessVerticals, businessTypes,
  accountManagers, productDevelopers, hkPartners, opsPartners, compliancePartners,
  clientIncoterms, clientShippingMethods, addresses,
  csItems, vendors, sustainabilityOptions, productClasses, productClassesEu, vendorIncoterms, factories,
  vendorAddresses, componentKitItems,
  closedLostReasons, clientPursuitAlternatives, estimateStatuses,
  estimateFreightGroups,
} from '../db/schema/index.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

// ── OAuth 1.0a TBA header builder ─────────────────────────────────────────────

function buildOAuthHeader(method: string, fullUrl: string): string | null {
  const { NS_ACCOUNT_ID, NS_CONSUMER_KEY, NS_CONSUMER_SECRET, NS_TOKEN_ID, NS_TOKEN_SECRET } = env;
  if (!NS_CONSUMER_KEY || !NS_CONSUMER_SECRET || !NS_TOKEN_ID || !NS_TOKEN_SECRET) return null;

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce     = crypto.randomBytes(16).toString('hex');

  // Per OAuth 1.0a spec: base URL must exclude query string; query params
  // must be merged into the normalized parameter string alongside oauth_* params.
  const urlObj  = new URL(fullUrl);
  const baseUrl = `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}`;

  const urlQueryParams: Record<string, string> = {};
  urlObj.searchParams.forEach((v, k) => { urlQueryParams[k] = v; });

  const oauthParams: Record<string, string> = {
    oauth_consumer_key    : NS_CONSUMER_KEY,
    oauth_nonce           : nonce,
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp       : timestamp,
    oauth_token           : NS_TOKEN_ID,
    oauth_version         : '1.0',
  };

  // Merge URL query params + oauth params, sort, encode
  const paramStr = Object.entries({ ...urlQueryParams, ...oauthParams })
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const baseString = [
    method.toUpperCase(),
    encodeURIComponent(baseUrl),
    encodeURIComponent(paramStr),
  ].join('&');

  const signingKey = `${encodeURIComponent(NS_CONSUMER_SECRET)}&${encodeURIComponent(NS_TOKEN_SECRET)}`;
  const signature  = crypto.createHmac('sha256', signingKey).update(baseString).digest('base64');

  const headerParts = Object.entries({ ...oauthParams, oauth_signature: signature })
    .map(([k, v]) => `${k}="${encodeURIComponent(v)}"`)
    .join(', ');

  return `OAuth realm="${NS_ACCOUNT_ID ?? ''}", ${headerParts}`;
}

// ── Formatting helpers ─────────────────────────────────────────────────────────

function formatNsDate(date: string | null | undefined): string {
  if (!date) return '';
  const [y, m, d] = date.split('-');
  return `${m}/${d}/${y}`;  // MM/DD/YYYY — DB stores zero-padded so no parseInt needed
}

// Convert a stored NS internal ID string → number for NS payload, null if absent
function toNsNum(nsId: string): number | null {
  return nsId ? Number(nsId) : null;
}

// Convert a Drizzle numeric string → number for NS payload, null if absent
function toNum(val: string | number | null | undefined): number | null {
  if (val === null || val === undefined || val === '') return null;
  const n = Number(val);
  return isNaN(n) ? null : n;
}

// ── NS-ID lookup: given a portal FK id, return the netsuiteInternalId string ──

async function getNsId(table: any, portalId: number | null | undefined): Promise<string> {
  if (!portalId) return '';
  const db = getDb();
  const [row] = await db
    .select({ nsId: table.netsuiteInternalId })
    .from(table)
    .where(eq(table.id, portalId))
    .limit(1);
  return row?.nsId ?? '';
}

// ── Build the suitelet payload ─────────────────────────────────────────────────

async function buildNsPayload(estimateId: number, mode: 'create' | 'update' | 'convert', lineItemIds?: number[]) {
  const db = getDb();

  // 1. Fetch estimate header
  const [est] = await db.select().from(estimates).where(eq(estimates.id, estimateId)).limit(1);
  if (!est) throw new Error(`Estimate ${estimateId} not found`);

  // 2. Resolve all header-level FK → NS internal IDs in one parallel batch
  const [
    subsidiaryNsId, customerNsId, contactNsId, projectNameNsId, projectTypeNsId,
    likelyToCloseNsId, currencyNsId,
    deptNsId, channelNsId, bizVerticalNsId, businessTypeNsId,
    acctMgrNsId, hkPartnerNsId, ops1NsId, ops2NsId, complianceNsId,
    shipTermsNsId, shipMethodNsId, shipAddrNsId, billAddrNsId,
    estimateStatusNsId, closedLostReasonNsId, clientPursuitAltNsId,
  ] = await Promise.all([
    getNsId(subsidiaries,                est.subsidiaryId),
    getNsId(customers,                   est.customerId),
    getNsId(contacts,                    est.customerContactId),
    getNsId(projectNames,                est.projectNameId),
    getNsId(projectTypes,                est.projectTypeId),
    getNsId(likelyToClose,               est.likelyToCloseId),
    getNsId(currencies,                  est.sellCurrencyId),
    getNsId(departments,                 est.departmentId),
    getNsId(salesChannels,               est.salesChannelId),
    getNsId(businessVerticals,           est.businessVerticalId),
    getNsId(businessTypes,               est.businessTypeId),
    getNsId(accountManagers,             est.acctManagerId),
    getNsId(hkPartners,                  est.hkPartnerId),
    getNsId(opsPartners,                 est.opsPartner1Id),
    getNsId(opsPartners,                 est.opsPartner2Id),
    getNsId(compliancePartners,          est.compliancePartnerId),
    getNsId(clientIncoterms,             est.clientIncotermsId),
    getNsId(clientShippingMethods,       est.clientShipMethodId),
    getNsId(addresses,                   est.shippingAddressId),
    getNsId(addresses,                   est.billingAddressId),
    getNsId(estimateStatuses,            est.statusId),
    getNsId(closedLostReasons,           est.closedLostReasonId),
    getNsId(clientPursuitAlternatives,   est.clientPursuitAlternativeId),
  ]);

  // Resolve NS IDs for all product developers in parallel
  const prodDevNsIds = await Promise.all(
    (est.productDeveloperIds ?? []).map(id => getNsId(productDevelopers, id))
  );

  // 3. Phase 1 payload — header fields only
  const payload: Record<string, unknown> = {
    mode,
    internalId          : est.netsuiteInternalId ?? '',
    subsidiaryNSId      : subsidiaryNsId,
    customerNSId        : customerNsId,
    customerContactNSId : contactNsId,
    customerPoNS        : est.customerPo ?? '',
    projectNameNSId     : projectNameNsId,
    projectTypeNSId     : projectTypeNsId,
    expectedCloseDateNS : formatNsDate(est.expectedCloseDate),
    promiseDateNS       : formatNsDate(est.promiseDate),
    likelyToCloseNSId   : likelyToCloseNsId,
    sellCurrencyNSId    : currencyNsId,
    projectedTotalAmtNSId: String(est.projectedTotalAmt ?? ''),
    estimatedQtyNSId    : String(est.estimatedQty ?? ''),
    departmentNSId      : deptNsId,
    salesChannelNSId    : channelNsId,
    businessVerticalNSId: bizVerticalNsId,
    businessTypeNSId    : businessTypeNsId,
    acctManagerNSId     : acctMgrNsId,
    productDeveloperNSIds: prodDevNsIds.filter(id => id !== '').map(Number),
    hkPartnerNSId       : hkPartnerNsId,
    opsPartner1NSId     : ops1NsId,
    opsPartner2NSId     : ops2NsId,
    compliancePartnerNSId: complianceNsId,
    clientIncotermsNSId : shipTermsNsId,
    clientShipMethodNSId: shipMethodNsId,
    shippingAddressNS   : shipAddrNsId,
    shipToNS            : est.shipTo ?? '',
    billingAddressNS    : billAddrNsId,
    billToNS            : est.billTo ?? '',
    sampleOnlyOrderNSId : est.sampleOnlyOrder ?? false,
    reOrderNSId         : est.reOrder ?? false,
    deckRequestNS       : est.deckRequest ?? false,
    artSetupRequestNS   : est.artSetupRequest ?? false,
    pkgDeckRequestNS    : est.pkgDeckRequest ?? false,
    pkgArtSetupRequestNS: est.pkgArtSetupRequest ?? false,
    bibleLinkNS                  : est.bibleLink ?? '',
    memoNS                       : est.memo ?? '',
    // Twelve Pays YES/NO flags → custbody_twelve_pays_import_frt / custbody_twelve_pays_ship_to_cust
    twelvePaysImportFrtNS        : est.twelvePaysImportFrt ?? '',
    twelvePaysShipToCustNS       : est.twelvePaysShipToCust ?? '',
    statusNSId                   : estimateStatusNsId,
    closedLostReasonNSId         : closedLostReasonNsId,
    clientPursuitAlternativeNSId : clientPursuitAltNsId,
    projectHoldDateNS            : formatNsDate(est.projectHoldDate),
    notesClosedLostReasonNS      : est.notesClosedLostReason ?? '',
    attachmentsNS                : Array.isArray(est.attachments) ? est.attachments : [],
  };

  // Phase 2 – Line items (for 'convert' mode only the target lineItemIds are sent)
  const lineItemRows = await db.select().from(estimateLineItems)
    .where(
      lineItemIds && lineItemIds.length > 0
        ? inArray(estimateLineItems.id, lineItemIds)
        : eq(estimateLineItems.estimateId, estimateId)
    )
    .orderBy(estimateLineItems.lineNumber);

  if (lineItemRows.length > 0) {
    // Resolve all FK → NS IDs in parallel across all line items (7 lookups per row)
    const lineNsData = await Promise.all(lineItemRows.map(li =>
      Promise.all([
        getNsId(csItems,              li.itemTypeId),            // [0]
        getNsId(vendors,              li.vendorId),               // [1]
        getNsId(currencies,           li.vendorCurrencyId),       // [2]
        getNsId(factories,            li.factoryId),              // [3]
        getNsId(productClasses,       li.productClassId),         // [4]
        getNsId(sustainabilityOptions,li.sustainabilityId),       // [5]
        getNsId(vendorIncoterms,      li.vendorIncotermsId),      // [6]
        Promise.resolve(li.shippingGroupId ?? null),               // [7] text label, not a FK lookup
        getNsId(vendors,              li.shipToVendorId),         // [8]
        getNsId(vendorAddresses,      li.shipToVendorAddrId),     // [9]
        getNsId(componentKitItems,    li.componentKitItemId),     // [10]
        getNsId(productClassesEu,     li.productClassEuId),       // [11]
      ])
    ));

    // Build lookup maps so each row knows its payload line number and its components' line numbers
    const dbIdToLineNum = new Map<number, number>();
    for (let i = 0; i < lineItemRows.length; i++) {
      dbIdToLineNum.set(lineItemRows[i].id, i + 1);
    }
    const parentToComponentLineNums = new Map<number, number[]>();
    for (const li of lineItemRows) {
      if (li.parentLineItemId !== null) {
        const compLineNum = dbIdToLineNum.get(li.id)!;
        const arr = parentToComponentLineNums.get(li.parentLineItemId!) ?? [];
        arr.push(compLineNum);
        parentToComponentLineNums.set(li.parentLineItemId!, arr);
      }
    }

    // 1-based index to match NS suitelet convention
    const lines: Record<string, unknown> = {};
    for (let i = 0; i < lineItemRows.length; i++) {
      const li = lineItemRows[i];
      const [
        itemTypeNsId, vendorNsId, vendorCurrencyNsId, factoryNsId,
        productClassNsId, sustainabilityNsId, vendorIncotermsNsId,
        shippingGroupNsId, shipToVendorNsId, shipToVendorAddrNsId,
        componentKitItemNsId, productClassEuNsId,
      ] = lineNsData[i];

      const isEu = li.countryOfDest === 'EU';

      const isComponent = li.parentLineItemId !== null;

      lines[String(i + 1)] = {
        // NS line internal id for already-synced lines; omitted for brand-new lines
        ...(li.netsuiteInternalId ? { lineId: li.netsuiteInternalId } : {}),
         itemTypeIdNSId         : isComponent ? toNsNum(componentKitItemNsId) : toNsNum(itemTypeNsId),
      shortDescriptionNS     : li.shortDescription ?? '',
      descriptionNS          : li.description ?? '',
      vendorIdNSId           : toNsNum(vendorNsId),
      quantityNS             : toNum(li.quantity),
      sellPricePerUnitNS     : toNum(li.sellPricePerUnit),
      skuMarginPctNS         : toNum(li.skuMarginPct),
      salesAmountNS          : toNum(li.salesAmount),
      excludeNS              : li.exclude ?? false,

      pickupExwFobNS         : toNum(li.pickupExwFob),
      oceanDdp               : toNum(li.oceanDdp),
      airDdp                 : toNum(li.airDdp),

      factoryIdNSId          : toNsNum(factoryNsId),
      vendorCurrencyIdNSId   : toNsNum(vendorCurrencyNsId),
      factoryCostPerUnitNS   : toNum(li.factoryCostPerUnit),
      usdFactoryCostNS       : toNum(li.usdFactoryCost),
      packingCostPerUnitNS   : toNum(li.packingCostPerUnit),
      sampleFeesNS           : toNum(li.sampleFees),
      otherPerUnitNS         : toNum(li.otherPerUnit),
      landedCostPerUnitNS    : toNum(li.landedCostPerUnit),
      extendedLandedCostNS   : toNum(li.extendedLandedCost),
      freightPerUnitNS       : toNum(li.freightPerUnit),
      dutyPctNS              : toNum(li.dutyPct),
      tariffPctNS            : toNum(li.tariffPct),
      tariffMuPctNS          : toNum(li.tariffMuPct),
      otherCostPctNS         : toNum(li.otherCostPct),
      paddingPctNS           : toNum(li.paddingPct),

      productClassIdNSId     : !isEu && productClassNsId ? Number(productClassNsId) : '',
      productClassEuIdNSId   : isEu && productClassEuNsId ? Number(productClassEuNsId) : '',
      sustainabilityIdNSId   : toNsNum(sustainabilityNsId),
      htsCodeNS              : li.htsCode ?? '',
      countryOfDestNSId      : li.countryOfDest ?? '',

      unitsPerCartonNS       : li.unitsPerCarton ?? null,
      dimLCmNS               : toNum(li.dimLCm),
      dimWCmNS               : toNum(li.dimWCm),
      dimHCmNS               : toNum(li.dimHCm),
      weightKgPerCartonNS    : toNum(li.weightKgPerCarton),
      totalCartonsNS         : li.totalCartons ?? null,
      cbmPerCartonNS         : toNum(li.cbmPerCarton),
      totalCbmNS             : toNum(li.totalCbm),
      chargeableWeightKgNS   : toNum(li.chargeableWeightKg),

      shippingGroupIdNSId    : shippingGroupNsId ?? null,
      exFactoryDateNS        : formatNsDate(li.exFactoryDate),
      vendorIncotermsIdNSId  : toNsNum(vendorIncotermsNsId),
      shipToVendorIdNSId     : toNsNum(shipToVendorNsId),
      shipToVendorAddrIdNSId : shipToVendorAddrNsId ? Number(shipToVendorAddrNsId) : '',
      notesNS                : li.notes ?? '',
      imageNS                : li.image ?? null,

        // ── Extended line fields ────────────────────────────────────────────
        selectedNS            : li.selected ?? true,
        ...(!isComponent && parentToComponentLineNums.has(li.id)
          ? { lineComponentsNS: parentToComponentLineNums.get(li.id) }
          : {}),
        previousLineIDNS      : li.previousLineId ?? null,
        additionalFeeInfoNS   : li.additionalFeeInfo ?? '',
        countryOriginNSId     : li.countryOrigin ?? '',
        classNSId             : isEu ? (productClassEuNsId ? Number(productClassEuNsId) : null) : (productClassNsId ? Number(productClassNsId) : null),
        classItemNSId         : isEu ? (productClassEuNsId ? Number(productClassEuNsId) : null) : (productClassNsId ? Number(productClassNsId) : null),
        vendorSKUNS           : li.vendorSku ?? '',
        shippingInstructionNS : li.shippingInstruction ?? '',
        paddingAmountNS       : toNum(li.paddingAmount),
        dutyMarkupAmountNS    : toNum(li.dutyMarkupAmount),
        convertedNS           : li.converted ?? false,
        trueTariffRateNS      : li.trueTariff ?? '',
        freightSelectedGroupNS: li.freightSelectedGroup ?? '',
        freightPOLNS          : li.freightPol ?? '',
        freightPODNS          : li.freightPod ?? '',
        totalFreightCostNS    : toNum(li.totalFreightCost),
        freightCostPerUnitNS  : toNum(li.freightCostPerUnit),
        freightProviderNS     : li.freightProvider ?? '',
        freightNotesNS        : li.freightNotes ?? '',
        excludeFromPrintNS    : li.excludeFromPrint ?? false,
      };
    }
    payload.lines = lines;
  }

  // Phase 3 – Freight groups. itemIds (stored as line-item DB ids) are translated to the
  // 1-based payload line numbers used in `payload.lines`, so NetSuite can resolve membership.
  const freightGroupRows = await db.select().from(estimateFreightGroups)
    .where(eq(estimateFreightGroups.estimateId, estimateId))
    .orderBy(asc(estimateFreightGroups.id));

  if (freightGroupRows.length > 0) {
    const dbIdToLineNum = new Map<number, number>();
    for (let i = 0; i < lineItemRows.length; i++) dbIdToLineNum.set(lineItemRows[i].id, i + 1);

    payload.freightGroups = freightGroupRows.map(g => ({
      groupNameNS      : g.groupName ?? '',
      freightModeNS    : g.freightModeSelected ?? '',
      itemLinesNS      : (g.itemIds ?? [])
        .map(id => dbIdToLineNum.get(id))
        .filter((n): n is number => typeof n === 'number'),
      numItemsNS       : g.numItems ?? null,
      totalCartonsNS   : g.totalCartons ?? null,
      totalCbmNS       : toNum(g.totalCbm),
      totalWeightNS    : toNum(g.totalWeight),

      oceanLclTotalNS  : toNum(g.oceanLclTotal),
      oceanLclPerUnitNS: toNum(g.oceanLclPerUnit),
      oceanLclPOLNS    : g.oceanLclPol ?? '',
      oceanLclPODNS    : g.oceanLclPod ?? '',

      oceanFclTotalNS  : toNum(g.oceanFclTotal),
      oceanFclPerUnitNS: toNum(g.oceanFclPerUnit),
      oceanFclPOLNS    : g.oceanFclPol ?? '',
      oceanFclPODNS    : g.oceanFclPod ?? '',

      airTotalNS       : toNum(g.airTotal),
      airPerUnitNS     : toNum(g.airPerUnit),
      airPOLNS         : g.airPol ?? '',
      airPODNS         : g.airPod ?? '',

      customTotalNS    : toNum(g.customTotal),
      customPerUnitNS  : toNum(g.customPerUnit),
      customProviderNS : g.customProvider ?? '',
      customNotesNS    : g.customNotes ?? '',
    }));
  }

  return payload;
}

// ── Cascade a sync outcome to an estimate's children ────────────────────────────
//
// The estimate header, its line items and its freight groups are pushed as ONE
// suitelet call, so they share a single outcome. Mirroring the header's status onto
// each child row lets the UI show sync state — and, on failure, the same error text —
// per line item / freight group instead of only at the estimate level.
async function markEstimateChildrenSync(
  estimateId: number,
  syncStatus: 'synced' | 'failed',
  syncError : string | null,
): Promise<void> {
  const db = getDb();
  const set: Record<string, unknown> = { syncStatus, syncError };
  if (syncStatus === 'synced') set.syncedAt = new Date();

  await Promise.all([
    db.update(estimateLineItems)
      .set(set as any)
      .where(and(eq(estimateLineItems.estimateId, estimateId), eq(estimateLineItems.isActive, true))),
    db.update(estimateFreightGroups)
      .set(set as any)
      .where(eq(estimateFreightGroups.estimateId, estimateId)),
  ]);
}

// ── Public entry point ────────────────────────────────────────────────────────

export async function syncEstimateToNetsuite(
  estimateId : number,
  mode       : 'create' | 'update' | 'convert' | 'convertToExisting' = 'create',
  opts?      : { quoteId?: number; quoteNsId?: string; lineItemIds?: number[] },
): Promise<void> {
  if (!env.NS_SUITELET_URL) {
    logger.debug({ estimateId }, 'NS_SUITELET_URL not configured — skipping NS sync');
    return;
  }

  const db = getDb();
  const isConvert = mode === 'convert' || mode === 'convertToExisting';

  try {
    // Convert payloads (per NetSuite contract):
    //   New quote        → { mode: 'convert',           oppId }
    //   Add to existing  → { mode: 'convertToExisting', oppId, quoteId }
    let payload: Record<string, unknown>;
    if (isConvert) {
      const [est] = await db.select({ netsuiteInternalId: estimates.netsuiteInternalId })
        .from(estimates).where(eq(estimates.id, estimateId)).limit(1);
      const oppId = est?.netsuiteInternalId ?? '';

      payload = mode === 'convertToExisting'
        ? { mode: 'convertToExisting', oppId, quoteId: opts?.quoteNsId ?? '' }
        : { mode: 'convert', oppId };
    } else {
      payload = await buildNsPayload(estimateId, mode, opts?.lineItemIds);
    }

    // Append mode param — handle URLs that already carry query params (e.g. ?script=&deploy=)
    const url = env.NS_SUITELET_URL.includes('?')
      ? `${env.NS_SUITELET_URL}&mode=${mode}`
      : `${env.NS_SUITELET_URL}?mode=${mode}`;

    // OAuth signature must be computed over the exact request URL (including mode param)
    const authHeader = buildOAuthHeader('POST', url);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authHeader) headers['Authorization'] = authHeader;

    logger.info({
      estimateId, mode, url,
      accountId : env.NS_ACCOUNT_ID,
      authHeader: authHeader ? authHeader.substring(0, 80) + '...' : 'MISSING — credentials not set',
    }, 'Posting estimate to NetSuite suitelet');

    const res = await fetch(url, {
      method : 'POST',
      headers,
      body   : JSON.stringify(payload),
      signal : AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`NS suitelet responded ${res.status}: ${body}`);
    }

    // NS response for create/update: { id, tranId, lineIds }
    // NS response for convert:       { id, quoteId, quoteTranId, lineIds }
    const nsResp = await res.json() as {
      id?            : string;
      internalId?    : string;
      tranId?        : string;
      documentNumber?: string;
      adjustedPipelineAmountNS?: string;
      quoteId?       : string;
      quoteTranId?   : string;
      lineIds?       : (string | number)[] | Record<string, string | number>;
      // Per-line unified Class id NetSuite resolved for each line, keyed by the same
      // 1-based line number used in the outbound `lines` payload (or a positional array).
      resolvedClassIds?: (string | number | null)[] | Record<string, string | number | null>;
    };

    // Use `||` (not `??`) so empty strings fall through to the next candidate — NetSuite
    // sometimes returns tranId: "" when the document number is assigned asynchronously.
    const nsInternalId   = nsResp.id     || nsResp.internalId     || undefined;
    const documentNumber = nsResp.tranId || nsResp.documentNumber || undefined;
    // Adjusted Pipeline is returned by NetSuite on the create/update response.
    const adjustedPipeline = nsResp.adjustedPipelineAmountNS;

    logger.info({
      estimateId,
      mode,
      rawResponse    : nsResp,
      nsInternalId   : nsInternalId   ?? null,
      documentNumber : documentNumber ?? null,
      quoteId        : nsResp.quoteId    ?? null,
      quoteTranId    : nsResp.quoteTranId ?? null,
    }, 'NetSuite suitelet response received');

    if (nsInternalId && !documentNumber) {
      logger.warn({ estimateId, mode, nsInternalId, rawResponse: nsResp },
        'NetSuite returned an internal id but no document number — leaving existing documentNumber untouched');
    }

    // ── For create / update: update the estimate row ──────────────────────────
    if (!isConvert) {
      // Only write fields we actually received — never overwrite a saved internal id /
      // document number with a blank when NetSuite omits it from this response.
      const setData: Record<string, unknown> = {
        syncStatus: 'synced',
        syncError : null,
        syncedAt  : new Date(),
      };
      if (nsInternalId)   setData.netsuiteInternalId = nsInternalId;
      if (documentNumber) setData.documentNumber     = documentNumber;
      // Write back Adjusted Pipeline when NetSuite returns it (skip blank — numeric column).
      if (adjustedPipeline !== undefined && adjustedPipeline !== '') setData.adjustedPipeline = adjustedPipeline;

      await db.update(estimates)
        .set(setData as any)
        .where(eq(estimates.id, estimateId));

      // Cascade the synced outcome to this estimate's line items + freight groups.
      // (Line NS ids are still stamped separately below — this only sets sync state.)
      await markEstimateChildrenSync(estimateId, 'synced', null);
    }

    // ── For convert / convertToExisting: save quote IDs + mark lines converted ─
    if (isConvert && opts?.quoteId) {
      // NS convert response uses { internalId, documentNumber } for the new Quote.
      // Fall back to quoteId/quoteTranId in case the suitelet uses those names.
      const quoteNsId   = nsResp.internalId     || nsResp.quoteId     || undefined;
      const quoteDocNum = nsResp.documentNumber || nsResp.quoteTranId || undefined;

      const quoteSet: Record<string, unknown> = {
        syncStatus: 'synced',
        syncError : null,
        syncedAt  : new Date(),
        updatedAt : new Date(),
      };
      if (quoteNsId)   quoteSet.quoteNetsuiteInternalId = quoteNsId;
      if (quoteDocNum) quoteSet.quoteDocumentNumber     = quoteDocNum;

      await db.update(estimateQuotes)
        .set(quoteSet as any)
        .where(eq(estimateQuotes.id, opts.quoteId));

      // Mark all quoted line items as converted
      const targetIds = opts.lineItemIds ?? [];
      if (targetIds.length > 0) {
        await db.update(estimateLineItems)
          .set({ converted: true } as any)
          .where(inArray(estimateLineItems.id, targetIds));
      }

      // Also mark the estimate as synced
      await db.update(estimates)
        .set({ syncStatus: 'synced', syncError: null, syncedAt: new Date() } as any)
        .where(eq(estimates.id, estimateId));
    }

    // ── Store NS line IDs back to each line item ──────────────────────────────
    // Skip for convert modes — those lineIds belong to the Quote, not the estimate
    // line items, so stamping them would corrupt the estimate line NS ids.
    if (!isConvert && nsResp.lineIds && typeof nsResp.lineIds === 'object') {
      // All lines of the estimate (active + soft-deleted), so we know which NS ids are already
      // held. We never select by lineItemIds here — convert modes (the only caller that passes
      // them) are excluded above.
      const lineRows = await db.select({
          id                : estimateLineItems.id,
          netsuiteInternalId: estimateLineItems.netsuiteInternalId,
          isActive          : estimateLineItems.isActive,
        }).from(estimateLineItems)
        .where(eq(estimateLineItems.estimateId, estimateId))
        .orderBy(asc(estimateLineItems.lineNumber));

      // NS line ids it returned, in the order NS provided them.
      const returnedIds = (Array.isArray(nsResp.lineIds)
        ? nsResp.lineIds
        : Object.entries(nsResp.lineIds).sort(([a], [b]) => parseInt(a, 10) - parseInt(b, 10)).map(([, v]) => v)
      ).map(v => String(v)).filter(Boolean);

      // Existing lines already hold their NS id (we sent it; NetSuite keeps it) — leave them
      // alone so adding a line never renumbers the others. Only assign the *fresh* returned ids
      // (not held by any current line) to the *new* lines (active rows with no NS id yet).
      const heldIds  = new Set(lineRows.map(r => r.netsuiteInternalId).filter(Boolean));
      const freshIds = returnedIds.filter(id => !heldIds.has(id));
      const newLines = lineRows.filter(r => r.isActive && !r.netsuiteInternalId);

      if (freshIds.length !== newLines.length) {
        logger.warn({ estimateId, newLineCount: newLines.length, freshIdCount: freshIds.length, returnedIds, heldIds: [...heldIds] },
          'NS returned a different number of new line ids than new lines — some may stay unsynced');
      }

      const assignments = newLines
        .map((row, i) => ({ portalLineId: row.id, nsLineId: freshIds[i] }))
        .filter(a => !!a.nsLineId);

      if (assignments.length > 0) {
        await db.transaction(async (tx) => {
          for (const a of assignments) {
            await tx.update(estimateLineItems)
              .set({ netsuiteInternalId: a.nsLineId } as any)
              .where(eq(estimateLineItems.id, a.portalLineId));
          }
        });
      }

      logger.info({ estimateId, newLines: newLines.length, assigned: assignments.length, lineIds: nsResp.lineIds }, 'New line NS IDs stored');
    }

    // ── Store NetSuite-resolved unified Class ids back to each line item ──────
    // NetSuite resolves the Class per line and returns it as `resolvedClassIds`
    // (keyed by the same 1-based line number as the outbound `lines` payload, or a
    // positional array). Written straight into estimate_line_items.class_id — same
    // read-response-then-write-back pattern as adjustedPipelineAmountNS above.
    if (!isConvert && nsResp.resolvedClassIds && typeof nsResp.resolvedClassIds === 'object') {
      const classLineRows = await db.select({ id: estimateLineItems.id })
        .from(estimateLineItems)
        .where(eq(estimateLineItems.estimateId, estimateId))
        .orderBy(asc(estimateLineItems.lineNumber));

      const classByLineNum: Record<string, string | number | null> = Array.isArray(nsResp.resolvedClassIds)
        ? Object.fromEntries(nsResp.resolvedClassIds.map((v, i) => [String(i + 1), v]))
        : nsResp.resolvedClassIds;

      const classAssignments = classLineRows
        .map((row, i) => ({ portalLineId: row.id, classId: classByLineNum[String(i + 1)] }))
        .filter(a => a.classId !== undefined && a.classId !== null && a.classId !== '');

      if (classAssignments.length > 0) {
        await db.transaction(async (tx) => {
          for (const a of classAssignments) {
            await tx.update(estimateLineItems)
              .set({ classId: Number(a.classId) } as any)
              .where(eq(estimateLineItems.id, a.portalLineId));
          }
        });
      }

      logger.info({ estimateId, assigned: classAssignments.length }, 'Line class ids stored from NetSuite');
    }

    logger.info({ estimateId, mode, nsInternalId, documentNumber, quoteId: nsResp.quoteId }, 'Estimate synced to NetSuite successfully');

  } catch (err: any) {
    const message = err?.message ?? String(err);
    logger.error({ estimateId, mode, error: message }, 'NetSuite sync failed');

    await db.update(estimates)
      .set({ syncStatus: 'failed', syncError: message } as any)
      .where(eq(estimates.id, estimateId));

    // Cascade the failure + error text to this estimate's line items + freight groups
    // so the UI can flag the specific rows that failed to sync.
    await markEstimateChildrenSync(estimateId, 'failed', message);

    // For convert modes also mark the quote row as failed
    if (isConvert && opts?.quoteId) {
      await db.update(estimateQuotes)
        .set({ syncStatus: 'failed', syncError: message, updatedAt: new Date() } as any)
        .where(eq(estimateQuotes.id, opts.quoteId));
    }
  }
}

// ── Delete-mode sync: deactivate soft-deleted line items in NetSuite ────────────
//
// Called after a line item (or a whole estimate) is soft-deleted in the DB. Sends
// ONLY the lines whose is_active was set to false, each carrying its NetSuite line
// internal id, so the suitelet can deactivate them. Payload shape:
//
//   { mode: 'delete', internalId: <estimate NS id>, lines: { "1": { lineId, active: false } } }
//
//   internalId → estimates.netsuite_internal_id
//   lineId     → estimate_line_items.netsuite_internal_id
//
// Lines never synced to NetSuite (no netsuite_internal_id) are skipped — there is
// nothing to deactivate there. If the estimate itself was never synced, the whole
// call is skipped.
export async function deactivateLinesInNetsuite(
  estimateId: number,
  opts?: { lineItemIds?: number[] },
): Promise<void> {
  if (!env.NS_SUITELET_URL) {
    logger.debug({ estimateId }, 'NS_SUITELET_URL not configured — skipping NS delete sync');
    return;
  }

  const db = getDb();
  const mode = 'delete';

  try {
    // The estimate must exist in NetSuite, otherwise there is nothing to deactivate there.
    const [est] = await db.select({ netsuiteInternalId: estimates.netsuiteInternalId })
      .from(estimates).where(eq(estimates.id, estimateId)).limit(1);
    const internalId = est?.netsuiteInternalId ?? '';
    if (!internalId) {
      logger.info({ estimateId }, 'Estimate not in NetSuite yet — nothing to deactivate');
      return;
    }

    // Pull the soft-deleted lines: the specific ids when given (single line-item delete),
    // otherwise every inactive line of the estimate (whole-estimate delete).
    const ids = opts?.lineItemIds ?? [];
    const rows = await db.select({
        id      : estimateLineItems.id,
        lineNsId: estimateLineItems.netsuiteInternalId,
      })
      .from(estimateLineItems)
      .where(
        ids.length > 0
          ? and(inArray(estimateLineItems.id, ids), eq(estimateLineItems.isActive, false))
          : and(eq(estimateLineItems.estimateId, estimateId), eq(estimateLineItems.isActive, false)),
      )
      .orderBy(asc(estimateLineItems.lineNumber));

    // Only lines that exist in NetSuite (have a line internal id) can be deactivated there.
    const deletable = rows.filter(r => r.lineNsId);
    if (deletable.length === 0) {
      logger.info({ estimateId }, 'No NetSuite-synced soft-deleted lines to deactivate — skipping');
      return;
    }

    // 1-based keys to match the NS suitelet convention; send only active:false lines.
    const lines: Record<string, { lineId: string; active: boolean }> = {};
    deletable.forEach((r, i) => {
      lines[String(i + 1)] = { lineId: String(r.lineNsId), active: false };
    });

    const payload = { mode, internalId, lines };

    const url = env.NS_SUITELET_URL.includes('?')
      ? `${env.NS_SUITELET_URL}&mode=${mode}`
      : `${env.NS_SUITELET_URL}?mode=${mode}`;

    const authHeader = buildOAuthHeader('POST', url);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authHeader) headers['Authorization'] = authHeader;

    logger.info({ estimateId, mode, url, internalId, lineCount: deletable.length },
      'Posting delete to NetSuite suitelet');

    const res = await fetch(url, {
      method : 'POST',
      headers,
      body   : JSON.stringify(payload),
      signal : AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`NS suitelet responded ${res.status}: ${body}`);
    }

    // NS confirmed deactivation — mark those lines synced.
    await db.update(estimateLineItems)
      .set({ syncStatus: 'synced', syncError: null, syncedAt: new Date() } as any)
      .where(inArray(estimateLineItems.id, deletable.map(r => r.id)));

    logger.info({ estimateId, mode, lineCount: deletable.length },
      'NetSuite line deactivation synced successfully');

  } catch (err: any) {
    const message = err?.message ?? String(err);
    logger.error({ estimateId, mode, error: message }, 'NetSuite delete sync failed');
    await db.update(estimates)
      .set({ syncStatus: 'failed', syncError: message } as any)
      .where(eq(estimates.id, estimateId));
  }
}
