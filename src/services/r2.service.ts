import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { env } from '../config/env.js';

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

export async function uploadToR2(
  buffer: Buffer,
  originalFilename: string,
  mimeType: string,
): Promise<UploadResult> {
  const sanitized = originalFilename.replace(/[^\w.\-]/g, '_');
  const key = `uploads/${Date.now()}-${sanitized}`;

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
