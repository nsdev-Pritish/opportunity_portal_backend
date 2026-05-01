import { FastifyRequest, FastifyReply } from 'fastify';
import { env } from '../config/env.js';

/**
 * Middleware that validates the X-API-Key header on all /api/v1/netsuite/* routes.
 *
 * NetSuite SuiteScript sets this header on every request:
 *   request.setHeader('X-API-Key', 'your-key-from-env');
 *
 * The key must match NS_API_KEY in your .env file.
 */
export async function apiKeyAuth(req: FastifyRequest, reply: FastifyReply) {
  const key = req.headers['x-api-key'] as string | undefined;

  if (!key) {
    return reply.status(401).send({
      error: 'Missing X-API-Key header',
      code: 'MISSING_API_KEY',
    });
  }

  // Simple constant-time comparison to prevent timing attacks
  const expected = env.NS_API_KEY;
  if (key.length !== expected.length || !timingSafeEqual(key, expected)) {
    return reply.status(401).send({
      error: 'Invalid API key',
      code: 'INVALID_API_KEY',
    });
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ (b.charCodeAt(i) || 0);
  }
  return result === 0;
}
