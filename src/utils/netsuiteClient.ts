/**
 * netsuiteClient.ts
 *
 * Shared low-level NetSuite suitelet client: OAuth 1.0a (TBA) header builder +
 * a thin `postToSuitelet` helper that signs and POSTs a JSON payload.
 *
 * Kept generic so it can be reused by any outbound NetSuite sync flow
 * (estimates, portal entity creates, …) without coupling to a specific payload.
 */

import crypto from 'crypto';
import { env } from '../config/env.js';
import { logger } from './logger.js';

// ── OAuth 1.0a TBA header builder ─────────────────────────────────────────────

export function buildOAuthHeader(method: string, fullUrl: string): string | null {
  const { NS_ACCOUNT_ID, NS_CONSUMER_KEY, NS_CONSUMER_SECRET, NS_TOKEN_ID, NS_TOKEN_SECRET } = env;
  if (!NS_CONSUMER_KEY || !NS_CONSUMER_SECRET || !NS_TOKEN_ID || !NS_TOKEN_SECRET) return null;

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce     = crypto.randomBytes(16).toString('hex');

  // Per OAuth 1.0a spec: base URL must exclude query string; query params
  // must be merged into the normalized parameter string alongside oauth_* params.
  const urlObj  = new URL(fullUrl);
  const baseUrl = `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}`;

  const urlQueryParams: Record<string, string> = {};
  urlObj.searchParams.forEach((v, k) => { urlQueryParams[k] = v; });

  const oauthParams: Record<string, string> = {
    oauth_consumer_key    : NS_CONSUMER_KEY,
    oauth_nonce           : nonce,
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp       : timestamp,
    oauth_token           : NS_TOKEN_ID,
    oauth_version         : '1.0',
  };

  const paramStr = Object.entries({ ...urlQueryParams, ...oauthParams })
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const baseString = [
    method.toUpperCase(),
    encodeURIComponent(baseUrl),
    encodeURIComponent(paramStr),
  ].join('&');

  const signingKey = `${encodeURIComponent(NS_CONSUMER_SECRET)}&${encodeURIComponent(NS_TOKEN_SECRET)}`;
  const signature  = crypto.createHmac('sha256', signingKey).update(baseString).digest('base64');

  const headerParts = Object.entries({ ...oauthParams, oauth_signature: signature })
    .map(([k, v]) => `${k}="${encodeURIComponent(v)}"`)
    .join(', ');

  return `OAuth realm="${NS_ACCOUNT_ID ?? ''}", ${headerParts}`;
}

// ── Generic suitelet POST ──────────────────────────────────────────────────────

/**
 * Signs and POSTs a JSON payload to the configured NetSuite suitelet.
 *
 * `mode` is appended to the URL (matching the existing estimate-sync convention)
 * in addition to whatever `mode` the caller already put in the payload body.
 *
 * Returns the parsed JSON response. Throws when NS_SUITELET_URL is not configured
 * or NetSuite responds with a non-2xx status — callers decide how to handle that.
 */
export async function postToSuitelet<T = Record<string, unknown>>(
  payload: Record<string, unknown>,
  mode: string,
): Promise<T> {
  if (!env.NS_SUITELET_URL) {
    throw new Error('NS_SUITELET_URL not configured');
  }

  // Append mode param — handle URLs that already carry query params (e.g. ?script=&deploy=)
  const url = env.NS_SUITELET_URL.includes('?')
    ? `${env.NS_SUITELET_URL}&mode=${encodeURIComponent(mode)}`
    : `${env.NS_SUITELET_URL}?mode=${encodeURIComponent(mode)}`;

  // OAuth signature must be computed over the exact request URL (including mode param)
  const authHeader = buildOAuthHeader('POST', url);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authHeader) headers['Authorization'] = authHeader;

  // ── Request log: full payload sent to NetSuite ──────────────────────────────
  logger.info({
    mode, url,
    accountId : env.NS_ACCOUNT_ID,
    authHeader: authHeader ? authHeader.substring(0, 80) + '...' : 'MISSING — credentials not set',
    payload,
  }, '→ NetSuite suitelet REQUEST');

  const res = await fetch(url, {
    method : 'POST',
    headers,
    body   : JSON.stringify(payload),
    signal : AbortSignal.timeout(60_000),
  });

  // Read the body once as text so we can log the raw response verbatim,
  // then parse it — covers both non-2xx and unexpected non-JSON bodies.
  const rawBody = await res.text();

  logger.info({
    mode, url,
    status    : res.status,
    ok        : res.ok,
    rawBody,
  }, '← NetSuite suitelet RESPONSE');

  if (!res.ok) {
    throw new Error(`NS suitelet responded ${res.status}: ${rawBody}`);
  }

  try {
    return JSON.parse(rawBody) as T;
  } catch {
    throw new Error(`NS suitelet returned non-JSON body: ${rawBody}`);
  }
}
