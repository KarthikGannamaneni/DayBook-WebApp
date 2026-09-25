'use client';

import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The only Supabase client in the app.
 *
 * There is no server here — the site is static files on GitHub Pages — so every
 * read and write goes from the browser with the anon key. That is safe precisely
 * because row-level security is the authorization model: the anon key grants
 * nothing on its own, and every policy resolves to auth.uid(). The pgTAP suite
 * is what proves it.
 */
let cached: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  if (cached) return cached;
  cached = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
  return cached;
}

export const DOCUMENTS_BUCKET = 'documents';

/** A short-lived URL for one document. Storage policies decide if it is allowed. */
export async function signedUrl(storagePath: string): Promise<string | null> {
  const { data } = await supabase().storage.from(DOCUMENTS_BUCKET).createSignedUrl(storagePath, 300);
  return data?.signedUrl ?? null;
}
