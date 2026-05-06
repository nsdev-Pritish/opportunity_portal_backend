import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from './env.js';
import * as schema from '../db/schema/index.js';

let _client: ReturnType<typeof postgres> | null = null;
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (!_db) {
    _client = postgres(env.DATABASE_URL, {
      max: 20,
      idle_timeout: 30,
      connect_timeout: 30, // Increased for Render.com (database may need to spin up)
      prepare: false, // Required for transaction support with Drizzle
    });
    _db = drizzle(_client, { schema, logger: env.NODE_ENV === 'development' });
  }
  return _db;
}

export async function closeDb() {
  if (_client) {
    await _client.end();
    _client = null;
    _db = null;
  }
}

export type DB = ReturnType<typeof getDb>;
