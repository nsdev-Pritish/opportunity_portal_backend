// ES Status ↔ NetSuite estimate status mapping.
//
// Matched by NAME through the existing masters, so no ids live in code:
//   es_status.name (portal)        <->  estimate_statuses.name (NetSuite, id = netsuite_internal_id)
//   In Progress                         In Discussion
//   Converted To Quote                  Purchasing
//   Closed Won                          Closed Won
//   Closed Lost                         Closed Lost  (+ lost reason, sent separately)
//   Partially Converted                 derived only — never sent to NS
// NS → portal: Purchasing / Closed Won + partiallyConverted checkbox T => Partially Converted.
// Any NS status not listed above defaults to In Progress.

import { eq } from 'drizzle-orm';
import { getDb } from '../config/database.js';
import { esStatus, estimateStatuses, estimates } from '../db/schema/index.js';
import { logger } from '../utils/logger.js';

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

const PORTAL_TO_NS_NAME: Record<string, string> = {
  [norm('In Progress')]       : norm('In Discussion'),
  [norm('Converted To Quote')]: norm('Purchasing'),
  [norm('Closed Won')]        : norm('Closed Won'),
  [norm('Closed Lost')]       : norm('Closed Lost'),
};
const PARTIAL_NAME  = norm('Partially Converted');
const DEFAULT_NAME  = norm('In Progress');
const PARTIAL_FROM  = new Set([norm('Purchasing'), norm('Closed Won')]); // NS statuses the checkbox applies to

// NetSuite checkbox values arrive as true/false or 'T'/'F'.
export function parseNsCheckbox(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return ['t', 'true', '1', 'y', 'yes'].includes(v.trim().toLowerCase());
  return false;
}

// Portal es_status row id → what to send NetSuite. nsStatusId is undefined (omit it) for
// Partially Converted, an unmapped status, or no status.
export async function getNsStatusForEsStatus(
  esStatusId: number | null | undefined,
): Promise<{ nsStatusId?: string; isPartial: boolean }> {
  if (!esStatusId) return { isPartial: false };
  const db = getDb();
  const [row] = await db.select().from(esStatus).where(eq(esStatus.id, esStatusId)).limit(1);
  if (!row) return { isPartial: false };
  const name = norm(row.name);
  if (name === PARTIAL_NAME) return { isPartial: true };
  const nsName = PORTAL_TO_NS_NAME[name];
  if (!nsName) return { isPartial: false };
  const nsRow = (await db.select().from(estimateStatuses)).find(r => norm(r.name) === nsName);
  return { nsStatusId: nsRow?.netsuiteInternalId ?? undefined, isPartial: false };
}

// NS status (+ partiallyConverted checkbox) → portal es_status row id.
// Null only if the es_status master lacks the target row.
export async function resolveEsStatusIdFromNs(
  nsStatusId: string | number | null | undefined,
  partial: unknown,
): Promise<number | null> {
  const db = getDb();
  const nsRow = (await db.select().from(estimateStatuses))
    .find(r => r.netsuiteInternalId === String(nsStatusId ?? ''));
  const nsName = nsRow ? norm(nsRow.name) : '';

  let target = Object.keys(PORTAL_TO_NS_NAME).find(k => PORTAL_TO_NS_NAME[k] === nsName) ?? DEFAULT_NAME;
  if (PARTIAL_FROM.has(nsName) && parseNsCheckbox(partial)) target = PARTIAL_NAME;

  const row = (await db.select().from(esStatus)).find(r => r.isActive && norm(r.name) === target);
  return row?.id ?? null;
}

// Apply the status NetSuite reports in a RESTlet response ({ partiallyConverted, esStatusNsId,
// nsStatusId }) to the estimate. partiallyConverted = true always wins and sets Partially
// Converted; otherwise NS's own esStatusNsId is used (matched to es_status.netsuite_internal_id),
// else it is derived from nsStatusId. Never throws — a failed lookup must not fail a sync that
// already succeeded.
export async function applyNsResponseEsStatus(
  estimateId: number,
  resp: { partiallyConverted?: unknown; esStatusNsId?: unknown; nsStatusId?: unknown },
): Promise<void> {
  try {
    const db = getDb();
    const rows = (await db.select().from(esStatus)).filter(r => r.isActive);
    let target: number | null = null;
    let source = '';

    if (parseNsCheckbox(resp.partiallyConverted)) {
      target = rows.find(r => norm(r.name) === PARTIAL_NAME)?.id ?? null;
      source = 'partiallyConverted=true';
    } else if (resp.esStatusNsId !== undefined && resp.esStatusNsId !== null && String(resp.esStatusNsId) !== '') {
      target = rows.find(r => r.netsuiteInternalId === String(resp.esStatusNsId))?.id ?? null;
      source = `esStatusNsId=${resp.esStatusNsId}`;
    } else if (resp.nsStatusId !== undefined && resp.nsStatusId !== null && String(resp.nsStatusId) !== '') {
      target = await resolveEsStatusIdFromNs(resp.nsStatusId as string, false);
      source = `nsStatusId=${resp.nsStatusId}`;
    }

    if (target === null) return;
    await db.update(estimates).set({ esStatusId: target, updatedAt: new Date() } as any)
      .where(eq(estimates.id, estimateId));
    logger.info({ estimateId, esStatusId: target, source }, 'ES Status updated from NetSuite response');
  } catch (err: any) {
    logger.warn({ estimateId, error: err?.message }, 'Could not apply ES Status from NetSuite response');
  }
}
