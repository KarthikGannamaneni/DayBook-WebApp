import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@supabase/supabase-js';
import type { FileStore } from './types.ts';

/**
 * Invoices and payment screenshots in Supabase Storage.
 *
 * Uploaded with the service role, read by the owner through a signed URL the
 * browser mints under its own session. That is what lets the web app be static
 * files with no server anywhere.
 *
 * The original goes up byte-for-byte. A compressed document that loses a digit
 * in a dispute is worse than no document.
 */
export const DOCUMENTS_BUCKET = 'documents';

export class SupabaseFileStore implements FileStore {
  constructor(
    private readonly db: SupabaseClient,
    private readonly bucket = DOCUMENTS_BUCKET,
  ) {}

  static fromEnv(): SupabaseFileStore {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
    return new SupabaseFileStore(createClient(url, key, { auth: { persistSession: false } }));
  }

  async put(path: string, bytes: Uint8Array, mimeType: string): Promise<void> {
    const { error } = await this.db.storage
      .from(this.bucket)
      .upload(path, bytes, { contentType: mimeType, upsert: true });
    if (error) throw new Error(`storage upload: ${error.message}`);
  }
}
