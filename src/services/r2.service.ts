import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import crypto from 'crypto';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';

let _client: S3Client | null = null;

function getR2Client(): S3Client {
  if (!_client) {
    _client = new S3Client({
      region: 'auto',
      endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return _client;
}

export interface UploadResult {
  name: string;
  url: string;
  size: number;
  type: string;
}

const sanitizeFilename = (name: string) => name.replace(/[^\w.\-]/g, '_');

/**
 * Upload a buffer to R2 and return its public URL plus the metadata the callers store.
 *
 * `keyPrefix` is optional and defaults to 'uploads', which reproduces the original key
 * layout exactly — the three existing call sites (POST /upload/file and the two estimate
 * multipart branches) pass three arguments and are unaffected.
 */
export async function uploadToR2(
  buffer: Buffer,
  originalFilename: string,
  mimeType: string,
  keyPrefix = 'uploads',
): Promise<UploadResult> {
  const key = `${keyPrefix}/${Date.now()}-${sanitizeFilename(originalFilename)}`;

  await getR2Client().send(
    new PutObjectCommand({
      Bucket: env.R2_BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
      ContentLength: buffer.length,
    }),
  );

  return {
    name: originalFilename,
    url: `${env.R2_PUBLIC_URL}/${key}`,
    size: buffer.length,
    type: mimeType,
  };
}

// ── Creative-request attachments ─────────────────────────────────────────────

/**
 * Per-file cap for creative-request attachments: 10 MB, from the field-mapping spec.
 * Deliberately lower than the 50 MB Fastify multipart limit in app.ts, which still governs
 * estimate-level uploads — raising or lowering that global would change existing behaviour.
 */
export const CREATIVE_REQUEST_MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Upload one creative-request attachment.
 *
 * Two differences from the generic path, both deliberate:
 *
 *   1. The size cap is enforced BEFORE the PutObject call, so a rejected file costs no
 *      bandwidth and leaves no orphaned object behind.
 *   2. The key carries a random UUID rather than only a timestamp. The bucket is served
 *      over a public r2.dev URL, and `{timestamp}-{filename}` is guessable by anyone who
 *      knows the filename — a narrow timestamp window is a small search space. These are
 *      client artwork and packaging decks, so the key itself has to carry the entropy.
 *
 * Keys are laid out as creative-requests/{estimateId}/{toggle}/{uuid}-{filename} so a
 * prefix listing or lifecycle rule can target one estimate, one toggle, or the whole
 * feature — the reason a separate bucket was not needed.
 *
 * `estimateId` is null on CREATE, where the estimate has no id until the transaction
 * commits. That segment is then OMITTED — creative-requests/{toggle}/{uuid}-{filename} —
 * rather than filled with a placeholder. An earlier version wrote a literal "pending"
 * segment, which left a permanent pending/ folder in the bucket that read like a queue
 * needing to be drained when in fact those files were already fully attached.
 *
 * Consequence: keys come in two depths. Files added on create have no estimate segment;
 * files added by a PATCH or by the attachments endpoint do. Either way the row in
 * creative_request_attachment is what ties an object to its request, so nothing depends on
 * the key shape — it is for humans browsing the bucket and for lifecycle rules.
 */
export async function uploadCreativeRequestFile(
  buffer: Buffer,
  originalFilename: string,
  mimeType: string,
  estimateId: number | null,
  toggle: string,
): Promise<UploadResult> {
  if (buffer.length > CREATIVE_REQUEST_MAX_FILE_BYTES) {
    // Byte count included alongside the MB figure: a file a few bytes over the cap rounds
    // to "10.0 MB", and a message reading "is 10.0 MB — the limit is 10 MB" looks like a bug
    // rather than a rejection the caller can act on.
    const mb = (buffer.length / 1024 / 1024).toFixed(1);
    throw new AppError(
      `"${originalFilename}" is ${mb} MB (${buffer.length} bytes) — the limit for creative request attachments is 10 MB (${CREATIVE_REQUEST_MAX_FILE_BYTES} bytes)`,
      400,
      'FILE_TOO_LARGE',
    );
  }

  // Segments joined after dropping the empty one, so a null estimateId collapses the path
  // instead of inserting a placeholder.
  const key = [
    'creative-requests',
    estimateId === null ? null : String(estimateId),
    sanitizeFilename(toggle),
    `${crypto.randomUUID()}-${sanitizeFilename(originalFilename)}`,
  ].filter(Boolean).join('/');

  await getR2Client().send(
    new PutObjectCommand({
      Bucket: env.R2_BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
      ContentLength: buffer.length,
    }),
  );

  return {
    name: originalFilename,
    url: `${env.R2_PUBLIC_URL}/${key}`,
    size: buffer.length,
    type: mimeType,
  };
}

// ── Inline (base64) attachments ──────────────────────────────────────────────

/**
 * A data: URI as sent by the legacy RESTlet payload — `data:text/plain;base64,Q3Jl…`.
 *
 * Group 1 = MIME type (may be empty: "data:,abc" is legal), group 2 = the ;base64 marker
 * if present, group 3 = the payload. A data URI without ;base64 is percent-encoded text,
 * which is legal and handled below rather than rejected.
 */
const DATA_URI_RE = /^data:([^;,]*)((?:;[^,]*)*),(.*)$/s;

export type InlineFile = { buffer: Buffer; mimeType: string | null };

/**
 * Decode a data: URI into raw bytes. Returns null if the string is not a data URI at all,
 * so callers can distinguish "this is a plain URL, leave it alone" from "this is malformed".
 *
 * Throws on a data URI whose payload will not decode — silently storing an empty file would
 * be worse than a 400, because the row would look successful while the object is garbage.
 */
export function decodeDataUri(value: string): InlineFile | null {
  const m = DATA_URI_RE.exec(value.trim());
  if (!m) return null;

  const [, mime, params, payload] = m;
  const isBase64 = /(^|;)base64($|;)/.test(params);

  let buffer: Buffer;
  if (isBase64) {
    // Strip whitespace/newlines first: a base64 blob pasted from a file often wraps, and
    // Buffer.from ignores invalid characters silently rather than failing loudly.
    const clean = payload.replace(/\s/g, '');
    buffer = Buffer.from(clean, 'base64');
    // Round-tripping catches a truncated or corrupted blob, which Buffer.from would
    // otherwise decode to a short buffer without complaint.
    if (buffer.length === 0 && clean.length > 0) {
      throw new AppError('Attachment data is not valid base64', 400, 'INVALID_ATTACHMENT_DATA');
    }
  } else {
    try {
      buffer = Buffer.from(decodeURIComponent(payload), 'utf8');
    } catch {
      throw new AppError('Attachment data is not a valid data URI payload', 400, 'INVALID_ATTACHMENT_DATA');
    }
  }

  return { buffer, mimeType: mime || null };
}

/**
 * Turn one attachment entry into stored-file metadata.
 *
 * Handles the three shapes a caller can send, in priority order:
 *
 *   1. { name, type, size, data: "data:…;base64,…" }  — inline bytes (legacy RESTlet).
 *      Decoded here and uploaded to R2.
 *   2. { name, url, size, type }                      — already uploaded (e.g. via
 *      POST /api/v1/upload/file). Passed through untouched; no second upload.
 *   3. anything else                                  — returned as-is for the service
 *      layer to validate or skip, so one odd entry cannot fail the whole toggle.
 *
 * IMPORTANT: `size` from the caller is treated as a HINT, not the truth. The stored size is
 * always the decoded byte length. The legacy payload's `size` is the pre-encoding length and
 * can disagree with what actually arrived; trusting it would put a wrong number in the
 * column and, worse, let an oversized file through the 10 MB check by understating itself.
 */
export async function materializeAttachment(
  entry: unknown,
  estimateId: number | null,
  toggle: string,
): Promise<unknown> {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
  const rec = entry as Record<string, unknown>;

  const rawData = rec.data ?? rec.base64 ?? rec.content;
  if (typeof rawData !== 'string' || rawData === '') return entry;

  const name = String(rec.name ?? rec.fileName ?? rec.file_name ?? 'file');
  const declaredType = typeof rec.type === 'string' ? rec.type : null;

  const decoded = decodeDataUri(rawData);
  if (!decoded) {
    throw new AppError(
      `Attachment "${name}" has a "data" field that is not a data: URI. Send data:<mime>;base64,<payload> or use "url" for an already-uploaded file.`,
      400,
      'INVALID_ATTACHMENT_DATA',
    );
  }

  // The caller's declared `type` wins over the one embedded in the URI: the frontend reports
  // the browser's File.type, while the URI prefix is often a generic default.
  const mimeType = declaredType || decoded.mimeType || 'application/octet-stream';

  // Enforces the 10 MB cap on the DECODED length, before the upload.
  const uploaded = await uploadCreativeRequestFile(decoded.buffer, name, mimeType, estimateId, toggle);

  return { name: uploaded.name, url: uploaded.url, size: uploaded.size, type: uploaded.type };
}
