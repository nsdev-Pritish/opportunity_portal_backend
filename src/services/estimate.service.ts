import { eq, and, desc, like, or, count } from 'drizzle-orm';
import { getDb } from '../config/database.js';
import { estimates, customers, employees } from '../db/schema/index.js';
import { cacheAside, cacheDel, CacheKeys } from '../utils/cache.js';
import { env } from '../config/env.js';
import { NotFoundError } from '../utils/errors.js';

export async function listEstimates(opts: { page: number; limit: number; search?: string; status?: string; customerId?: number }) {
  const db = getDb();
  const offset = (opts.page - 1) * opts.limit;
  const conditions: any[] = [eq(estimates.isActive, true)];
  if (opts.status)     conditions.push(eq(estimates.status, opts.status as any));
  if (opts.customerId) conditions.push(eq(estimates.customerId, opts.customerId));
  if (opts.search)     conditions.push(or(like(estimates.projectName, `%${opts.search}%`), like(estimates.customerPo, `%${opts.search}%`))!);

  const [rows, [{ total }]] = await Promise.all([
    db.select({
      id: estimates.id, netsuiteInternalId: estimates.netsuiteInternalId,
      projectName: estimates.projectName, status: estimates.status,
      customerPo: estimates.customerPo, projectedTotalAmt: estimates.projectedTotalAmt,
      expectedCloseDate: estimates.expectedCloseDate, createdAt: estimates.createdAt,
      customerName: customers.name,
    })
    .from(estimates)
    .leftJoin(customers, eq(estimates.customerId, customers.id))
    .where(and(...conditions))
    .orderBy(desc(estimates.updatedAt))
    .limit(opts.limit).offset(offset),
    db.select({ total: count() }).from(estimates).where(and(...conditions)),
  ]);

  return { data: rows, pagination: { page: opts.page, limit: opts.limit, total: Number(total) } };
}

export async function getEstimate(id: number) {
  return cacheAside(CacheKeys.estimate(id), env.CACHE_TTL_ESTIMATE, async () => {
    const db = getDb();
    const [row] = await db.select().from(estimates)
      .leftJoin(customers, eq(estimates.customerId, customers.id))
      .where(eq(estimates.id, id)).limit(1);
    if (!row) throw new NotFoundError('Estimate', id);
    return row;
  });
}

export async function createEstimate(data: Record<string, unknown>) {
  const db = getDb();
  const [record] = await db.insert(estimates).values({ ...data, source: 'portal' } as any).returning();
  return record;
}

export async function updateEstimate(id: number, data: Record<string, unknown>) {
  const db = getDb();
  const [updated] = await db.update(estimates)
    .set({ ...data as any, updatedAt: new Date() })
    .where(eq(estimates.id, id)).returning();
  if (!updated) throw new NotFoundError('Estimate', id);
  await cacheDel(CacheKeys.estimate(id));
  return updated;
}

export async function deactivateEstimate(id: number) {
  const db = getDb();
  await db.update(estimates).set({ isActive: false, updatedAt: new Date() }).where(eq(estimates.id, id));
  await cacheDel(CacheKeys.estimate(id));
  return { id, isActive: false };
}
