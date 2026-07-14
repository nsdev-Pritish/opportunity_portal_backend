/**
 * otbConvert.service.ts
 *
 * SELF-CONTAINED service for the "Convert to OTB" button on the estimate-ADD screen.
 *
 * It creates a brand-new estimate AND converts it to a Quote in one synchronous request:
 *   1. Insert the estimate + line items locally.
 *   2. Create the estimate in NetSuite (await) → save its internal id + document number.
 *   3. Create the quote in NetSuite (await)    → save the quote internal id + document number.
 *
 * Unlike estimate.service.ts (which fires the NS sync in the background) this runs the chain
 * sequentially, because the convert step needs the estimate's NS internal id (oppId), which only
 * exists after the create-sync completes.
 *
 * NOTE: This module is intentionally standalone — it does NOT call createEstimateWithItems,
 * convertEstimateToOtb, or syncEstimateToNetsuite. All DB-insert and NetSuite helpers below are
 * private copies so this flow can evolve without touching the existing create/convert path.
 */

import crypto from 'crypto';
import { eq, and, inArray } from 'drizzle-orm';
import { getDb } from '../config/database.js';
import {
  estimates, estimateLineItems, estimateQuotes,
  subsidiaries, customers, contacts, currencies, projectNames, projectTypes, likelyToClose,
  departments, salesChannels, businessVerticals, businessTypes,
  accountManagers, productDevelopers, hkPartners, opsPartners, compliancePartners,
  clientIncoterms, clientShippingMethods, addresses,
  csItems, vendors, sustainabilityOptions, productClasses, productClassesEu, vendorIncoterms, factories,
  vendorAddresses, componentKitItems,
  closedLostReasons, clientPursuitAlternatives, estimateStatuses, esStatus,
  estimateFreightGroups,
} from '../db/schema/index.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { AppError } from '../utils/errors.js';

type RawLineItem = Record<string, unknown> & { components?: Record<string, unknown>[] };

const CHUNK = 100;

// ════════════════════════════════════════════════════════════════════════════
//  DB: insert estimate line items (own copy of the 2-pass parent/component insert)
// ════════════════════════════════════════════════════════════════════════════

async function otbInsertLineItems(
  tx: any,
  estimateId: number,
  items: RawLineItem[],
): Promise<{ parents: any[]; components: any[] }> {
  if (items.length === 0) return { parents: [], components: [] };

  const parentValues = items.map((item, i) => {
    const { components: _c, ...rest } = item;
    return { ...rest, estimateId, lineNumber: i + 1, parentLineItemId: null, sortOrder: i };
  });

  const parents: any[] = [];
  for (let i = 0; i < parentValues.length; i += CHUNK) {
    const rows = await tx.insert(estimateLineItems)
      .values(parentValues.slice(i, i + CHUNK) as any)
      .returning();
    parents.push(...rows);
  }

  let lineCounter = parentValues.length + 1;
  const componentValues: any[] = [];
  for (let i = 0; i < items.length; i++) {
    const comps = items[i].components ?? [];
    for (let j = 0; j < comps.length; j++) {
      componentValues.push({
        ...comps[j],
        estimateId,
        lineNumber: lineCounter++,
        parentLineItemId: parents[i].id,
        sortOrder: j,
      });
    }
  }

  const components: any[] = [];
  for (let i = 0; i < componentValues.length; i += CHUNK) {
    const rows = await tx.insert(estimateLineItems)
      .values(componentValues.slice(i, i + CHUNK) as any)
      .returning();
    components.push(...rows);
  }

  return { parents, components };
}

// ── Freight groups (own copy; OTB create is always a fresh estimate) ──────────
// group.itemIds carry 0-based indices into the lineItems array; translate to the inserted
// parent DB ids, store them on the group, and set freight_group_id on each member line.
async function otbInsertFreightGroups(
  tx: any,
  estimateId: number,
  groups: Record<string, unknown>[],
  parents: any[],
): Promise<void> {
  if (!groups || groups.length === 0) return;
  for (let idx = 0; idx < groups.length; idx++) {
    const { itemIds: rawIdx, ...rest } = groups[idx] as Record<string, unknown>;
    const memberIds: number[] = Array.isArray(rawIdx)
      ? (rawIdx as number[]).map(i => parents[i]?.id).filter((v): v is number => typeof v === 'number')
      : [];
    const [group] = await tx.insert(estimateFreightGroups)
      .values({
        ...rest,
        estimateId,
        groupName: (rest.groupName as string) ?? `Group ${idx + 1}`,
        itemIds: memberIds,
        numItems: (rest.numItems as number) ?? memberIds.length,
        updatedAt: new Date(),
      } as any)
      .returning();
    if (memberIds.length > 0) {
      await tx.update(estimateLineItems)
        .set({ freightGroupId: group.id })
        .where(inArray(estimateLineItems.id, memberIds));
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  NetSuite: OAuth 1.0a TBA header builder (own copy)
// ════════════════════════════════════════════════════════════════════════════

function otbBuildOAuthHeader(method: string, fullUrl: string): string | null {
  const { NS_ACCOUNT_ID, NS_CONSUMER_KEY, NS_CONSUMER_SECRET, NS_TOKEN_ID, NS_TOKEN_SECRET } = env;
  if (!NS_CONSUMER_KEY || !NS_CONSUMER_SECRET || !NS_TOKEN_ID || !NS_TOKEN_SECRET) return null;

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce     = crypto.randomBytes(16).toString('hex');

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

// ── Formatting helpers (own copies) ─────────────────────────────────────────

function otbFormatNsDate(date: string | null | undefined): string {
  if (!date) return '';
  const [y, m, d] = date.split('-');
  return `${m}/${d}/${y}`;
}

function otbToNsNum(nsId: string): number | null {
  return nsId ? Number(nsId) : null;
}

function otbToNum(val: string | number | null | undefined): number | null {
  if (val === null || val === undefined || val === '') return null;
  const n = Number(val);
  return isNaN(n) ? null : n;
}

async function otbGetNsId(table: any, portalId: number | null | undefined): Promise<string> {
  if (!portalId) return '';
  const db = getDb();
  const [row] = await db
    .select({ nsId: table.netsuiteInternalId })
    .from(table)
    .where(eq(table.id, portalId))
    .limit(1);
  return row?.nsId ?? '';
}

// ════════════════════════════════════════════════════════════════════════════
//  NetSuite: build the create payload (own copy)
// ════════════════════════════════════════════════════════════════════════════

async function otbBuildCreatePayload(estimateId: number) {
  const db = getDb();

  const [est] = await db.select().from(estimates).where(eq(estimates.id, estimateId)).limit(1);
  if (!est) throw new Error(`Estimate ${estimateId} not found`);

  const [
    subsidiaryNsId, customerNsId, contactNsId, projectNameNsId, projectTypeNsId,
    likelyToCloseNsId, currencyNsId,
    deptNsId, channelNsId, bizVerticalNsId, businessTypeNsId,
    acctMgrNsId, hkPartnerNsId, ops1NsId, ops2NsId, complianceNsId,
    shipTermsNsId, shipMethodNsId, shipAddrNsId, billAddrNsId,
    estimateStatusNsId, closedLostReasonNsId, clientPursuitAltNsId,
  ] = await Promise.all([
    otbGetNsId(subsidiaries,                est.subsidiaryId),
    otbGetNsId(customers,                   est.customerId),
    otbGetNsId(contacts,                    est.customerContactId),
    otbGetNsId(projectNames,                est.projectNameId),
    otbGetNsId(projectTypes,                est.projectTypeId),
    otbGetNsId(likelyToClose,               est.likelyToCloseId),
    otbGetNsId(currencies,                  est.sellCurrencyId),
    otbGetNsId(departments,                 est.departmentId),
    otbGetNsId(salesChannels,               est.salesChannelId),
    otbGetNsId(businessVerticals,           est.businessVerticalId),
    otbGetNsId(businessTypes,               est.businessTypeId),
    otbGetNsId(accountManagers,             est.acctManagerId),
    otbGetNsId(hkPartners,                  est.hkPartnerId),
    otbGetNsId(opsPartners,                 est.opsPartner1Id),
    otbGetNsId(opsPartners,                 est.opsPartner2Id),
    otbGetNsId(compliancePartners,          est.compliancePartnerId),
    otbGetNsId(clientIncoterms,             est.clientIncotermsId),
    otbGetNsId(clientShippingMethods,       est.clientShipMethodId),
    otbGetNsId(addresses,                   est.shippingAddressId),
    otbGetNsId(addresses,                   est.billingAddressId),
    otbGetNsId(estimateStatuses,            est.statusId),
    otbGetNsId(closedLostReasons,           est.closedLostReasonId),
    otbGetNsId(clientPursuitAlternatives,   est.clientPursuitAlternativeId),
  ]);

  const prodDevNsIds = await Promise.all(
    (est.productDeveloperIds ?? []).map(id => otbGetNsId(productDevelopers, id))
  );

  const payload: Record<string, unknown> = {
    mode                : 'create',
    internalId          : est.netsuiteInternalId ?? '',
    subsidiaryNSId      : subsidiaryNsId,
    customerNSId        : customerNsId,
    customerContactNSId : contactNsId,
    customerPoNS        : est.customerPo ?? '',
    projectNameNSId     : projectNameNsId,
    projectTypeNSId     : projectTypeNsId,
    expectedCloseDateNS : otbFormatNsDate(est.expectedCloseDate),
    promiseDateNS       : otbFormatNsDate(est.promiseDate),
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
    projectHoldDateNS            : otbFormatNsDate(est.projectHoldDate),
    notesClosedLostReasonNS      : est.notesClosedLostReason ?? '',
  };

  // Line items — all lines belonging to the estimate (1-based keys to match the suitelet)
  const lineItemRows = await db.select().from(estimateLineItems)
    .where(eq(estimateLineItems.estimateId, estimateId))
    .orderBy(estimateLineItems.lineNumber);

  if (lineItemRows.length > 0) {
    const lineNsData = await Promise.all(lineItemRows.map(li =>
      Promise.all([
        otbGetNsId(csItems,              li.itemTypeId),            // [0]
        otbGetNsId(vendors,              li.vendorId),               // [1]
        otbGetNsId(currencies,           li.vendorCurrencyId),       // [2]
        otbGetNsId(factories,            li.factoryId),              // [3]
        otbGetNsId(productClasses,       li.productClassId),         // [4]
        otbGetNsId(sustainabilityOptions,li.sustainabilityId),       // [5]
        otbGetNsId(vendorIncoterms,      li.vendorIncotermsId),      // [6]
        Promise.resolve(li.shippingGroupId ?? null),                 // [7] text label
        otbGetNsId(vendors,              li.shipToVendorId),         // [8]
        otbGetNsId(vendorAddresses,      li.shipToVendorAddrId),     // [9]
        otbGetNsId(componentKitItems,    li.componentKitItemId),     // [10]
        otbGetNsId(productClassesEu,     li.productClassEuId),       // [11]
      ])
    ));

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
        ...(li.netsuiteInternalId ? { lineId: li.netsuiteInternalId } : {}),
        itemTypeIdNSId         : isComponent ? otbToNsNum(componentKitItemNsId) : otbToNsNum(itemTypeNsId),
        shortDescriptionNS     : li.shortDescription ?? '',
        descriptionNS          : li.description ?? '',
        vendorIdNSId           : otbToNsNum(vendorNsId),
        quantityNS             : otbToNum(li.quantity),
        sellPricePerUnitNS     : otbToNum(li.sellPricePerUnit),
        skuMarginPctNS         : otbToNum(li.skuMarginPct),
        salesAmountNS          : otbToNum(li.salesAmount),
        excludeNS              : li.exclude ?? false,

        pickupExwFobNS         : otbToNum(li.pickupExwFob),
        oceanDdp               : otbToNum(li.oceanDdp),
        airDdp                 : otbToNum(li.airDdp),

        factoryIdNSId          : otbToNsNum(factoryNsId),
        vendorCurrencyIdNSId   : otbToNsNum(vendorCurrencyNsId),
        factoryCostPerUnitNS   : otbToNum(li.factoryCostPerUnit),
        usdFactoryCostNS       : otbToNum(li.usdFactoryCost),
        packingCostPerUnitNS   : otbToNum(li.packingCostPerUnit),
        sampleFeesNS           : otbToNum(li.sampleFees),
        otherPerUnitNS         : otbToNum(li.otherPerUnit),
        landedCostPerUnitNS    : otbToNum(li.landedCostPerUnit),
        extendedLandedCostNS   : otbToNum(li.extendedLandedCost),
        freightPerUnitNS       : otbToNum(li.freightPerUnit),
        dutyPctNS              : otbToNum(li.dutyPct),
        tariffPctNS            : otbToNum(li.tariffPct),
        tariffMuPctNS          : otbToNum(li.tariffMuPct),
        otherCostPctNS         : otbToNum(li.otherCostPct),
        paddingPctNS           : otbToNum(li.paddingPct),

        productClassIdNSId     : !isEu && productClassNsId ? Number(productClassNsId) : '',
        productClassEuIdNSId   : isEu && productClassEuNsId ? Number(productClassEuNsId) : '',
        sustainabilityIdNSId   : otbToNsNum(sustainabilityNsId),
        htsCodeNS              : li.htsCode ?? '',
        countryOfDestNSId      : li.countryOfDest ?? '',

        unitsPerCartonNS       : li.unitsPerCarton ?? null,
        dimLCmNS               : otbToNum(li.dimLCm),
        dimWCmNS               : otbToNum(li.dimWCm),
        dimHCmNS               : otbToNum(li.dimHCm),
        weightKgPerCartonNS    : otbToNum(li.weightKgPerCarton),
        totalCartonsNS         : li.totalCartons ?? null,
        cbmPerCartonNS         : otbToNum(li.cbmPerCarton),
        totalCbmNS             : otbToNum(li.totalCbm),
        chargeableWeightKgNS   : otbToNum(li.chargeableWeightKg),

        shippingGroupIdNSId    : shippingGroupNsId ?? null,
        exFactoryDateNS        : otbFormatNsDate(li.exFactoryDate),
        vendorIncotermsIdNSId  : otbToNsNum(vendorIncotermsNsId),
        shipToVendorIdNSId     : otbToNsNum(shipToVendorNsId),
        shipToVendorAddrIdNSId : shipToVendorAddrNsId ? Number(shipToVendorAddrNsId) : '',
        notesNS                : li.notes ?? '',

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
        paddingAmountNS       : otbToNum(li.paddingAmount),
        dutyMarkupAmountNS    : otbToNum(li.dutyMarkupAmount),
        convertedNS           : li.converted ?? false,
        trueTariffRateNS      : li.trueTariff ?? '',
        freightSelectedGroupNS: li.freightSelectedGroup ?? '',
        freightPOLNS          : li.freightPol ?? '',
        freightPODNS          : li.freightPod ?? '',
        totalFreightCostNS    : otbToNum(li.totalFreightCost),
        freightCostPerUnitNS  : otbToNum(li.freightCostPerUnit),
        freightProviderNS     : li.freightProvider ?? '',
        freightNotesNS        : li.freightNotes ?? '',
        excludeFromPrintNS    : li.excludeFromPrint ?? false,
      };
    }
    payload.lines = lines;
  }

  // Freight groups — itemIds (line-item DB ids) → 1-based payload line numbers.
  const freightGroupRows = await db.select().from(estimateFreightGroups)
    .where(eq(estimateFreightGroups.estimateId, estimateId))
    .orderBy(estimateFreightGroups.id);

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
      totalCbmNS       : otbToNum(g.totalCbm),
      totalWeightNS    : otbToNum(g.totalWeight),

      oceanLclTotalNS  : otbToNum(g.oceanLclTotal),
      oceanLclPerUnitNS: otbToNum(g.oceanLclPerUnit),
      oceanLclPOLNS    : g.oceanLclPol ?? '',
      oceanLclPODNS    : g.oceanLclPod ?? '',

      oceanFclTotalNS  : otbToNum(g.oceanFclTotal),
      oceanFclPerUnitNS: otbToNum(g.oceanFclPerUnit),
      oceanFclPOLNS    : g.oceanFclPol ?? '',
      oceanFclPODNS    : g.oceanFclPod ?? '',

      airTotalNS       : otbToNum(g.airTotal),
      airPerUnitNS     : otbToNum(g.airPerUnit),
      airPOLNS         : g.airPol ?? '',
      airPODNS         : g.airPod ?? '',

      customTotalNS    : otbToNum(g.customTotal),
      customPerUnitNS  : otbToNum(g.customPerUnit),
      customProviderNS : g.customProvider ?? '',
      customNotesNS    : g.customNotes ?? '',
    }));
  }

  return payload;
}

// ════════════════════════════════════════════════════════════════════════════
//  NetSuite: post the estimate (create) and store the returned ids
//  Swallows its own errors and records syncStatus='failed' + syncError on the row,
//  so the orchestrator detects success/failure by re-reading the estimate.
// ════════════════════════════════════════════════════════════════════════════

async function otbSyncEstimateCreate(estimateId: number): Promise<void> {
  if (!env.NS_SUITELET_URL) {
    logger.debug({ estimateId }, 'OTB: NS_SUITELET_URL not configured — skipping NS create sync');
    return;
  }

  const db = getDb();

  try {
    const payload = await otbBuildCreatePayload(estimateId);

    const url = env.NS_SUITELET_URL.includes('?')
      ? `${env.NS_SUITELET_URL}&mode=create`
      : `${env.NS_SUITELET_URL}?mode=create`;

    const authHeader = otbBuildOAuthHeader('POST', url);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authHeader) headers['Authorization'] = authHeader;

    logger.info({ estimateId, url }, 'OTB: posting estimate (create) to NetSuite suitelet');

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

    const nsResp = await res.json() as {
      id?: string; internalId?: string; tranId?: string; documentNumber?: string;
      lineIds?: (string | number)[] | Record<string, string | number>;
    };

    const nsInternalId   = nsResp.id    ?? nsResp.internalId;
    const documentNumber = nsResp.tranId ?? nsResp.documentNumber;

    await db.update(estimates)
      .set({
        netsuiteInternalId: nsInternalId   ?? undefined,
        documentNumber    : documentNumber ?? undefined,
        syncStatus        : 'synced',
        syncError         : null,
        syncedAt          : new Date(),
      } as any)
      .where(eq(estimates.id, estimateId));

    // Store NS line ids back onto each newly-created line item
    if (nsResp.lineIds && typeof nsResp.lineIds === 'object') {
      const lineRows = await db.select({
          id                : estimateLineItems.id,
          netsuiteInternalId: estimateLineItems.netsuiteInternalId,
          isActive          : estimateLineItems.isActive,
        }).from(estimateLineItems)
        .where(eq(estimateLineItems.estimateId, estimateId))
        .orderBy(estimateLineItems.lineNumber);

      const returnedIds = (Array.isArray(nsResp.lineIds)
        ? nsResp.lineIds
        : Object.entries(nsResp.lineIds).sort(([a], [b]) => parseInt(a, 10) - parseInt(b, 10)).map(([, v]) => v)
      ).map(v => String(v)).filter(Boolean);

      const heldIds  = new Set(lineRows.map(r => r.netsuiteInternalId).filter(Boolean));
      const freshIds = returnedIds.filter(id => !heldIds.has(id));
      const newLines = lineRows.filter(r => r.isActive && !r.netsuiteInternalId);

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
      logger.info({ estimateId, newLines: newLines.length, assigned: assignments.length }, 'OTB: new line NS IDs stored');
    }

    logger.info({ estimateId, nsInternalId, documentNumber }, 'OTB: estimate create synced to NetSuite');

  } catch (err: any) {
    const message = err?.message ?? String(err);
    logger.error({ estimateId, error: message }, 'OTB: NetSuite create sync failed');
    await db.update(estimates)
      .set({ syncStatus: 'failed', syncError: message } as any)
      .where(eq(estimates.id, estimateId));
  }
}

// ── ES Status flip after convert (own copy; see netsuiteSync.service.ts) ──────
// Mirrors the estimate's ES Status from NetSuite. Preference:
//   1. The es_status NetSuite reports on the converted estimate (mapped by netsuite_internal_id).
//   2. Fallback when NS omits it — "Converted To Quote" if every active line is now converted,
//      else "Partially Converted".
// Returns quietly on any missing lookup so a convert never fails on missing seed data.
async function otbApplyConvertEsStatus(estimateId: number, nsEsStatusId?: string | number): Promise<void> {
  const db = getDb();

  let esStatusId: number | null = null;
  let source = '';

  // 1. Prefer NetSuite's own ES Status value (NetSuite → portal)
  if (nsEsStatusId !== undefined && nsEsStatusId !== null && String(nsEsStatusId) !== '') {
    const [byNs] = await db
      .select({ id: esStatus.id })
      .from(esStatus)
      .where(and(eq(esStatus.netsuiteInternalId, String(nsEsStatusId)), eq(esStatus.isActive, true)))
      .limit(1);
    if (byNs) {
      esStatusId = byNs.id;
      source = `netsuite(nsId=${nsEsStatusId})`;
    } else {
      logger.warn({ estimateId, nsEsStatusId }, 'OTB: NS es_status id has no matching portal es_status — falling back to computed status');
    }
  }

  // 2. Fallback — compute from how many lines were converted
  if (esStatusId === null) {
    const [remaining] = await db
      .select({ id: estimateLineItems.id })
      .from(estimateLineItems)
      .where(and(
        eq(estimateLineItems.estimateId, estimateId),
        eq(estimateLineItems.isActive, true),
        eq(estimateLineItems.converted, false),
      ))
      .limit(1);

    const targetName = remaining ? 'Partially Converted' : 'Converted To Quote';
    const [row] = await db
      .select({ id: esStatus.id })
      .from(esStatus)
      .where(and(eq(esStatus.name, targetName), eq(esStatus.isActive, true)))
      .limit(1);
    esStatusId = row?.id ?? null;
    source = `computed(${targetName})`;
  }

  if (esStatusId === null) {
    logger.warn({ estimateId }, 'OTB: convert es_status not found — ES Status left unchanged');
    return;
  }

  await db.update(estimates)
    .set({ esStatusId, updatedAt: new Date() } as any)
    .where(eq(estimates.id, estimateId));
  logger.info({ estimateId, esStatusId, source }, 'OTB: ES Status updated after convert');
}

// ════════════════════════════════════════════════════════════════════════════
//  NetSuite: post the convert (create new quote) and store the returned quote ids
//  Swallows its own errors and records failure on both the estimate and quote rows.
// ════════════════════════════════════════════════════════════════════════════

async function otbSyncConvert(estimateId: number, quoteId: number, lineItemIds: number[]): Promise<void> {
  if (!env.NS_SUITELET_URL) {
    logger.debug({ estimateId }, 'OTB: NS_SUITELET_URL not configured — skipping NS convert sync');
    return;
  }

  const db = getDb();

  try {
    const [est] = await db.select({ netsuiteInternalId: estimates.netsuiteInternalId })
      .from(estimates).where(eq(estimates.id, estimateId)).limit(1);
    const oppId = est?.netsuiteInternalId ?? '';

    const payload = { mode: 'convert', oppId };

    const url = env.NS_SUITELET_URL.includes('?')
      ? `${env.NS_SUITELET_URL}&mode=convert`
      : `${env.NS_SUITELET_URL}?mode=convert`;

    const authHeader = otbBuildOAuthHeader('POST', url);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authHeader) headers['Authorization'] = authHeader;

    logger.info({ estimateId, url, oppId }, 'OTB: posting convert to NetSuite suitelet');

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

    const nsResp = await res.json() as {
      id?: string; internalId?: string; documentNumber?: string;
      quoteId?: string; quoteTranId?: string;
      esStatusNSId?: string | number; esStatus?: string | number;
    };

    const quoteNsId   = nsResp.internalId     ?? nsResp.quoteId;
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
      .where(eq(estimateQuotes.id, quoteId));

    if (lineItemIds.length > 0) {
      await db.update(estimateLineItems)
        .set({ converted: true } as any)
        .where(inArray(estimateLineItems.id, lineItemIds));
    }

    await db.update(estimates)
      .set({ syncStatus: 'synced', syncError: null, syncedAt: new Date() } as any)
      .where(eq(estimates.id, estimateId));

    // Mirror the ES Status from NetSuite now that the conversion is confirmed. Uses the
    // es_status NetSuite returns (esStatusNSId), falling back to a computed status if absent.
    // (runs after the converted=true update above so the partial/full fallback is accurate.)
    await otbApplyConvertEsStatus(estimateId, nsResp.esStatusNSId ?? nsResp.esStatus);

    logger.info({ estimateId, quoteId, quoteNsId, quoteDocNum }, 'OTB: convert synced to NetSuite');

  } catch (err: any) {
    const message = err?.message ?? String(err);
    logger.error({ estimateId, quoteId, error: message }, 'OTB: NetSuite convert sync failed');
    await db.update(estimates)
      .set({ syncStatus: 'failed', syncError: message } as any)
      .where(eq(estimates.id, estimateId));
    await db.update(estimateQuotes)
      .set({ syncStatus: 'failed', syncError: message, updatedAt: new Date() } as any)
      .where(eq(estimateQuotes.id, quoteId));
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  Public entry point — orchestrates the full chain synchronously
// ════════════════════════════════════════════════════════════════════════════

export async function createEstimateAndConvertToOtb(
  headerData: Record<string, unknown>,
  lineItems: RawLineItem[],
  freightGroups: Record<string, unknown>[] = [],
) {
  const db = getDb();
  const startTime = Date.now();
  logger.info('OTB: creating estimate + converting to quote');

  // 1. Insert estimate + line items (+ freight groups) atomically
  const { estimate, lineItems: lines } = await db.transaction(async (tx) => {
    const [estimate] = await tx.insert(estimates)
      .values({ ...headerData, source: 'portal', syncStatus: 'pending' } as any)
      .returning();
    const { parents, components } = await otbInsertLineItems(tx, estimate.id, lineItems);
    await otbInsertFreightGroups(tx, estimate.id, freightGroups, parents);
    return { estimate, lineItems: [...parents, ...components] };
  });
  logger.info({ estimateId: estimate.id, lineItemCount: lines.length, durationMs: Date.now() - startTime }, 'OTB: estimate created locally');

  // 2. Create the estimate in NetSuite (await — populates netsuiteInternalId + documentNumber)
  await otbSyncEstimateCreate(estimate.id);

  // 3. Verify the create-sync succeeded before attempting the convert
  const [synced] = await db
    .select({
      id                : estimates.id,
      netsuiteInternalId: estimates.netsuiteInternalId,
      documentNumber    : estimates.documentNumber,
      syncStatus        : estimates.syncStatus,
      syncError         : estimates.syncError,
    })
    .from(estimates)
    .where(eq(estimates.id, estimate.id))
    .limit(1);

  if (!synced?.netsuiteInternalId || synced.syncStatus === 'failed') {
    throw new AppError(
      `Estimate ${estimate.id} was saved but failed to sync to NetSuite: ${synced?.syncError ?? 'unknown error'}`,
      502,
      'NS_CREATE_FAILED',
    );
  }

  // 4. Create the quote row, flip the estimate to 'otb', and run the convert-sync (await)
  const targetIds = lines.map(l => l.id);

  const [newQuote] = await db.insert(estimateQuotes)
    .values({ estimateId: estimate.id, syncStatus: 'pending' } as any)
    .returning();

  await db.update(estimates)
    .set({ status: 'otb', syncStatus: 'pending', otbConvertedAt: new Date(), updatedAt: new Date() } as any)
    .where(eq(estimates.id, estimate.id));

  await otbSyncConvert(estimate.id, newQuote.id, targetIds);

  // 5. Verify the convert-sync succeeded (whole operation fails as a unit)
  const [quote] = await db
    .select()
    .from(estimateQuotes)
    .where(eq(estimateQuotes.id, newQuote.id))
    .limit(1);

  if (!quote || quote.syncStatus === 'failed') {
    throw new AppError(
      `Estimate created & synced (NS ${synced.netsuiteInternalId}), but OTB/quote conversion failed: ${quote?.syncError ?? 'unknown error'}`,
      502,
      'NS_CONVERT_FAILED',
    );
  }

  // 6. Return the post-convert estimate (status 'otb', synced) + quote + line items
  const [finalEstimate] = await db
    .select()
    .from(estimates)
    .where(eq(estimates.id, estimate.id))
    .limit(1);

  return { estimate: finalEstimate, quote, lineItems: lines };
}
