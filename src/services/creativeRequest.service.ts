/**
 * creativeRequest.service.ts
 *
 * The Estimate's "Creative Requests" tab carries FOUR independent toggles:
 *
 *     deckProduct    → request_type 'deck',  category 'product'
 *     setupProduct   → request_type 'setup', category 'product'
 *     deckPackaging  → request_type 'deck',  category 'packaging'
 *     setupPackaging → request_type 'setup', category 'packaging'
 *
 * Each toggle is ON or OFF independently — a user may enable anywhere from 0 to 4.
 * Every toggle that is ON produces exactly one creative_request header row plus exactly
 * one detail row (creative_request_deck or creative_request_setup). A toggle that is OFF
 * produces NOTHING and its form data is ignored entirely, even if stale state is present.
 *
 * INSERT ONLY. A request is created once. If one already exists for that toggle, a later
 * estimate save leaves it completely untouched and reports it as skipped_exists (or
 * skipped_locked once it has synced to NetSuite). Nothing here ever updates or deletes an
 * existing request, so edits must go through a dedicated endpoint rather than a re-save.
 *
 * Deck and Setup each carry their OWN Requestor. These are never shared or copied between
 * toggles — that was a legacy bug.
 *
 * MASTER-LIST IDS: dropdown fields are sent as the master row's id (requestors.id,
 * new_clients.id, about_us_info.id, creative_request_assets.id,
 * creative_request_scope_work.id). Each id is resolved to its label here, and BOTH the id
 * and the label are stored on the child rows. Plain strings are still accepted so older
 * callers keep working.
 *
 * Called from estimate.service.ts inside the estimate save transaction.
 */

import crypto from 'crypto';
import { and, eq, inArray } from 'drizzle-orm';
import {
  creativeRequest,
  creativeRequestDeck,
  creativeRequestSetup,
  creativeRequestAsset,
  creativeRequestScopeWorkItem,
  creativeRequestAttachment,
  creativeRequestAssets,
  creativeRequestScopeWork,
  requestors,
  newClients,
  aboutUsInfo,
} from '../db/schema/index.js';
import { logger } from '../utils/logger.js';

// ── Toggle definitions ───────────────────────────────────────────────────────

export type RequestType = 'deck' | 'setup';
export type Category = 'product' | 'packaging';

type ToggleDef = { key: string; requestType: RequestType; category: Category };

/**
 * The four canonical toggle keys, in a stable processing order.
 *
 * `aliases` exists because the client's own spec is inconsistent about the Setup toggles —
 * it uses `setupProduct` for one and `artSetupPackaging` for the other ("Art Setup" is the
 * UI label). Accepting both spellings means the frontend can send either without silently
 * dropping a toggle, which would be an invisible data-loss bug.
 */
export const CREATIVE_REQUEST_TOGGLES: (ToggleDef & { aliases: string[] })[] = [
  { key: 'deckProduct',    requestType: 'deck',  category: 'product',   aliases: ['deck_product'] },
  { key: 'setupProduct',   requestType: 'setup', category: 'product',   aliases: ['artSetupProduct', 'setup_product', 'art_setup_product'] },
  { key: 'deckPackaging',  requestType: 'deck',  category: 'packaging', aliases: ['deck_packaging'] },
  { key: 'setupPackaging', requestType: 'setup', category: 'packaging', aliases: ['artSetupPackaging', 'setup_packaging', 'art_setup_packaging'] },
];

// ── Public types ─────────────────────────────────────────────────────────────

/**
 * INSERT-ONLY. A creative request is created once and never rewritten by a later estimate
 * save — if a row already exists for a toggle it is left exactly as it is and reported as
 * skipped. There is deliberately no 'updated' outcome.
 */
export type CreativeRequestAction = 'inserted' | 'skipped_exists' | 'skipped_locked' | 'failed';

export type CreativeRequestResult = {
  toggle: string;
  requestType: RequestType;
  category: Category;
  action: CreativeRequestAction;
  requestId: number | null;
  error?: string;
};

export type CreativeRequestsInput = Record<string, unknown> | null | undefined;

// Minimal structural type — satisfied by both the Drizzle db handle and a tx handle.
type Executor = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
  transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Deterministic idempotency key: sha256 of estimate + toggle identity (hex = 64 chars,
 * exactly the column width). Deterministic so a retry of the same save reproduces the
 * same key rather than creating a second logical request.
 */
export function buildIdempotencyKey(estimateId: number, requestType: RequestType, category: Category): string {
  return crypto.createHash('sha256')
    .update(`${estimateId}:${requestType}:${category}`)
    .digest('hex');
}

const str = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

const yesNo = (v: unknown): 'Yes' | 'No' | null => {
  const s = str(v);
  if (s === null) return null;
  const l = s.toLowerCase();
  if (l === 'yes' || l === 'true' || l === 'y') return 'Yes';
  if (l === 'no' || l === 'false' || l === 'n') return 'No';
  return null;
};

/** A master-list id, whether it arrived as a number or a numeric string. Else null. */
function masterId(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) {
    const n = Number(v.trim());
    return n > 0 ? n : null;
  }
  if (v && typeof v === 'object' && 'id' in (v as any)) return masterId((v as any).id);
  return null;
}

class ToggleValidationError extends Error {}

/** Read the first present alias for a field, so minor payload naming drift doesn't drop data. */
function pick(src: Record<string, unknown>, ...names: string[]): unknown {
  for (const n of names) {
    if (src[n] !== undefined && src[n] !== null && src[n] !== '') return src[n];
  }
  return undefined;
}

/**
 * Any of the master dropdown lists — they all share the (id, name, netsuite_internal_id,
 * ...syncCols) shape, but Drizzle types each table by its literal name, so a helper that
 * works across several of them takes the table structurally. Same approach as getNsId() in
 * netsuiteSync.service.ts.
 */
type MasterTable = any;

/** Look up one master row's name by id. Throws if the id doesn't exist. */
async function masterNameById(tx: Executor, table: MasterTable, id: number, label: string): Promise<string> {
  const rows = await tx.select({ name: table.name }).from(table).where(eq(table.id, id)).limit(1);
  const name = (rows as { name: string }[])[0]?.name;
  if (!name) throw new ToggleValidationError(`Unknown ${label} id ${id}`);
  return name;
}

/**
 * Resolve a Yes/No dropdown. Accepts the master row's id (new_clients / about_us_info) or
 * a literal 'Yes'/'No' string.
 */
async function resolveYesNo(
  tx: Executor, table: MasterTable, value: unknown, label: string,
): Promise<'Yes' | 'No' | null> {
  if (value === undefined || value === null || value === '') return null;

  const id = masterId(value);
  if (id !== null) {
    const name = await masterNameById(tx, table, id, label);
    const yn = yesNo(name);
    if (!yn) throw new ToggleValidationError(`${label} id ${id} is "${name}", which is not Yes/No`);
    return yn;
  }
  return yesNo(value);
}

/**
 * Resolve a multi-select against a master list. Entries may be ids or label strings, and a
 * single non-array value is accepted too. Returns { id, value } pairs: `id` is null when a
 * free-text label matches no master row, which the nullable FK column allows.
 */
async function resolveSelection(
  tx: Executor, table: MasterTable, raw: unknown, label: string,
): Promise<{ id: number | null; value: string }[]> {
  if (raw === undefined || raw === null || raw === '') return [];
  const values = Array.isArray(raw) ? raw : [raw];

  const ids: number[] = [];
  const names: string[] = [];
  for (const v of values) {
    const id = masterId(v);
    if (id !== null) { ids.push(id); continue; }
    const s = str(v);
    if (s !== null) names.push(s);
  }

  const out: { id: number | null; value: string }[] = [];

  if (ids.length) {
    const rows = await tx.select({ id: table.id, name: table.name })
      .from(table).where(inArray(table.id, ids));
    const byId = new Map<number, string>((rows as { id: number; name: string }[]).map(r => [r.id, r.name]));
    for (const id of ids) {
      const name = byId.get(id);
      if (!name) throw new ToggleValidationError(`Unknown ${label} id ${id}`);
      out.push({ id, value: name });
    }
  }

  if (names.length) {
    // Match labels back to the master so the FK is populated where possible; an unmatched
    // label is still stored, with a null id.
    const rows = await tx.select({ id: table.id, name: table.name }).from(table);
    const byName = new Map<string, number>(
      (rows as { id: number; name: string }[]).map(r => [r.name.toLowerCase(), r.id]),
    );
    for (const n of names) out.push({ id: byName.get(n.toLowerCase()) ?? null, value: n });
  }

  // De-duplicate on the stored label.
  const seen = new Set<string>();
  return out.filter(o => (seen.has(o.value.toLowerCase()) ? false : (seen.add(o.value.toLowerCase()), true)));
}

/**
 * Resolve the requestor. Accepts `requestorId`, or a numeric `requestorWrikeId`, or an
 * explicit wrike-id + name pair. When an id is supplied the master row is authoritative for
 * BOTH fields — otherwise a mismatched name could be stored against someone else's id.
 */
async function resolveRequestor(
  tx: Executor, form: Record<string, unknown>,
): Promise<{ wrikeId: string; name: string }> {
  const rawId    = pick(form, 'requestorId', 'requestor_id');
  const rawWrike = pick(form, 'requestorWrikeId', 'requestor_wrike_id', 'wrikeId');
  const rawName  = str(pick(form, 'requestorName', 'requestor_name', 'requestor'));

  const id = masterId(rawId) ?? masterId(rawWrike);
  if (id !== null) {
    const rows = await tx.select({ wrikeId: requestors.wrikeId, name: requestors.name })
      .from(requestors).where(eq(requestors.id, id)).limit(1);
    const row = (rows as { wrikeId: string | null; name: string }[])[0];
    if (!row) throw new ToggleValidationError(`Unknown requestor id ${id}`);
    return { wrikeId: row.wrikeId ?? String(id), name: row.name };
  }

  const wrikeId = str(rawWrike);
  if (!wrikeId) throw new ToggleValidationError('Requestor is required (requestorId or requestorWrikeId)');
  if (!rawName) throw new ToggleValidationError('Requestor is required (requestorName)');
  return { wrikeId, name: rawName };
}

// ── Per-toggle field extraction + validation ─────────────────────────────────

function extractDueDate(form: Record<string, unknown>): string {
  const dueDate = str(pick(form, 'dueDate', 'due_date'));
  if (!dueDate) throw new ToggleValidationError('Due date is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    throw new ToggleValidationError(`Due date must be YYYY-MM-DD, received "${dueDate}"`);
  }
  return dueDate;
}

async function extractDeckDetail(tx: Executor, form: Record<string, unknown>) {
  const itemBudget = str(pick(form, 'itemBudget', 'item_budget', 'estimatedItemBudget'));
  if (!itemBudget) throw new ToggleValidationError('Estimated item budget is required');

  const isFirstTimeClient = await resolveYesNo(
    tx, newClients, pick(form, 'isFirstTimeClient', 'is_first_time_client', 'firstTimeClient', 'newClient', 'newClientId'), 'first-time client',
  );
  if (!isFirstTimeClient) throw new ToggleValidationError('First-time client is required (Yes/No)');

  const includeAboutUs = await resolveYesNo(
    tx, aboutUsInfo, pick(form, 'includeAboutUs', 'include_about_us', 'aboutUs', 'aboutUsId'), 'about us',
  );

  // `scope` is a free-text column. When an id is supplied it is resolved against the scope
  // of work master so the stored value is the label rather than a bare number.
  const rawScope = pick(form, 'scope');
  const scopeId = masterId(rawScope);
  const scope = scopeId !== null
    ? await masterNameById(tx, creativeRequestScopeWork, scopeId, 'scope of work')
    : str(rawScope);

  return {
    itemBudget,
    scope,
    intent:         str(pick(form, 'intent')),
    meetingDetail:  str(pick(form, 'meetingDetail', 'meeting_detail')),
    isFirstTimeClient,
    includeAboutUs,
    formattingPref: str(pick(form, 'formattingPref', 'formatting_pref', 'formatting')),
    dropboxLink:    str(pick(form, 'dropboxLink', 'dropbox_link')),
  };
}

function extractSetupDetail(form: Record<string, unknown>) {
  const raw = pick(form, 'numberOfSetups', 'number_of_setups', 'numSetups');
  const numberOfSetups = raw === undefined ? NaN : Number(raw);
  if (!Number.isInteger(numberOfSetups) || numberOfSetups < 1) {
    throw new ToggleValidationError('Number of setups is required and must be an integer >= 1');
  }

  return {
    numberOfSetups,
    designTrackerLink: str(pick(form, 'designTrackerLink', 'design_tracker_link')),
    whereToSaveLink:   str(pick(form, 'whereToSaveLink', 'where_to_save_link')),
    notes:             str(pick(form, 'notes')),
    dropboxLink:       str(pick(form, 'dropboxLink', 'dropbox_link')),
  };
}

// ── Attachments — additive only ──────────────────────────────────────────────

/**
 * Insert rows only for files not already attached to this request, matched on
 * (file_name, file_size_bytes). Existing rows are NEVER deleted here: a file may already
 * be uploaded to Wrike/NetSuite, so removal is a separate explicit feature.
 */
async function addNewAttachments(tx: Executor, requestId: number, attachments: unknown): Promise<number> {
  if (!Array.isArray(attachments) || attachments.length === 0) return 0;

  const existing = await tx.select({
    fileName: creativeRequestAttachment.fileName,
    fileSizeBytes: creativeRequestAttachment.fileSizeBytes,
  }).from(creativeRequestAttachment).where(eq(creativeRequestAttachment.requestId, requestId));

  const seen = new Set(
    (existing as { fileName: string; fileSizeBytes: number | null }[])
      .map(r => `${r.fileName}::${r.fileSizeBytes ?? ''}`),
  );

  const toInsert: Record<string, unknown>[] = [];
  for (const a of attachments) {
    // file_name is NOT NULL, so an entry with no usable name is skipped rather than failing
    // the whole toggle.
    if (!a || typeof a !== 'object' || Array.isArray(a)) continue;
    const rec = a as Record<string, unknown>;
    const fileName = str(pick(rec, 'name', 'fileName', 'file_name'));
    if (!fileName) continue;

    const sizeRaw = pick(rec, 'sizeBytes', 'fileSizeBytes', 'file_size_bytes', 'size');
    const parsedSize = sizeRaw === undefined ? null : Number(sizeRaw);
    const fileSizeBytes = parsedSize !== null && Number.isFinite(parsedSize) ? parsedSize : null;

    const key = `${fileName}::${fileSizeBytes ?? ''}`;
    if (seen.has(key)) continue;   // already attached — skip, never duplicate
    seen.add(key);

    toInsert.push({
      requestId,
      fileName,
      fileSizeBytes,
      storageUri:        str(pick(rec, 'storageUri', 'storage_uri', 'url')),
      netsuiteFileId:    str(pick(rec, 'netsuiteFileId', 'netsuite_file_id')),
      wrikeAttachmentId: str(pick(rec, 'wrikeAttachmentId', 'wrike_attachment_id')),
    });
  }

  if (toInsert.length) await tx.insert(creativeRequestAttachment).values(toInsert as any);
  return toInsert.length;
}

// ── Single-toggle insert ─────────────────────────────────────────────────────

async function saveOneToggle(
  tx: Executor,
  estimateId: number,
  submittedByUserId: number | null,
  def: ToggleDef,
  form: Record<string, unknown>,
): Promise<CreativeRequestResult> {
  const { requestType, category } = def;
  const base = { toggle: def.key, requestType, category };

  // Validate BEFORE writing anything, and only this toggle's own fields.
  const requestor = await resolveRequestor(tx, form);
  const dueDate   = extractDueDate(form);
  const deckDetail  = requestType === 'deck'  ? await extractDeckDetail(tx, form) : null;
  const setupDetail = requestType === 'setup' ? extractSetupDetail(form)          : null;

  // Selections are resolved for both request types — the child tables key on request_id
  // only and carry no type restriction.
  const assets = await resolveSelection(
    tx, creativeRequestAssets, pick(form, 'selectedAssets', 'selected_assets', 'assets'), 'asset',
  );
  const scopeWork = await resolveSelection(
    tx, creativeRequestScopeWork, pick(form, 'selectedScopeWork', 'selected_scope_work', 'scopeWork'), 'scope of work',
  );

  // Does a row already exist for this toggle? (the UNIQUE constraint guarantees at most one)
  const existingRows = await tx.select({
    id: creativeRequest.id,
    isLocked: creativeRequest.isLocked,
  })
    .from(creativeRequest)
    .where(and(
      eq(creativeRequest.estimateId, estimateId),
      eq(creativeRequest.requestType, requestType),
      eq(creativeRequest.category, category),
    ))
    .limit(1);

  const existing = (existingRows as { id: number; isLocked: boolean }[])[0];

  // INSERT-ONLY: an existing request is never rewritten by a later save. A locked one is
  // reported separately because it has already reached NetSuite.
  if (existing) {
    const action: CreativeRequestAction = existing.isLocked ? 'skipped_locked' : 'skipped_exists';
    logger.warn({ estimateId, requestType, category, requestId: existing.id, action },
      'Creative request already exists — leaving it unchanged');
    return { ...base, action, requestId: existing.id };
  }

  // ── Header ────────────────────────────────────────────────────────────────
  const inserted = await tx.insert(creativeRequest)
    .values({
      estimateId,
      requestType,
      category,
      requestorWrikeId: requestor.wrikeId,
      requestorName: requestor.name,
      dueDate,
      submittedByUserId: submittedByUserId ?? null,
      syncStatus: 'pending',
      idempotencyKey: buildIdempotencyKey(estimateId, requestType, category),
    } as any)
    .returning({ id: creativeRequest.id });

  const requestId = (inserted as { id: number }[])[0].id;

  // ── Detail row ────────────────────────────────────────────────────────────
  // The header was just created, so no detail row can exist yet — a plain insert is safe.
  if (deckDetail) {
    await tx.insert(creativeRequestDeck).values({ requestId, ...deckDetail } as any);
  } else if (setupDetail) {
    await tx.insert(creativeRequestSetup).values({ requestId, ...setupDetail } as any);
  }

  // ── Child selections ──────────────────────────────────────────────────────
  if (assets.length) {
    await tx.insert(creativeRequestAsset)
      .values(assets.map(a => ({ requestId, assetId: a.id, assetValue: a.value })) as any);
  }
  if (scopeWork.length) {
    await tx.insert(creativeRequestScopeWorkItem)
      .values(scopeWork.map(s => ({ requestId, scopeWorkId: s.id, scopeValue: s.value })) as any);
  }

  // ── Attachments ───────────────────────────────────────────────────────────
  await addNewAttachments(tx, requestId, pick(form, 'attachments'));

  return { ...base, action: 'inserted', requestId };
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Process up to four creative-request toggles as part of an estimate save.
 *
 * Each toggle runs inside its OWN savepoint, so a validation or constraint failure on one
 * toggle rolls back only that toggle's rows — the other toggles, and the estimate itself,
 * still commit. Failures are reported in the result array rather than thrown.
 *
 * Returns one entry per ACTIVE toggle. Toggles that are off/absent produce no entry, so a
 * save with zero toggles returns [].
 */
export async function saveCreativeRequests(
  tx: Executor,
  estimateId: number,
  submittedByUserId: number | null,
  creativeRequests: CreativeRequestsInput,
): Promise<CreativeRequestResult[]> {
  if (!creativeRequests || typeof creativeRequests !== 'object') return [];

  const src = creativeRequests as Record<string, unknown>;
  const results: CreativeRequestResult[] = [];

  for (const def of CREATIVE_REQUEST_TOGGLES) {
    // Read the canonical key first, then any accepted alias.
    let form: unknown;
    for (const name of [def.key, ...def.aliases]) {
      if (src[name] !== undefined && src[name] !== null) { form = src[name]; break; }
    }

    // Toggle OFF (null / absent) → skip entirely. Its form data is never read.
    if (form === undefined || form === null) continue;
    if (typeof form !== 'object' || Array.isArray(form)) {
      results.push({
        toggle: def.key, requestType: def.requestType, category: def.category,
        action: 'failed', requestId: null,
        error: `Expected an object for toggle "${def.key}"`,
      });
      continue;
    }

    try {
      // Savepoint per toggle — one toggle's failure must not undo the others.
      const result = await tx.transaction(async (sp: Executor) =>
        saveOneToggle(sp, estimateId, submittedByUserId, def, form as Record<string, unknown>),
      );
      results.push(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ estimateId, toggle: def.key, requestType: def.requestType, category: def.category, err: message },
        'Creative request toggle failed');
      results.push({
        toggle: def.key, requestType: def.requestType, category: def.category,
        action: 'failed', requestId: null, error: message,
      });
    }
  }

  return results;
}

// ── Read helper — used by the estimate detail endpoint ──────────────────────

export async function getCreativeRequestsForEstimate(db: Executor, estimateId: number) {
  const rows = await db.select()
    .from(creativeRequest)
    .where(eq(creativeRequest.estimateId, estimateId));
  return rows;
}
