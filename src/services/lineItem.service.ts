import { eq, and, asc, desc } from 'drizzle-orm';
import { getDb } from '../config/database.js';
import { estimateLineItems } from '../db/schema/index.js';
import { NotFoundError } from '../utils/errors.js';

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
  return item;
}

export async function bulkInsertLineItems(estimateId: number, items: Record<string, unknown>[]) {
  const db = getDb();
  let lineNumber = await getNextLineNumber(estimateId);
  const inserted: number[] = [];
  const CHUNK = 100;
  for (let i = 0; i < items.length; i += CHUNK) {
    const chunk = items.slice(i, i + CHUNK).map((item, offset) => ({
      ...item, estimateId, lineNumber: lineNumber + offset,
    }));
    lineNumber += chunk.length;
    const rows = await db.insert(estimateLineItems).values(chunk as any).returning({ id: estimateLineItems.id });
    inserted.push(...rows.map((r) => r.id));
  }
  return { inserted: inserted.length };
}

export async function updateLineItem(id: number, estimateId: number, data: Record<string, unknown>) {
  const db = getDb();
  const [updated] = await db.update(estimateLineItems)
    .set({ ...data as any, updatedAt: new Date() })
    .where(and(eq(estimateLineItems.id, id), eq(estimateLineItems.estimateId, estimateId)))
    .returning();
  if (!updated) throw new NotFoundError('LineItem', id);
  return updated;
}

export async function deleteLineItem(id: number, estimateId: number) {
  const db = getDb();
  await db.update(estimateLineItems).set({ exclude: true, updatedAt: new Date() })
    .where(and(eq(estimateLineItems.id, id), eq(estimateLineItems.estimateId, estimateId)));
  return { id, excluded: true };
}
