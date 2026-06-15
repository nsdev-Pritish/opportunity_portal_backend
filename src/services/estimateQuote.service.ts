import { eq, and, inArray, desc } from 'drizzle-orm';
import { getDb } from '../config/database.js';
import { estimates, estimateQuotes, estimateLineItems } from '../db/schema/index.js';
import { NotFoundError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export interface ReceiveQuotePayload {
  estimateInternalId: string;
  estimateDocumentNumber?: string | null;
  quoteInternalId: string;
  quoteDocumentNumber: string;
  lineItemInternalIds?: string[];
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
        .set({ converted: true, updatedAt: new Date() })
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
    .where(eq(estimates.isActive, true))
    .orderBy(desc(estimateQuotes.createdAt));
}
