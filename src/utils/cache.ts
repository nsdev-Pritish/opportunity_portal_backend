import { getRedis } from '../config/redis.js';
import { env } from '../config/env.js';

// Namespace every key with the per-environment prefix (e.g. "prod:", "sandbox:") so
// multiple services sharing one Redis instance never read or overwrite each other's keys.
const PREFIX = env.CACHE_PREFIX ?? '';

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const v = await getRedis().get(key);
    return v ? JSON.parse(v) as T : null;
  } catch { return null; }
}

export async function cacheSet(key: string, value: unknown, ttl: number) {
  try { await getRedis().setex(key, ttl, JSON.stringify(value)); } catch {}
}

export async function cacheDel(...keys: string[]) {
  if (keys.length) await getRedis().del(...keys).catch(() => {});
}

export async function cacheDelPattern(pattern: string) {
  const keys = await getRedis().keys(`${PREFIX}${pattern}`).catch(() => [] as string[]);
  if (keys.length) await getRedis().del(...keys).catch(() => {});
}

export async function cacheAside<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
  const cached = await cacheGet<T>(key);
  if (cached !== null) return cached;
  const fresh = await fn();
  await cacheSet(key, fresh, ttl);
  return fresh;
}

export const CacheKeys = {
  dropdown      : (entity: string) => `${PREFIX}dd:${entity}:active`,
  dropdownScoped: (entity: string, id: number) => `${PREFIX}dd:${entity}:${id}`,
  allDropdowns  : () => `${PREFIX}dd:all`,
  estimate      : (id: number) => `${PREFIX}est:${id}`,
};

// Clears EVERY cached list for this entity: the unscoped `dd:<entity>:active` AND every
// scoped `dd:<entity>:<id>` (per-customer addresses and contacts, per-vendor factories and
// addresses, per-country states).
//
// The scoped keys used to survive every invalidation. This took an optional scopeId and only
// cleared the scoped key when given one — but no caller anywhere passed it, because a generic
// "update this master record" path has no idea which customer or vendor the row belongs to.
// So a per-customer dropdown kept serving its stale list until CACHE_TTL_DROPDOWN expired:
// an address synced from NetSuite was invisible in the Ship To / Bill To dropdown for up to
// five minutes. Matching by pattern needs no caller to know the scope id.
//
// The trailing colon keeps sibling entities apart — `dd:product_classes:*` does not match
// `dd:product_classes_eu:active`.
export async function invalidateDropdown(entity: string) {
  await cacheDelPattern(`dd:${entity}:*`);
  await cacheDel(CacheKeys.allDropdowns());
}
