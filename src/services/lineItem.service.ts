import { eq, and, asc, desc } from 'drizzle-orm';
import { getDb } from '../config/database.js';
import { estimateLineItems } from '../db/schema/index.js';
import { NotFoundError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { syncEstimateToNetsuite } from './netsuiteSync.service.js';

export async function listLineItems(estimateId: number) {
  return getDb().select().from(estimateLineItems)
    .where(eq(estimateLineItems.estimateId, estimateId))
    .orderBy(asc(estimateLineItems.lineNumber));
}

async function getNextLineNumber(estimateId: number) {
  const db = getDb();
  const [last] = await db.select({ lineNumber: estimateLineItems.lineNumber })
    .from(estimateLineItems).where(eq(estimateLineItems.estimateId, estimateId))
    .orderBy(desc(estimateLineItems.lineNumber)).limit(1);
  return last ? last.lineNumber + 1 : 1;
}

export async function addLineItem(estimateId: number, data: Record<string, unknown>) {
  const db = getDb();
  const lineNumber = await getNextLineNumber(estimateId);
  const [item] = await db.insert(estimateLineItems)
    .values({ ...data, estimateId, lineNumber } as any).returning();
  syncEstimateToNetsuite(estimateId, 'update').catch(() => {/* already logged + recorded */});
  return item;
}

export async function bulkInsertLineItems(estimateId: number, items: Record<string, unknown>[]) {
  const db = getDb();
  const startTime = Date.now();
  
  logger.info({ estimateId, itemCount: items.length }, 'Starting bulk line item insert');
  
  try {
    // Use transaction to ensure all-or-nothing behavior
    const result = await db.transaction(async (tx) => {
      // Get starting line number inside transaction to avoid race conditions
      const [last] = await tx.select({ lineNumber: estimateLineItems.lineNumber })
        .from(estimateLineItems).where(eq(estimateLineItems.estimateId, estimateId))
        .orderBy(desc(estimateLineItems.lineNumber)).limit(1);
      let lineNumber = last ? last.lineNumber + 1 : 1;
      
      const inserted: number[] = [];
      const CHUNK = 100; // Insert 100 items at a time for performance
      const totalChunks = Math.ceil(items.length / CHUNK);
      
      for (let i = 0; i < items.length; i += CHUNK) {
        const chunkIndex = Math.floor(i / CHUNK) + 1;
        const chunk = items.slice(i, i + CHUNK).map((item, offset) => ({
          ...item, estimateId, lineNumber: lineNumber + offset,
        }));
        lineNumber += chunk.length;
        
        logger.debug({ estimateId, chunk: chunkIndex, total: totalChunks }, 
          `Inserting chunk ${chunkIndex}/${totalChunks}`);
        
        const rows = await tx.insert(estimateLineItems).values(chunk as any).returning({ id: estimateLineItems.id });
        inserted.push(...rows.map((r) => r.id));
      }
      
      return { inserted: inserted.length, ids: inserted };
    });
    
    const duration = Date.now() - startTime;
    logger.info({ estimateId, inserted: result.inserted, durationMs: duration },
      'Bulk line item insert completed successfully');

    syncEstimateToNetsuite(estimateId, 'update').catch(() => {/* already logged + recorded */});
    return result;

  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error({ estimateId, itemCount: items.length, durationMs: duration, error }, 
      'Bulk line item insert failed - transaction rolled back');
    throw error;
  }
}

export async function updateLineItem(id: number, estimateId: number, data: Record<string, unknown>) {
  const db = getDb();
  const [updated] = await db.update(estimateLineItems)
    .set({ ...data as any, updatedAt: new Date() })
    .where(and(eq(estimateLineItems.id, id), eq(estimateLineItems.estimateId, estimateId)))
    .returning();
  if (!updated) throw new NotFoundError('LineItem', id);
  syncEstimateToNetsuite(estimateId, 'update').catch(() => {/* already logged + recorded */});
  return updated;
}

export async function deleteLineItem(id: number, estimateId: number) {
  const db = getDb();
  await db.update(estimateLineItems).set({ exclude: true, updatedAt: new Date() })
    .where(and(eq(estimateLineItems.id, id), eq(estimateLineItems.estimateId, estimateId)));
  syncEstimateToNetsuite(estimateId, 'update').catch(() => {/* already logged + recorded */});
  return { id, excluded: true };
}
