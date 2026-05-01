import Fastify, { FastifyInstance, FastifyError } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

import authPlugin from './plugins/auth.plugin.js';
import { getRedis } from './config/redis.js';
import { loggerConfig, logger } from './utils/logger.js';
import { AppError } from './utils/errors.js';
import { ZodError } from 'zod';

import authRoutes     from './routes/auth/index.js';
import masterRoutes   from './routes/master/index.js';
import estimateRoutes from './routes/estimates/index.js';
import lineItemRoutes from './routes/estimates/lineItems.js';
import nsRoutes       from './routes/netsuite/index.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: loggerConfig, trustProxy: true, ajv: { customOptions: { strict: false } } });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: process.env.CORS_ORIGIN ?? true, credentials: true });
  await app.register(rateLimit, {
    global: true, max: 200, timeWindow: 60_000,
    redis: getRedis(),
    keyGenerator: (req) => (req.headers['x-forwarded-for'] as string) ?? req.ip,
  });

  await app.register(swagger, {
    openapi: {
      info: { title: 'PRISM API', description: 'OBC Commercialization Platform', version: '1.0.0' },
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' } } },
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  await app.register(authPlugin);

  // ── Portal UI routes (JWT auth) ───────────────────────────────
  await app.register(authRoutes,     { prefix: '/api/v1/auth' });
  await app.register(masterRoutes,   { prefix: '/api/v1/master' });
  await app.register(estimateRoutes, { prefix: '/api/v1/estimates' });
  await app.register(
    async (inst) => {
      inst.addHook('preHandler', inst.authenticate);
      await inst.register(lineItemRoutes, { prefix: '/' });
    },
    { prefix: '/api/v1/estimates/:estimateId/line-items' },
  );

  // ── NetSuite-facing routes (X-API-Key auth) ───────────────────
  await app.register(nsRoutes, { prefix: '/api/v1/netsuite' });

  app.get('/health', { logLevel: 'silent' }, async () => ({
    status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString(),
  }));

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof ZodError)
      return reply.status(400).send({ error: 'Validation Error', code: 'VALIDATION_ERROR', details: err.flatten().fieldErrors });
    if (err instanceof AppError)
      return reply.status(err.statusCode).send({ error: err.message, code: err.code ?? 'ERROR' });
    if (err.validation)
      return reply.status(400).send({ error: 'Request validation failed', code: 'VALIDATION_ERROR', details: err.validation });
    logger.error({ err, url: req.url, method: req.method }, 'Unhandled error');
    return reply.status(500).send({ error: 'Internal Server Error', code: 'INTERNAL_ERROR' });
  });

  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send({ error: `Route ${req.method} ${req.url} not found`, code: 'NOT_FOUND' }),
  );

  return app;
}
