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
import { eq } from 'drizzle-orm';
import { getDb } from '../config/database.js';
import {
  estimates,
  subsidiaries, customers, contacts, currencies, projectNames, projectTypes, likelyToClose,
  departments, salesChannels, businessVerticals, businessTypes,
  accountManagers, productDevelopers, hkPartners, opsPartners, compliancePartners,
  clientIncoterms, clientShippingMethods, addresses,
  // Phase 2 – uncomment when line items are added:
  // estimateLineItems, itemTypes, vendors, sustainabilityOptions, productClasses,
  // vendorIncoterms, factories,
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
  return `${parseInt(m, 10)}/${parseInt(d, 10)}/${y}`;
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

async function buildNsPayload(estimateId: number, mode: 'create' | 'update') {
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
  ] = await Promise.all([
    getNsId(subsidiaries,         est.subsidiaryId),
    getNsId(customers,            est.customerId),
    getNsId(contacts,             est.customerContactId),
    getNsId(projectNames,         est.projectNameId),
    getNsId(projectTypes,         est.projectTypeId),
    getNsId(likelyToClose,        est.likelyToCloseId),
    getNsId(currencies,           est.sellCurrencyId),
    getNsId(departments,          est.departmentId),
    getNsId(salesChannels,        est.salesChannelId),
    getNsId(businessVerticals,    est.businessVerticalId),
    getNsId(businessTypes,        est.businessTypeId),
    getNsId(accountManagers,      est.acctManagerId),
    getNsId(hkPartners,           est.hkPartnerId),
    getNsId(opsPartners,          est.opsPartner1Id),
    getNsId(opsPartners,          est.opsPartner2Id),
    getNsId(compliancePartners,   est.compliancePartnerId),
    getNsId(clientIncoterms,      est.clientIncotermsId),
    getNsId(clientShippingMethods,est.clientShipMethodId),
    getNsId(addresses,            est.shippingAddressId),
    getNsId(addresses,            est.billingAddressId),
  ]);

  // Resolve NS IDs for all product developers in parallel
  const prodDevNsIds = await Promise.all(
    (est.productDeveloperIds ?? []).map(id => getNsId(productDevelopers, id))
  );

  // 3. Phase 1 payload — header fields only
  const payload: Record<string, unknown> = {
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
    productDeveloperNSIds: prodDevNsIds.filter(id => id !== ''),
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
    bibleLinkNS         : est.bibleLink ?? '',
    memoNS              : est.memo ?? '',
  };

  // Phase 2 – Line items (uncomment when ready):
  // const lineItems = await db.select().from(estimateLineItems)
  //   .where(eq(estimateLineItems.estimateId, estimateId))
  //   .orderBy(estimateLineItems.lineNumber);
  // const lines: Record<string, unknown> = {};
  // for (let i = 0; i < lineItems.length; i++) {
  //   const li = lineItems[i];
  //   const [itemNsId, vendorNsId, ...] = await Promise.all([...]);
  //   lines[String(i)] = { ... };
  // }
  // payload.lines = lines;

  // Phase 3 – Freight groups (uncomment when ready):
  // const freightGroups = await db.select().from(estimateFreightGroups)
  //   .where(eq(estimateFreightGroups.estimateId, estimateId))
  //   .orderBy(estimateFreightGroups.sortOrder);
  // payload.freightGroups = freightGroups.map(g => ({ ... }));

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
      signal : AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`NS suitelet responded ${res.status}: ${body}`);
    }

    // NS response: { id: "12345", tranId: "EST-0042" }
    const nsResp = await res.json() as {
      id?            : string;
      internalId?    : string;
      tranId?        : string;
      documentNumber?: string;
    };

    const nsInternalId   = nsResp.id          ?? nsResp.internalId;
    const documentNumber = nsResp.tranId       ?? nsResp.documentNumber;

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

    // Mark as failed — portal create/update still succeeds even when NS is down
    await db.update(estimates)
      .set({ syncStatus: 'failed', syncError: message } as any)
      .where(eq(estimates.id, estimateId));
  }
}
