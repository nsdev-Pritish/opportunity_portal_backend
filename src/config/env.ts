import { z } from 'zod';
import * as dotenv from 'dotenv';
dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  DATABASE_URL: z.string().url(),

  REDIS_URL: z.string().default('redis://localhost:6379'),
  REDIS_PASSWORD: z.string().optional(),
  // Per-environment cache-key namespace so prod & sandbox can safely share ONE Redis
  // instance without colliding. Set e.g. "prod:" on production and "sandbox:" on the
  // sandbox service. Empty (default) = no prefix (keeps local/dev behaviour unchanged).
  CACHE_PREFIX: z.string().default(''),

  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('7d'),

  // ── API Key that NetSuite uses to authenticate with our APIs ──
  // Run: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  // Paste the output here AND share with NetSuite integration team
  NS_API_KEY: z.string().min(16),

  // ── Portal → NetSuite outbound sync (all optional) ──────────────
  // URL of the NetSuite suitelet that accepts estimate creates/updates
  NS_SUITELET_URL: z.string().url().optional(),
  // NetSuite account ID (realm) used in OAuth TBA header
  NS_ACCOUNT_ID: z.string().optional(),
  // TBA credentials — required only if NS_SUITELET_URL is set
  NS_CONSUMER_KEY: z.string().optional(),
  NS_CONSUMER_SECRET: z.string().optional(),
  NS_TOKEN_ID: z.string().optional(),
  NS_TOKEN_SECRET: z.string().optional(),

  CACHE_TTL_DROPDOWN: z.coerce.number().default(300),
  CACHE_TTL_ESTIMATE: z.coerce.number().default(120),

  // ── Cloudflare R2 Storage ──
  R2_ACCOUNT_ID: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_BUCKET_NAME: z.string().min(1),
  R2_PUBLIC_URL: z.string().url(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌  Invalid environment variables:');
  console.error(JSON.stringify(parsed.error.flatten().fieldErrors, null, 2));
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
