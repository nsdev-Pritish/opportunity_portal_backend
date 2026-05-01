import { buildApp } from './app.js';
import { env } from './config/env.js';
import { getDb } from './config/database.js';
import { closeDb } from './config/database.js';
import { getRedis, closeRedis } from './config/redis.js';
import { logger } from './utils/logger.js';
import { sql } from 'drizzle-orm';

async function main() {
  try { await getDb().execute(sql`SELECT 1`); logger.info('✅ PostgreSQL connected'); }
  catch (err) { logger.fatal({ err }, '❌ PostgreSQL connection failed'); process.exit(1); }

  try { await getRedis().ping(); logger.info('✅ Redis connected'); }
  catch (err) { logger.fatal({ err }, '❌ Redis connection failed'); process.exit(1); }

  const app = await buildApp();
  await app.listen({ port: env.PORT, host: env.HOST });
  logger.info(`🚀 PRISM Backend running at http://${env.HOST}:${env.PORT}`);
  logger.info(`📚 Swagger docs: http://${env.HOST}:${env.PORT}/docs`);

  const shutdown = async (sig: string) => {
    logger.info({ sig }, 'Shutting down...');
    await app.close(); await closeDb(); await closeRedis();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('uncaughtException',   (err)    => { logger.fatal({ err }, 'Uncaught exception');         process.exit(1); });
  process.on('unhandledRejection',  (reason) => { logger.fatal({ reason }, 'Unhandled rejection');     process.exit(1); });
}

main();
