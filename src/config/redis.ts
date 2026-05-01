import Redis from 'ioredis';
import { env } from './env.js';

let _redis: Redis | null = null;

export function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis(env.REDIS_URL, {
      password: env.REDIS_PASSWORD || undefined,
      maxRetriesPerRequest: 3,
      retryStrategy: (t) => (t > 5 ? null : Math.min(t * 200, 2000)),
    });
    _redis.on('error', (e) => console.error('Redis error:', e.message));
  }
  return _redis;
}

export async function closeRedis() {
  if (_redis) { await _redis.quit(); _redis = null; }
}
