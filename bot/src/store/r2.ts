import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { FileStore } from './types.ts';

/**
 * Cloudflare R2 over the S3 API. Chosen over Supabase Storage because the
 * free tiers differ by an order of magnitude — 10 GB against 1 GB, which at
 * the expected volume is seven months of runway against about three weeks.
 * See docs/p0-tech-design.md §5.
 *
 * Originals are stored byte-for-byte. A compressed bill that loses a digit in
 * a dispute is worse than no bill.
 */
export class R2FileStore implements FileStore {
  constructor(private readonly client: S3Client, private readonly bucket: string) {}

  static fromEnv(): R2FileStore {
    const account = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    const bucket = process.env.R2_BUCKET;
    if (!account || !accessKeyId || !secretAccessKey || !bucket) {
      throw new Error('R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET are required');
    }
    return new R2FileStore(
      new S3Client({
        region: 'auto',
        endpoint: `https://${account}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId, secretAccessKey },
      }),
      bucket,
    );
  }

  async put(path: string, bytes: Uint8Array, mimeType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: path, Body: bytes, ContentType: mimeType }),
    );
  }
}
