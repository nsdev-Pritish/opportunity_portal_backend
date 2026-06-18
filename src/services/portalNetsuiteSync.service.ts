/**
 * portalNetsuiteSync.service.ts
 *
 * Outbound sync for the small entities users create from the portal "+ Add"
 * modals: Project Names, Shipping Addresses, Billing Addresses and Contacts.
 *
 * Flow for each:
 *   1. The portal route inserts the row in our DB (source='portal', syncStatus='pending').
 *   2. It then calls the matching sync function here.
 *   3. We build the NetSuite suitelet payload (the exact shape the NS team gave us),
 *      POST it, and on success store the returned NetSuite internal id back on the row
 *      and flip syncStatus → 'synced'. On failure the row is marked 'failed' with the error.
 *
 * This is intentionally kept SEPARATE from netsuiteSync.service.ts (which handles
 * estimates). The two share only the low-level OAuth/post client in utils/netsuiteClient.ts.
 *
 * Every function is non-throwing: a NetSuite failure never breaks the portal create —
 * the row already exists in our DB and simply stays unsynced until retried.
 */

import { eq } from 'drizzle-orm';
import { getDb } from '../config/database.js';
import { addresses, contacts, customers, projectNames, projectTypes } from '../db/schema/index.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { postToSuitelet } from '../utils/netsuiteClient.js';

// NetSuite returns the new record's internal id; accept the common field names.
interface NsCreateResponse {
  id?:             string | number;
  internalId?:     string | number;
  recordId?:       string | number;
  documentNumber?: string | number;
  success?:        boolean;
  error?:          string;
  message?:        string;   // suitelet uses this for both success notes and error text
}

/** Outcome handed back to the route so it can enrich its response. */
export interface PortalSyncResult {
  netsuiteInternalId: string | null;
  syncStatus: 'pending' | 'synced' | 'failed';
  syncError: string | null;
}

const skipped = (): PortalSyncResult => ({ netsuiteInternalId: null, syncStatus: 'pending', syncError: null });

function extractNsId(resp: NsCreateResponse): string | null {
  const raw = resp.id ?? resp.internalId ?? resp.recordId;
  return raw !== undefined && raw !== null && raw !== '' ? String(raw) : null;
}

/** Look up a customer's NetSuite internal id — required for address/contact creates. */
async function getCustomerNsId(customerId: number | null | undefined): Promise<string | null> {
  if (!customerId) return null;
  const db = getDb();
  const [row] = await db
    .select({ nsId: customers.netsuiteInternalId })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  return row?.nsId ?? null;
}

// ──────────────────────────────────────────────────────────────────────────────
//  Project Name
//  Payload: { mode: 'createProjectName', name, projectType }
// ──────────────────────────────────────────────────────────────────────────────

export async function syncProjectNameToNetsuite(projectNameId: number): Promise<PortalSyncResult> {
  const mode = 'createProjectName';
  if (!env.NS_SUITELET_URL) {
    logger.debug({ projectNameId }, 'NS_SUITELET_URL not configured — skipping project name NS sync');
    return skipped();
  }

  const db = getDb();
  try {
    const [row] = await db.select().from(projectNames).where(eq(projectNames.id, projectNameId)).limit(1);
    if (!row) throw new Error(`Project name ${projectNameId} not found`);

    // projectType in the payload is the NetSuite internal id of the project type.
    const [pt] = await db
      .select({ nsId: projectTypes.netsuiteInternalId })
      .from(projectTypes)
      .where(eq(projectTypes.id, row.projectTypeId!))
      .limit(1);

    if (!pt?.nsId) {
      logger.warn({ projectNameId, projectTypeId: row.projectTypeId },
        'Project type has no NetSuite internal id — cannot create project name in NetSuite yet');
      return skipped();
    }

    const payload = {
      mode,
      name: row.name,
      projectType: Number(pt.nsId),
    };

    const resp = await postToSuitelet<NsCreateResponse>(payload, mode);
    return finalize(projectNames, projectNameId, resp, mode);
  } catch (err) {
    return recordFailure(projectNames, projectNameId, err, mode);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
//  Shipping / Billing Address
//  Payload: { mode, customerNSId, country, attention, addressee,
//             address1, address2, city, state, zip }
// ──────────────────────────────────────────────────────────────────────────────

async function syncAddressToNetsuite(
  addressId: number,
  mode: 'createShippingAddress' | 'createBillingAddress',
): Promise<PortalSyncResult> {
  if (!env.NS_SUITELET_URL) {
    logger.debug({ addressId, mode }, 'NS_SUITELET_URL not configured — skipping address NS sync');
    return skipped();
  }

  const db = getDb();
  try {
    const [row] = await db.select().from(addresses).where(eq(addresses.id, addressId)).limit(1);
    if (!row) throw new Error(`Address ${addressId} not found`);

    const customerNSId = await getCustomerNsId(row.customerId);
    if (!customerNSId) {
      logger.warn({ addressId, customerId: row.customerId },
        'Customer has no NetSuite internal id — cannot create address in NetSuite yet');
      return skipped();
    }

    const payload = {
      mode,
      customerNSId,
      country:   row.country   ?? '',
      attention: row.attention ?? '',
      addressee: row.addressee ?? '',
      address1:  row.addrLine1 ?? '',
      address2:  row.addrLine2 ?? '',
      city:      row.city      ?? '',
      state:     row.state     ?? '',
      zip:       row.postalCode ?? '',
    };

    const resp = await postToSuitelet<NsCreateResponse>(payload, mode);
    return finalize(addresses, addressId, resp, mode);
  } catch (err) {
    return recordFailure(addresses, addressId, err, mode);
  }
}

export function syncShippingAddressToNetsuite(addressId: number): Promise<PortalSyncResult> {
  return syncAddressToNetsuite(addressId, 'createShippingAddress');
}

export function syncBillingAddressToNetsuite(addressId: number): Promise<PortalSyncResult> {
  return syncAddressToNetsuite(addressId, 'createBillingAddress');
}

// ──────────────────────────────────────────────────────────────────────────────
//  Contact
//  Payload: { mode: 'createContact', customerNSId, name, job, email, phone }
// ──────────────────────────────────────────────────────────────────────────────

export async function syncContactToNetsuite(contactId: number): Promise<PortalSyncResult> {
  const mode = 'createContact';
  if (!env.NS_SUITELET_URL) {
    logger.debug({ contactId }, 'NS_SUITELET_URL not configured — skipping contact NS sync');
    return skipped();
  }

  const db = getDb();
  try {
    const [row] = await db.select().from(contacts).where(eq(contacts.id, contactId)).limit(1);
    if (!row) throw new Error(`Contact ${contactId} not found`);

    const customerNSId = await getCustomerNsId(row.customerId);
    if (!customerNSId) {
      logger.warn({ contactId, customerId: row.customerId },
        'Customer has no NetSuite internal id — cannot create contact in NetSuite yet');
      return skipped();
    }

    const name = [row.firstName, row.lastName].filter(Boolean).join(' ').trim();

    const payload = {
      mode,
      customerNSId,
      name,
      job:   row.title ?? '',
      email: row.email ?? '',
      phone: row.phone ?? '',
    };

    const resp = await postToSuitelet<NsCreateResponse>(payload, mode);
    return finalize(contacts, contactId, resp, mode);
  } catch (err) {
    return recordFailure(contacts, contactId, err, mode);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
//  Shared DB write-back helpers
// ──────────────────────────────────────────────────────────────────────────────

// `table` is any of our portal tables carrying the standard syncCols.
async function finalize(
  table: typeof projectNames | typeof addresses | typeof contacts,
  id: number,
  resp: NsCreateResponse,
  mode: string,
): Promise<PortalSyncResult> {
  const nsId = extractNsId(resp);

  if (!nsId) {
    const message = resp.error ?? resp.message ?? 'NetSuite did not return an internal id';
    logger.error({ id, mode, rawResponse: resp }, `NetSuite ${mode} returned no internal id`);
    return recordFailure(table, id, new Error(message), mode);
  }

  const db = getDb();
  await db.update(table)
    .set({
      netsuiteInternalId: nsId,
      syncStatus: 'synced',
      syncError: null,
      syncedAt: new Date(),
      updatedAt: new Date(),
    } as any)
    .where(eq((table as any).id, id));

  logger.info({ id, mode, netsuiteInternalId: nsId }, `Portal ${mode} synced to NetSuite`);
  return { netsuiteInternalId: nsId, syncStatus: 'synced', syncError: null };
}

async function recordFailure(
  table: typeof projectNames | typeof addresses | typeof contacts,
  id: number,
  err: unknown,
  mode: string,
): Promise<PortalSyncResult> {
  const message = err instanceof Error ? err.message : String(err);
  logger.error({ id, mode, error: message }, `Portal ${mode} NetSuite sync failed`);

  const db = getDb();
  await db.update(table)
    .set({ syncStatus: 'failed', syncError: message, updatedAt: new Date() } as any)
    .where(eq((table as any).id, id));

  return { netsuiteInternalId: null, syncStatus: 'failed', syncError: message };
}
