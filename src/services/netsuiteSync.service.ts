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
 * Phase 1: header-level fields only.
 * Phase 2: uncomment the line-items section when ready.
 * Phase 3: uncomment the freight-groups section when ready.
 */

import crypto from 'crypto';
import { eq, asc, inArray } from 'drizzle-orm';
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
  // Phase 3 – uncomment when freight groups are added:
  // estimateFreightGroups, lclRates, fclRates, airRates,
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
    statusNSId                   : estimateStatusNsId,
    closedLostReasonNSId         : closedLostReasonNsId,
    clientPursuitAlternativeNSId : clientPursuitAltNsId,
    projectHoldDateNS            : formatNsDate(est.projectHoldDate),
    notesClosedLostReasonNS      : est.notesClosedLostReason ?? '',
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

  // Phase 3 – Freight groups (uncomment when ready):
  // const freightGroups = await db.select().from(estimateFreightGroups)
  //   .where(eq(estimateFreightGroups.estimateId, estimateId))
  //   .orderBy(estimateFreightGroups.sortOrder);
  // payload.freightGroups = freightGroups.map(g => ({ ... }));

  return payload;
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
      quoteId?       : string;
      quoteTranId?   : string;
      lineIds?       : (string | number)[] | Record<string, string | number>;
    };

    const nsInternalId   = nsResp.id          ?? nsResp.internalId;
    const documentNumber = nsResp.tranId       ?? nsResp.documentNumber;

    logger.info({
      estimateId,
      mode,
      rawResponse    : nsResp,
      nsInternalId   : nsInternalId   ?? null,
      documentNumber : documentNumber ?? null,
      quoteId        : nsResp.quoteId    ?? null,
      quoteTranId    : nsResp.quoteTranId ?? null,
    }, 'NetSuite suitelet response received');

    // ── For create / update: update the estimate row ──────────────────────────
    if (!isConvert) {
      await db.update(estimates)
        .set({
          netsuiteInternalId: nsInternalId   ?? undefined,
          documentNumber    : documentNumber ?? undefined,
          syncStatus        : 'synced',
          syncError         : null,
          syncedAt          : new Date(),
        } as any)
        .where(eq(estimates.id, estimateId));
    }

    // ── For convert / convertToExisting: save quote IDs + mark lines converted ─
    if (isConvert && opts?.quoteId) {
      // NS convert response uses { internalId, documentNumber } for the new Quote.
      // Fall back to quoteId/quoteTranId in case the suitelet uses those names.
      const quoteNsId   = nsResp.internalId    ?? nsResp.quoteId;
      const quoteDocNum = nsResp.documentNumber ?? nsResp.quoteTranId;

      await db.update(estimateQuotes)
        .set({
          quoteNetsuiteInternalId: quoteNsId   ?? undefined,
          quoteDocumentNumber    : quoteDocNum ?? undefined,
          syncStatus             : 'synced',
          syncError              : null,
          syncedAt               : new Date(),
          updatedAt              : new Date(),
        } as any)
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
      const lineRows = opts?.lineItemIds && opts.lineItemIds.length > 0
        ? await db.select({ id: estimateLineItems.id }).from(estimateLineItems)
            .where(inArray(estimateLineItems.id, opts.lineItemIds))
            .orderBy(asc(estimateLineItems.lineNumber))
        : await db.select({ id: estimateLineItems.id }).from(estimateLineItems)
            .where(eq(estimateLineItems.estimateId, estimateId))
            .orderBy(asc(estimateLineItems.lineNumber));

      const lineIdsArray = Array.isArray(nsResp.lineIds)
        ? nsResp.lineIds
        : Object.entries(nsResp.lineIds)
            .reduce<(string | number)[]>((acc, [k, v]) => { acc[parseInt(k, 10) - 1] = v; return acc; }, []);

      await Promise.all(
        lineIdsArray.map((nsLineId, idx) => {
          const portalLineId = lineRows[idx]?.id;
          if (!portalLineId || !nsLineId) return Promise.resolve();
          return db.update(estimateLineItems)
            .set({ netsuiteInternalId: String(nsLineId) } as any)
            .where(eq(estimateLineItems.id, portalLineId));
        }),
      );

      logger.info({ estimateId, lineCount: lineRows.length, lineIds: nsResp.lineIds }, 'Line item NS IDs stored');
    }

    logger.info({ estimateId, mode, nsInternalId, documentNumber, quoteId: nsResp.quoteId }, 'Estimate synced to NetSuite successfully');

  } catch (err: any) {
    const message = err?.message ?? String(err);
    logger.error({ estimateId, mode, error: message }, 'NetSuite sync failed');

    await db.update(estimates)
      .set({ syncStatus: 'failed', syncError: message } as any)
      .where(eq(estimates.id, estimateId));

    // For convert modes also mark the quote row as failed
    if (isConvert && opts?.quoteId) {
      await db.update(estimateQuotes)
        .set({ syncStatus: 'failed', syncError: message, updatedAt: new Date() } as any)
        .where(eq(estimateQuotes.id, opts.quoteId));
    }
  }
}
