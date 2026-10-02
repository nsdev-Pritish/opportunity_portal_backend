import { eq, and, inArray, desc, isNull, sql } from 'drizzle-orm';
import { getDb } from '../config/database.js';
import { estimates, estimateQuotes, estimateLineItems } from '../db/schema/index.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export interface ReceiveQuotePayload {
  estimateInternalId: string;
  estimateDocumentNumber?: string | null;
  quoteInternalId: string;
  quoteDocumentNumber: string;
  lineItemInternalIds?: string[];
}

// ══════════════════════════════════════════════════════════════════════════════
//  QUOTE DELETED IN NETSUITE
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Called when a Quote is DELETED in NetSuite (NetSuite deletes for good; we keep the row).
 *
 * Two things must happen, in this order:
 *   1. Release the line items — converted = false, estimate_quote_id = NULL — so they can be
 *      quoted again. This MUST run before the quote row is flagged, because the lines are
 *      found *through* estimate_quote_id and nothing else records that membership.
 *   2. Soft-delete the quote — is_active = false, deleted_at = now(). The row survives, so
 *      the quote number and NetSuite id stay available for audit and reconciliation.
 *
 * Idempotent: a repeat call finds the quote already inactive and reports 'already_deleted'
 * without touching anything, so NetSuite can retry safely.
 *
 * Lenient on a miss: a quote the portal never stored returns 'not_found' rather than an
 * error, so a delete in NetSuite can never leave their script retrying forever. It is logged
 * at warn level because it usually means the two systems drifted.
 *
 * Note quote_netsuite_internal_id has no unique index (see migration 0039), so in principle
 * more than one row can carry the same NS id — every match is handled.
 */
export async function markQuoteDeletedFromNetsuite(payload: {
  quoteInternalId: string;
  estimateInternalId?: string | null;
}) {
  const db = getDb();
  const { quoteInternalId } = payload;

  const matches = await db
    .select({
      id                 : estimateQuotes.id,
      estimateId         : estimateQuotes.estimateId,
      quoteDocumentNumber: estimateQuotes.quoteDocumentNumber,
      isActive           : estimateQuotes.isActive,
    })
    .from(estimateQuotes)
    .where(eq(estimateQuotes.quoteNetsuiteInternalId, quoteInternalId));

  if (matches.length === 0) {
    logger.warn({ quoteInternalId }, 'NetSuite → Portal: delete for a quote the portal does not have');
    return {
      _action           : 'not_found' as const,
      quoteInternalId,
      releasedLineItems : 0,
      message           : 'No quote with that NetSuite internal id exists in the portal — nothing to do.',
    };
  }

  const pending = matches.filter(q => q.isActive);
  if (pending.length === 0) {
    logger.info({ quoteInternalId }, 'NetSuite → Portal: quote already soft-deleted');
    return {
      _action           : 'already_deleted' as const,
      quoteInternalId,
      quoteIds          : matches.map(q => q.id),
      releasedLineItems : 0,
      message           : 'Quote was already marked deleted — no change.',
    };
  }

  const quoteIds = pending.map(q => q.id);

  const released = await db.transaction(async (tx) => {
    // 1. Release the lines FIRST — they are located via estimate_quote_id.
    const rows = await tx
      .update(estimateLineItems)
      .set({ converted: false, estimateQuoteId: null, updatedAt: new Date() })
      .where(inArray(estimateLineItems.estimateQuoteId, quoteIds))
      .returning({ id: estimateLineItems.id });

    // 2. Then soft-delete the quote row itself.
    await tx
      .update(estimateQuotes)
      .set({ isActive: false, deletedAt: new Date(), updatedAt: new Date() })
      .where(inArray(estimateQuotes.id, quoteIds));

    return rows.map(r => r.id);
  });

  logger.info(
    { quoteInternalId, quoteIds, estimateIds: pending.map(q => q.estimateId), releasedLineItems: released.length },
    'NetSuite → Portal: quote soft-deleted, line items released',
  );

  return {
    _action            : 'deleted' as const,
    quoteInternalId,
    quoteIds,
    estimateIds        : pending.map(q => q.estimateId),
    quoteDocumentNumber: pending[0].quoteDocumentNumber,
    releasedLineItems  : released.length,
    message            : `Quote soft-deleted. ${released.length} line item(s) released back to unconverted.`,
  };
}

/**
 * Called when NetSuite creates a Quote for an existing Estimate.
 *
 * Flow:
 *  1. Locate the portal Estimate by NS internal ID.
 *  2. Idempotency guard — skip if the same quoteInternalId is already stored.
 *  3. In a transaction:
 *     a. Insert a row into estimate_quotes.
 *     b. Set converted = true on every matching line item (by NS line internal ID).
 */
export async function receiveQuoteFromNetsuite(payload: ReceiveQuotePayload) {
  const db = getDb();

  // Step 1 — find the estimate
  const [estimate] = await db
    .select({ id: estimates.id })
    .from(estimates)
    .where(eq(estimates.netsuiteInternalId, payload.estimateInternalId))
    .limit(1);

  if (!estimate) throw new NotFoundError('Estimate', payload.estimateInternalId);

  // Step 2 — idempotency: if this quote already exists, return early
  const [existingQuote] = await db
    .select({ id: estimateQuotes.id })
    .from(estimateQuotes)
    .where(
      and(
        eq(estimateQuotes.estimateId, estimate.id),
        eq(estimateQuotes.quoteNetsuiteInternalId, payload.quoteInternalId),
      ),
    )
    .limit(1);

  if (existingQuote) {
    logger.info(
      { estimateId: estimate.id, quoteInternalId: payload.quoteInternalId },
      'Quote already recorded — returning existing (idempotent)',
    );
    return { id: existingQuote.id, _action: 'already_exists' as const };
  }

  const lineItemIds = payload.lineItemInternalIds ?? [];

  // Step 3 — transactionally insert quote + update line items
  const result = await db.transaction(async (tx) => {
    const [newQuote] = await tx
      .insert(estimateQuotes)
      .values({
        estimateId              : estimate.id,
        quoteNetsuiteInternalId : payload.quoteInternalId,
        quoteDocumentNumber     : payload.quoteDocumentNumber,
        status                  : 'active',
        syncStatus              : 'synced',
        syncedAt                : new Date(),
      })
      .returning();

    let updatedLineItems = 0;
    if (lineItemIds.length > 0) {
      await tx
        .update(estimateLineItems)
        // estimateQuoteId records which quote these lines belong to — same link the portal's
        // own convert path writes, so membership is consistent whichever side created the quote.
        .set({ converted: true, estimateQuoteId: newQuote.id, updatedAt: new Date() })
        .where(
          and(
            eq(estimateLineItems.estimateId, estimate.id),
            inArray(estimateLineItems.netsuiteInternalId, lineItemIds),
          ),
        );
      updatedLineItems = lineItemIds.length;
    }

    return { quote: newQuote, updatedLineItems };
  });

  logger.info(
    {
      estimateId     : estimate.id,
      quoteId        : result.quote.id,
      quoteInternalId: payload.quoteInternalId,
      updatedLineItems: result.updatedLineItems,
    },
    'Quote received from NetSuite — saved successfully',
  );

  return {
    ...result.quote,
    updatedLineItems: result.updatedLineItems,
    _action         : 'created' as const,
  };
}

/**
 * Returns every Quote recorded for a single Estimate, plus a count.
 * Looked up by the Estimate's Portal primary key (estimates.id).
 */
export async function getQuotesForEstimate(estimateId: number) {
  const db = getDb();

  // Locate the portal Estimate by its primary key
  const [estimate] = await db
    .select({
      id                : estimates.id,
      netsuiteInternalId: estimates.netsuiteInternalId,
      documentNumber    : estimates.documentNumber,
    })
    .from(estimates)
    .where(eq(estimates.id, estimateId))
    .limit(1);

  if (!estimate) throw new NotFoundError('Estimate', String(estimateId));

  const quotes = await db
    .select({
      id                 : estimateQuotes.id,
      quoteInternalId    : estimateQuotes.quoteNetsuiteInternalId,
      quoteDocumentNumber: estimateQuotes.quoteDocumentNumber,
      status             : estimateQuotes.status,
      // Diagnostic endpoint — deleted quotes are shown rather than hidden, flagged so the
      // caller can tell a live quote from one NetSuite deleted.
      isActive           : estimateQuotes.isActive,
      deletedAt          : estimateQuotes.deletedAt,
      createdAt          : estimateQuotes.createdAt,
    })
    .from(estimateQuotes)
    .where(eq(estimateQuotes.estimateId, estimate.id))
    .orderBy(desc(estimateQuotes.createdAt));

  return {
    estimateId            : estimate.id,
    estimateInternalId    : estimate.netsuiteInternalId,
    estimateDocumentNumber: estimate.documentNumber,
    quoteCount            : quotes.length,
    quotes,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
//  BULK SYNC — backfill every Quote that already exists in NetSuite
// ══════════════════════════════════════════════════════════════════════════════

/** Max records accepted in a single /sync-all call — NetSuite pages beyond this. */
export const QUOTE_SYNC_MAX_BATCH = 2000;

export interface SyncQuoteRecord {
  /** NS internal id of the parent Estimate. Optional only when estimateDocumentNumber is given. */
  estimateInternalId?: string | null;
  /** NS document number of the parent Estimate — fallback lookup when the internal id is absent/unknown. */
  estimateDocumentNumber?: string | null;
  /** NS internal id of the Quote — the upsert key. */
  quoteInternalId: string;
  quoteDocumentNumber?: string | null;
  /** 'active' (default) | 'replaced' */
  status?: string | null;
  /** NS internal ids of the Estimate line items this Quote covers — flipped to converted = true. */
  lineItemInternalIds?: string[];
}

export interface SyncQuotesOptions {
  /** Resolve and report what WOULD happen without writing anything. */
  dryRun?: boolean;
}

interface QuoteSyncSuccess {
  index              : number;
  quoteInternalId    : string;
  quoteDocumentNumber: string | null;
  action             : 'created' | 'updated' | 'adopted' | 'would_create' | 'would_update';
  quoteId            : number | null;
  estimateId         : number;
  updatedLineItems   : number;
}

interface QuoteSyncFailure {
  index          : number;
  quoteInternalId: string;
  error          : string;
  code           : string;
  statusCode     : number;
}

/**
 * Syncs EVERY Quote that already exists in NetSuite into the portal (backfill).
 *
 * NetSuite runs a saved search over all Quote records and POSTs them here in
 * pages; this endpoint is a bulk UPSERT, so re-running it is always safe.
 *
 * Per record:
 *   1. Resolve the parent Estimate — by estimateInternalId, else by
 *      estimateDocumentNumber. No match → that record fails (the rest continue),
 *      because estimate_quotes.estimate_id is a NOT NULL FK.
 *   2. Locate an existing quote row by quoteInternalId (the NS id).
 *      If none, adopt an orphan row for the same estimate that carries the same
 *      quoteDocumentNumber but no NS id yet — that is an OTB conversion whose
 *      NetSuite write-back never completed.
 *   3. Insert or update the row (document number, status, sync bookkeeping).
 *   4. Mark the supplied line items converted = true.
 *
 * Records are resolved with three bulk pre-fetches, then written one at a time so
 * a single bad record never aborts the batch.
 */
export async function syncAllQuotesFromNetsuite(
  records: SyncQuoteRecord[],
  options: SyncQuotesOptions = {},
) {
  const db      = getDb();
  const dryRun  = options.dryRun === true;
  const started = Date.now();

  if (records.length === 0) throw new ValidationError('No quotes supplied — send at least one record');
  if (records.length > QUOTE_SYNC_MAX_BATCH) {
    throw new ValidationError(
      `Batch too large: ${records.length} quotes (max ${QUOTE_SYNC_MAX_BATCH} per request). Send the quotes in pages.`,
    );
  }

  logger.info({ count: records.length, dryRun }, 'NetSuite → Portal: bulk quote sync started');

  // ── Pre-fetch 1/3 — estimates by NS internal id ────────────────────────────
  const estimateNsIds = [...new Set(
    records.map((r) => r.estimateInternalId).filter((v): v is string => !!v),
  )];
  const estimatesByNsId = new Map<string, number>();
  if (estimateNsIds.length) {
    const rows = await db
      .select({ id: estimates.id, nsId: estimates.netsuiteInternalId })
      .from(estimates)
      .where(inArray(estimates.netsuiteInternalId, estimateNsIds));
    for (const r of rows) if (r.nsId) estimatesByNsId.set(r.nsId, r.id);
  }

  // ── Pre-fetch 2/3 — estimates by document number (fallback lookup) ─────────
  const estimateDocNums = [...new Set(
    records
      .filter((r) => !r.estimateInternalId || !estimatesByNsId.has(r.estimateInternalId))
      .map((r) => r.estimateDocumentNumber)
      .filter((v): v is string => !!v),
  )];
  const estimatesByDocNum = new Map<string, number>();
  if (estimateDocNums.length) {
    const rows = await db
      .select({ id: estimates.id, documentNumber: estimates.documentNumber })
      .from(estimates)
      .where(inArray(estimates.documentNumber, estimateDocNums));
    for (const r of rows) if (r.documentNumber) estimatesByDocNum.set(r.documentNumber, r.id);
  }

  // ── Pre-fetch 3/3 — quote rows already carrying these NS quote ids ─────────
  const quoteNsIds = [...new Set(records.map((r) => r.quoteInternalId).filter(Boolean))];
  const quotesByNsId = new Map<string, number>();
  if (quoteNsIds.length) {
    const rows = await db
      .select({ id: estimateQuotes.id, nsId: estimateQuotes.quoteNetsuiteInternalId })
      .from(estimateQuotes)
      .where(inArray(estimateQuotes.quoteNetsuiteInternalId, quoteNsIds));
    for (const r of rows) if (r.nsId) quotesByNsId.set(r.nsId, r.id);
  }

  const succeeded: QuoteSyncSuccess[] = [];
  const failed   : QuoteSyncFailure[] = [];
  let createdCount = 0;
  let updatedCount = 0;
  let lineItemsConverted = 0;

  for (const [index, rec] of records.entries()) {
    try {
      // 1 — resolve the parent estimate
      const estimateId =
        (rec.estimateInternalId ? estimatesByNsId.get(rec.estimateInternalId) : undefined) ??
        (rec.estimateDocumentNumber ? estimatesByDocNum.get(rec.estimateDocumentNumber) : undefined);

      if (!estimateId) {
        const ref = rec.estimateInternalId ?? rec.estimateDocumentNumber ?? '(none supplied)';
        failed.push({
          index,
          quoteInternalId: rec.quoteInternalId,
          error          : `Parent estimate '${ref}' not found in the portal — sync the estimate first`,
          code           : 'ESTIMATE_NOT_FOUND',
          statusCode     : 404,
        });
        continue;
      }

      const status  = rec.status === 'replaced' ? 'replaced' : 'active';
      const docNum  = rec.quoteDocumentNumber ?? null;
      const lineIds = rec.lineItemInternalIds ?? [];

      // 2 — existing row by NS quote id, else adopt a doc-number match with no NS id
      let existingId: number | null = quotesByNsId.get(rec.quoteInternalId) ?? null;
      let action: QuoteSyncSuccess['action'] = existingId ? 'updated' : 'created';

      if (!existingId && docNum) {
        const [orphan] = await db
          .select({ id: estimateQuotes.id })
          .from(estimateQuotes)
          .where(
            and(
              eq(estimateQuotes.estimateId, estimateId),
              eq(estimateQuotes.quoteDocumentNumber, docNum),
              isNull(estimateQuotes.quoteNetsuiteInternalId),
            ),
          )
          .limit(1);
        if (orphan) {
          existingId = orphan.id;
          action     = 'adopted';
        }
      }

      // 3 + 4 — write the quote row and flip its line items, atomically
      if (dryRun) {
        succeeded.push({
          index,
          quoteInternalId    : rec.quoteInternalId,
          quoteDocumentNumber: docNum,
          action             : existingId ? 'would_update' : 'would_create',
          quoteId            : existingId,
          estimateId,
          updatedLineItems   : 0,
        });
        if (existingId) updatedCount++; else createdCount++;
        continue;
      }

      const written = await db.transaction(async (tx) => {
        let quoteId: number;

        // Concurrency guard — only the INSERT path can race. Two parallel calls
        // carrying the same quoteInternalId both read "no row" in the pre-fetch
        // above and would both insert, since quote_netsuite_internal_id has no
        // unique index to stop them. Take a transaction-scoped advisory lock on
        // the quote id and re-read inside it: the loser blocks until the winner
        // commits, then sees the new row and takes the UPDATE path instead.
        // One extra round trip, and only for records that are actually new.
        if (!existingId) {
          const locked = await tx.execute<{ id: number | null }>(sql`
            WITH lock AS (SELECT pg_advisory_xact_lock(hashtext(${'eq:' + rec.quoteInternalId})))
            SELECT q.id
              FROM lock
              LEFT JOIN estimate_quotes q
                ON q.quote_netsuite_internal_id = ${rec.quoteInternalId}
             LIMIT 1
          `);
          const raced = (locked as unknown as Array<{ id: number | null }>)[0]?.id ?? null;
          if (raced) {
            existingId = raced;
            action     = 'updated';
          }
        }

        if (existingId) {
          // A quote deleted in NetSuite is soft-deleted here and its lines were released.
          // Never resurrect it: leave the row flagged and do not re-convert those lines.
          // NetSuite hard-deletes, so it should not be sending this record at all — this is
          // a guard against a stale saved search re-reporting a deleted quote.
          const [existing] = await tx
            .select({ isActive: estimateQuotes.isActive })
            .from(estimateQuotes)
            .where(eq(estimateQuotes.id, existingId))
            .limit(1);

          if (existing && !existing.isActive) {
            return { quoteId: existingId, converted: 0, skipped: true };
          }

          const [row] = await tx
            .update(estimateQuotes)
            .set({
              estimateId,
              quoteNetsuiteInternalId: rec.quoteInternalId,
              ...(docNum !== null ? { quoteDocumentNumber: docNum } : {}),
              status,
              syncStatus: 'synced',
              syncError : null,
              syncedAt  : new Date(),
              updatedAt : new Date(),
            })
            .where(eq(estimateQuotes.id, existingId))
            .returning({ id: estimateQuotes.id });
          quoteId = row.id;
        } else {
          const [row] = await tx
            .insert(estimateQuotes)
            .values({
              estimateId,
              quoteNetsuiteInternalId: rec.quoteInternalId,
              quoteDocumentNumber    : docNum,
              status,
              syncStatus             : 'synced',
              syncedAt               : new Date(),
            })
            .returning({ id: estimateQuotes.id });
          quoteId = row.id;
        }

        let converted = 0;
        if (lineIds.length) {
          const updated = await tx
            .update(estimateLineItems)
            // estimateQuoteId records which quote these lines belong to — same link the
            // portal's own convert path writes, so membership stays consistent whichever
            // side created the quote.
            .set({ converted: true, estimateQuoteId: quoteId, updatedAt: new Date() })
            .where(
              and(
                eq(estimateLineItems.estimateId, estimateId),
                inArray(estimateLineItems.netsuiteInternalId, lineIds),
              ),
            )
            .returning({ id: estimateLineItems.id });
          converted = updated.length;
        }

        return { quoteId, converted, skipped: false };
      });

      if (written.skipped) {
        logger.warn(
          { quoteInternalId: rec.quoteInternalId, quoteId: written.quoteId },
          'Bulk quote sync: quote is soft-deleted in the portal — left untouched',
        );
      }

      // Keep the map current so a quote repeated inside the SAME payload updates
      // the row the earlier entry created instead of inserting a duplicate.
      quotesByNsId.set(rec.quoteInternalId, written.quoteId);

      if (action === 'created') createdCount++; else updatedCount++;
      lineItemsConverted += written.converted;

      succeeded.push({
        index,
        quoteInternalId    : rec.quoteInternalId,
        quoteDocumentNumber: docNum,
        action,
        quoteId            : written.quoteId,
        estimateId,
        updatedLineItems   : written.converted,
      });
    } catch (err) {
      failed.push({
        index          : index,
        quoteInternalId: rec.quoteInternalId,
        error          : err instanceof Error ? err.message : String(err),
        code           : 'SYNC_FAILED',
        statusCode     : 500,
      });
      logger.error(
        { quoteInternalId: rec.quoteInternalId, error: err instanceof Error ? err.message : String(err) },
        'Bulk quote sync: record failed',
      );
    }
  }

  const summary = {
    dryRun,
    total       : records.length,
    successCount: succeeded.length,
    failureCount: failed.length,
    created     : createdCount,
    updated     : updatedCount,
    lineItemsMarkedConverted: lineItemsConverted,
    durationMs  : Date.now() - started,
    succeeded,
    failed,
  };

  logger.info(
    {
      total: summary.total, created: summary.created, updated: summary.updated,
      failed: summary.failureCount, durationMs: summary.durationMs, dryRun,
    },
    'NetSuite → Portal: bulk quote sync finished',
  );

  return summary;
}

/**
 * Lists the quotes currently stored in the portal — used to verify a backfill.
 * Optional filters: estimateInternalId, quoteDocumentNumber, status. Paginated.
 */
export async function listSyncedQuotes(params: {
  page?: number;
  limit?: number;
  estimateInternalId?: string;
  status?: string;
} = {}) {
  const db     = getDb();
  const page   = params.page  && params.page  > 0 ? params.page  : 1;
  const limit  = params.limit && params.limit > 0 ? Math.min(params.limit, 500) : 50;
  const offset = (page - 1) * limit;

  const filters = [
    params.estimateInternalId ? eq(estimates.netsuiteInternalId, params.estimateInternalId) : undefined,
    params.status ? eq(estimateQuotes.status, params.status) : undefined,
  ].filter(Boolean) as any[];

  const where = filters.length ? and(...filters) : undefined;

  const rows = await db
    .select({
      id                    : estimateQuotes.id,
      quoteInternalId       : estimateQuotes.quoteNetsuiteInternalId,
      quoteDocumentNumber   : estimateQuotes.quoteDocumentNumber,
      status                : estimateQuotes.status,
      syncStatus            : estimateQuotes.syncStatus,
      syncedAt              : estimateQuotes.syncedAt,
      estimateId            : estimates.id,
      estimateInternalId    : estimates.netsuiteInternalId,
      estimateDocumentNumber: estimates.documentNumber,
      createdAt             : estimateQuotes.createdAt,
    })
    .from(estimateQuotes)
    .innerJoin(estimates, eq(estimateQuotes.estimateId, estimates.id))
    .where(where)
    .orderBy(desc(estimateQuotes.createdAt))
    .limit(limit)
    .offset(offset);

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(estimateQuotes)
    .innerJoin(estimates, eq(estimateQuotes.estimateId, estimates.id))
    .where(where);

  return { data: rows, page, limit, total: count };
}

/**
 * Returns all Estimate ↔ Quote mappings for the Portal UI.
 * Response shape matches the GET /api/v1/master/estimate-quotes contract.
 */
export async function getAllEstimateQuoteMappings() {
  return getDb()
    .select({
      estimateInternalId    : estimates.netsuiteInternalId,
      estimateDocumentNumber: estimates.documentNumber,
      quoteInternalId       : estimateQuotes.quoteNetsuiteInternalId,
      quoteDocumentNumber   : estimateQuotes.quoteDocumentNumber,
    })
    .from(estimateQuotes)
    .innerJoin(estimates, eq(estimateQuotes.estimateId, estimates.id))
    // Quotes deleted in NetSuite are soft-deleted here and must not reach the frontend.
    .where(and(eq(estimates.isActive, true), eq(estimateQuotes.isActive, true)))
    .orderBy(desc(estimateQuotes.createdAt));
}
