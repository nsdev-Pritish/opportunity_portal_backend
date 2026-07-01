import Fastify, { FastifyInstance, FastifyError } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
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
import estimateQuoteRoutes from './routes/estimateQuotesSearch/index.js';
import invoiceRoutes from './routes/invoiceSearch/index.js';
import nsRoutes       from './routes/netsuite/index.js';
import uploadRoutes   from './routes/upload/index.js';
import portalProjectNames from './routes/portal/projectNames.js';
import portalContacts     from './routes/portal/contacts.js';
import portalAddresses    from './routes/portal/addresses.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ 
    logger: loggerConfig, 
    trustProxy: true, 
    ajv: { customOptions: { strict: false } },
    requestTimeout: 60000, // 60 second timeout for large bulk operations
    bodyLimit: 5 * 1024 * 1024, // 5MB max payload size for bulk line items
  });

  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } }); // 50 MB cap
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: process.env.CORS_ORIGIN ?? true,
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  });
  await app.register(rateLimit, {
    global: true, max: 200, timeWindow: 60_000,
    redis: getRedis(),
    keyGenerator: (req) => (req.headers['x-forwarded-for'] as string) ?? req.ip,
    allowList: (req) =>
      req.url.startsWith('/api/v1/netsuite') ||
      req.url.startsWith('/api/v1/estimate-quotes') ||
      req.url.startsWith('/api/v1/invoices'),
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
    async (inst) => {3
      // TODO(auth): line-item routes are temporarily UNAUTHENTICATED. Re-enable by
      // uncommenting the hook below.
      // inst.addHook('preHandler', inst.authenticate);
      await inst.register(lineItemRoutes, { prefix: '/' });
    },
    { prefix: '/api/v1/estimates/:estimateId/line-items' },
  );
  await app.register(estimateQuoteRoutes, { prefix: '/api/v1/estimate-quotes' });
  await app.register(invoiceRoutes, { prefix: '/api/v1/invoices' });

  // ── File upload (JWT auth) ────────────────────────────────────
  await app.register(uploadRoutes, { prefix: '/api/v1/upload' });
  await app.register(portalProjectNames, { prefix: '/api/v1/portal/projectNames' });
  await app.register(portalContacts,     { prefix: '/api/v1/portal/contacts' });
  await app.register(portalAddresses,    { prefix: '/api/v1/portal/addresses' });

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

    // PostgreSQL foreign key violation — one of the provided IDs does not exist in its table
    const dbCode = (err as any)?.cause?.code ?? (err as any)?.code;
    if (dbCode === '23503') {
      const detail = (err as any)?.cause?.detail ?? (err as any)?.detail ?? '';
      return reply.status(400).send({ error: 'Invalid reference: one of the provided IDs does not exist', code: 'INVALID_REFERENCE', detail });
    }

    // PostgreSQL unique constraint violation
    if (dbCode === '23505') {
      const detail = (err as any)?.cause?.detail ?? (err as any)?.detail ?? '';
      return reply.status(409).send({ error: 'Duplicate entry: a record with this value already exists', code: 'DUPLICATE_ENTRY', detail });
    }

    logger.error({ err, url: req.url, method: req.method }, 'Unhandled error');
    return reply.status(500).send({ error: 'Internal Server Error', code: 'INTERNAL_ERROR' });
  });

  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send({ error: `Route ${req.method} ${req.url} not found`, code: 'NOT_FOUND' }),
  );

  return app;
}
