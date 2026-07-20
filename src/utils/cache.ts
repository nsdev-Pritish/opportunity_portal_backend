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

export async function invalidateDropdown(entity: string, scopeId?: number) {
  await cacheDel(CacheKeys.dropdown(entity));
  if (scopeId) await cacheDel(CacheKeys.dropdownScoped(entity, scopeId));
  await cacheDel(CacheKeys.allDropdowns());
}
