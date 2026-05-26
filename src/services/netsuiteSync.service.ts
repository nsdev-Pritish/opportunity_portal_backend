/**
 * netsuiteSync.service.ts
 *
 * Builds the NetSuite suitelet payload from portal estimate data and posts it.
 * After NetSuite responds, stores the returned internal ID + document number
 * back on the estimates row.
 *
 * Called automatically from estimate.service.ts after create / update.
 * Safe to call even when NS_SUITELET_URL is not configured — it will skip silently.
 */

import crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '../config/database.js';
import {
  estimates, estimateLineItems, estimateFreightGroups,
  customers, contacts, currencies, projectTypes, likelyToClose,
  departments, salesChannels, businessVerticals, businessTypes,
  accountManagers, productDevelopers, hkPartners, opsPartners, compliancePartners,
  clientIncoterms, clientShippingMethods, addresses, projectNames,
  itemTypes, vendors, sustainabilityOptions, productClasses, vendorIncoterms,
  lclRates, fclRates, airRates,
} from '../db/schema/index.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

// ── OAuth 1.0a TBA header builder ─────────────────────────────────────────────

function buildOAuthHeader(method: string, baseUrl: string): string | null {
  const { NS_ACCOUNT_ID, NS_CONSUMER_KEY, NS_CONSUMER_SECRET, NS_TOKEN_ID, NS_TOKEN_SECRET } = env;
  if (!NS_CONSUMER_KEY || !NS_CONSUMER_SECRET || !NS_TOKEN_ID || !NS_TOKEN_SECRET) return null;

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce     = crypto.randomBytes(16).toString('hex');

  const oauthParams: Record<string, string> = {
    oauth_consumer_key    : NS_CONSUMER_KEY,
    oauth_nonce           : nonce,
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp       : timestamp,
    oauth_token           : NS_TOKEN_ID,
    oauth_version         : '1.0',
  };

  // Normalised parameter string (sorted, percent-encoded)
  const paramStr = Object.entries(oauthParams)
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
  return `${parseInt(m, 10)}/${parseInt(d, 10)}/${y}`;
}

function fmtCurrency(val: string | number | null | undefined): string {
  if (val == null || val === '') return '$0.00';
  return `$${parseFloat(String(val)).toFixed(2)}`;
}

function fmtPct(val: string | number | null | undefined): string {
  if (val == null || val === '') return '0%';
  return `${parseFloat(String(val)).toFixed(2)}%`;
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

// ── Build the full suitelet payload ───────────────────────────────────────────

async function buildNsPayload(estimateId: number, mode: 'create' | 'update') {
  const db = getDb();

  // 1. Fetch estimate header
  const [est] = await db.select().from(estimates).where(eq(estimates.id, estimateId)).limit(1);
  if (!est) throw new Error(`Estimate ${estimateId} not found`);

  // 2. Fetch line items + freight groups
  const [lineItems, freightGroups] = await Promise.all([
    db.select().from(estimateLineItems)
      .where(eq(estimateLineItems.estimateId, estimateId))
      .orderBy(estimateLineItems.lineNumber),
    db.select().from(estimateFreightGroups)
      .where(eq(estimateFreightGroups.estimateId, estimateId))
      .orderBy(estimateFreightGroups.sortOrder),
  ]);

  // 3. Resolve all header-level FK NS IDs in one parallel batch
  const [
    customerNsId, contactNsId, projectNameNsId, projectTypeNsId,
    deptNsId, hkPartnerNsId, complianceNsId, channelNsId,
    currencyNsId, likelyToCloseNsId, shipTermsNsId, shipMethodNsId,
    businessTypeNsId, bizVerticalNsId, ops1NsId, ops2NsId,
    prodDevNsId, acctMgrNsId, billAddrNsId, shipAddrNsId,
  ] = await Promise.all([
    getNsId(customers,             est.customerId),
    getNsId(contacts,              est.customerContactId),
    getNsId(projectNames,          est.projectNameId),
    getNsId(projectTypes,          est.projectTypeId),
    getNsId(departments,           est.departmentId),
    getNsId(hkPartners,            est.hkPartnerId),
    getNsId(compliancePartners,    est.compliancePartnerId),
    getNsId(salesChannels,         est.salesChannelId),
    getNsId(currencies,            est.sellCurrencyId),
    getNsId(likelyToClose,         est.likelyToCloseId),
    getNsId(clientIncoterms,       est.clientIncotermsId),
    getNsId(clientShippingMethods, est.clientShipMethodId),
    getNsId(businessTypes,         est.businessTypeId),
    getNsId(businessVerticals,     est.businessVerticalId),
    getNsId(opsPartners,           est.opsPartner1Id),
    getNsId(opsPartners,           est.opsPartner2Id),
    getNsId(productDevelopers,     est.productDeveloperId),
    getNsId(accountManagers,       est.acctManagerId),
    getNsId(addresses,             est.billingAddressId),
    getNsId(addresses,             est.shippingAddressId),
  ]);

  // 4. Freight summary — derive from the primary (first) group
  const primaryGroup = freightGroups[0] ?? null;
  let freightPol = '', freightPod = '', freightBaseRate = '', freightAdditionalFees = '';

  if (primaryGroup?.lclRateId && primaryGroup.chosenType === 'LCL') {
    const [r] = await db.select().from(lclRates).where(eq(lclRates.id, primaryGroup.lclRateId)).limit(1);
    if (r) { freightPol = r.pol ?? ''; freightPod = r.pod ?? ''; freightBaseRate = String(r.pricePerCbm ?? ''); }
  } else if (primaryGroup?.fclRateId && primaryGroup.chosenType === 'FCL') {
    const [r] = await db.select().from(fclRates).where(eq(fclRates.id, primaryGroup.fclRateId)).limit(1);
    if (r) { freightPol = r.pol ?? ''; freightPod = r.pod ?? ''; }
  } else if (primaryGroup?.airRateId && primaryGroup.chosenType === 'AIR') {
    const [r] = await db.select().from(airRates).where(eq(airRates.id, primaryGroup.airRateId)).limit(1);
    if (r) { freightPol = r.pol ?? ''; freightPod = r.pod ?? ''; freightBaseRate = String(r.pricePerKg ?? ''); }
  }

  const totalFreightCost  = freightGroups.reduce((s, g) => s + parseFloat(String(g.freightCost         ?? 0)), 0);
  const totalCbm          = freightGroups.reduce((s, g) => s + parseFloat(String(g.totalCbm            ?? 0)), 0);
  const totalWeight       = freightGroups.reduce((s, g) => s + parseFloat(String(g.chargeableWeightKg  ?? 0)), 0);
  const totalCartons      = lineItems.reduce((s, li)    => s + (li.totalCartons ?? 0), 0);
  const totalLanded       = lineItems.reduce((s, li)    => s + parseFloat(String(li.extendedLandedCost  ?? 0)), 0);

  // 5. Build lines object (string-keyed as NetSuite expects)
  const lines: Record<string, unknown> = {};
  for (let i = 0; i < lineItems.length; i++) {
    const li = lineItems[i];

    const [itemNsId, vendorNsId, vendorCurrNsId, sustainNsId, classNsId, vendorIncNsId] = await Promise.all([
      getNsId(itemTypes,             li.itemTypeId),
      getNsId(vendors,               li.vendorId),
      getNsId(currencies,            li.vendorCurrencyId),
      getNsId(sustainabilityOptions, li.sustainabilityId),
      getNsId(productClasses,        li.productClassId),
      getNsId(vendorIncoterms,       li.vendorIncotermsId),
    ]);

    // Match freight group via shippingGroupId stored on line item
    const lineGroup = freightGroups.find(g => g.id === li.shippingGroupId) ?? null;

    lines[String(i)] = {
      item            : itemNsId,
      itemText        : '',
      description     : li.description ?? '',
      shortDescription: li.shortDescription ?? '',
      vendor          : vendorNsId,
      quantity        : String(li.quantity ?? '0'),
      rate            : String(li.sellPricePerUnit ?? '0'),
      margin          : fmtPct(li.skuMarginPct),
      amount          : String(li.salesAmount ?? '0'),
      excludeFromPrint: li.exclude ?? false,
      selectedForQuote: false,
      rowId           : `tr-${i}`,
      detail: {
        agreedPrice      : fmtCurrency(li.factoryCostPerUnit),
        description      : li.description ?? '',
        vendor           : vendorNsId,
        factoryInformation: '',
        classValue       : classNsId,
        sustainability   : sustainNsId,
        htscode          : li.htsCode ?? '',
        origincountry    : li.countryOfOrigin ?? '',
        vendorCurrency   : vendorCurrNsId,
        exDate           : formatNsDate(li.exFactoryDate),
        vendorSku        : '',
        vendorShip       : vendorIncNsId,
        vendorAddress    : '',
        notesPO          : li.notes ?? '',
        addrInfo         : '',
        converted        : 'false',
        countryDestination: li.countryOfDest ?? 'US',
        image            : '',
        d1               : String(li.dimLCm ?? ''),
        d2               : String(li.dimWCm ?? ''),
        d3               : String(li.dimHCm ?? ''),
        weight           : String(li.weightKgPerCarton ?? ''),
        pack             : String(li.cbmPerCarton ?? ''),
        unitspercarton   : String(li.unitsPerCarton ?? ''),
        cartonstotal     : String(li.totalCartons ?? 0),
        cbmpack          : String(li.cbmPerCarton  ?? '0.000'),
        totalpack        : String(li.totalCbm      ?? '0.000'),
        totalweight      : String(li.chargeableWeightKg ?? '0'),
        freight          : String(li.freightPerUnit ?? ''),
        duty             : fmtPct(li.dutyPct),
        dutymu           : fmtPct(li.tariffMuPct),
        tariff           : fmtPct(li.tariffPct),
        othercost        : fmtCurrency(li.otherPerUnit),
        otherpercent     : fmtPct(li.otherCostPct),
        packingcost      : fmtCurrency(li.packingCostPerUnit),
        samplefee        : fmtCurrency(li.sampleFees),
        factorycost      : fmtCurrency(li.factoryCostPerUnit),
        paddingval       : String(li.paddingPct ?? ''),
        landedcost       : fmtCurrency(li.landedCostPerUnit),
        extlandedcost    : fmtCurrency(li.extendedLandedCost),
        shippinggroup    : lineGroup?.groupName ?? '',
        shippingFreight  : {
          freightType   : lineGroup?.chosenType ?? '',
          pol           : freightPol,
          pod           : freightPod,
          freightTotal  : parseFloat(String(lineGroup?.freightCost        ?? 0)),
          freightPerUnit: parseFloat(String(lineGroup?.freightCostPerUnit ?? 0)),
          shippinggroup : lineGroup?.groupName ?? '',
          freightProvider: lineGroup?.customProvider ?? '',
          freightNotes  : lineGroup?.customNotes    ?? '',
        },
        className        : '',
      },
    };
  }

  // 6. Assemble the top-level payload exactly as the NS suitelet expects
  const today = new Date().toISOString().split('T')[0];
  const payload: Record<string, unknown> = {
    sub                   : '1',          // subsidiary (hardcoded — adjust if multi-sub)
    customer              : customerNsId,
    projectName           : projectNameNsId,
    projectNameText       : est.projectName ?? '',
    projectType           : projectTypeNsId,
    projectTypeMain       : projectTypeNsId,
    projectedTotal        : String(est.projectedTotalAmt ?? ''),
    expectedCloseDate     : formatNsDate(est.expectedCloseDate),
    promiseDate           : formatNsDate(est.promiseDate),
    salesRep              : acctMgrNsId,
    department            : deptNsId,
    hkPartner             : hkPartnerNsId,
    compliancePartner     : complianceNsId,
    channel               : channelNsId,
    spendCategory         : bizVerticalNsId,
    memo                  : est.memo ?? '',
    currency              : currencyNsId,
    creativePartner       : prodDevNsId,
    likelyToClose         : likelyToCloseNsId,
    pipeline              : true,
    bibleLink             : est.bibleLink ?? '',
    qtyReq                : String(est.estimatedQty ?? ''),
    shipTerms             : shipTermsNsId,
    shipMethod            : shipMethodNsId,
    businessType          : businessTypeNsId,
    divisionalBudget      : '',
    ops                   : ops1NsId,
    ops2                  : ops2NsId,
    prodDev               : prodDevNsId,
    customerPO            : est.customerPo ?? '',
    notesReason           : '',
    status                : 'A',
    reason                : null,
    contact               : contactNsId,
    billAddress           : billAddrNsId,
    shipAddress           : shipAddrNsId,
    flagBill              : false,
    flagShip              : false,
    flagContact           : false,
    businessVertical      : bizVerticalNsId,
    clientPursuitAlternative: '',
    requestWrikePortal    : est.deckRequest        ?? false,
    requestSetupPortal    : est.artSetupRequest    ?? false,
    requestWrikePortalPack: est.pkgDeckRequest     ?? false,
    requestSetupPortalPack: est.pkgArtSetupRequest ?? false,
    totalfactoryCostUSD   : '',
    totalDuty             : '',
    totalTariff           : '',
    totalFreightEst       : String(totalFreightCost.toFixed(2)),
    totalOtherCost        : '',
    totalLanded           : String(totalLanded.toFixed(2)),
    freightMethod         : primaryGroup?.chosenType ?? '',
    freightTotalCost      : String(totalFreightCost.toFixed(2)),
    freightProvider       : primaryGroup?.customProvider ?? '',
    freightNotes          : primaryGroup?.customNotes    ?? '',
    freightTotalCBM       : String(totalCbm.toFixed(3)),
    freightTotalWeight    : String(totalWeight.toFixed(3)),
    freightTotalCartons   : String(totalCartons),
    freightCalcDate       : formatNsDate(today),
    freightPol,
    freightPod,
    freightBaseRate,
    freightAdditionalFees,
    freightCostperUnit    : String(primaryGroup?.freightCostPerUnit ?? '0'),
    files                 : [],
    lines,
  };

  // On update, include the NS internal ID so the suitelet can locate the record
  if (mode === 'update' && est.netsuiteInternalId) {
    payload.id = est.netsuiteInternalId;
  }

  return payload;
}

// ── Public entry point ────────────────────────────────────────────────────────

export async function syncEstimateToNetsuite(
  estimateId: number,
  mode: 'create' | 'update' = 'create',
): Promise<void> {
  if (!env.NS_SUITELET_URL) {
    logger.debug({ estimateId }, 'NS_SUITELET_URL not configured — skipping NS sync');
    return;
  }

  const db = getDb();

  try {
    const payload = await buildNsPayload(estimateId, mode);
    const url = `${env.NS_SUITELET_URL}?mode=${mode}`;

    const authHeader = buildOAuthHeader('POST', env.NS_SUITELET_URL);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authHeader) headers['Authorization'] = authHeader;

    logger.info({ estimateId, mode }, 'Posting estimate to NetSuite suitelet');

    const res = await fetch(url, {
      method : 'POST',
      headers,
      body   : JSON.stringify(payload),
      signal : AbortSignal.timeout(30_000), // 30 s hard timeout
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`NS suitelet responded ${res.status}: ${body}`);
    }

    // NS response: { id: "12345", tranId: "EST-0042" }  (field names may vary)
    const nsResp = await res.json() as {
      id?             : string;
      internalId?     : string;
      tranId?         : string;
      documentNumber? : string;
    };

    const nsInternalId  = nsResp.id          ?? nsResp.internalId;
    const documentNumber = nsResp.tranId      ?? nsResp.documentNumber;

    await db.update(estimates)
      .set({
        netsuiteInternalId: nsInternalId   ?? undefined,
        documentNumber    : documentNumber ?? undefined,
        syncStatus        : 'synced',
        syncError         : null,
        syncedAt          : new Date(),
      } as any)
      .where(eq(estimates.id, estimateId));

    logger.info({ estimateId, nsInternalId, documentNumber }, 'Estimate synced to NetSuite successfully');

  } catch (err: any) {
    const message = err?.message ?? String(err);
    logger.error({ estimateId, mode, error: message }, 'NetSuite sync failed');

    // Mark as failed but do NOT throw — portal create/update should still succeed
    await db.update(estimates)
      .set({ syncStatus: 'failed', syncError: message } as any)
      .where(eq(estimates.id, estimateId));
  }
}
