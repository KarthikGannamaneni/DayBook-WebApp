import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

/**
 * Server-side Supabase client, carrying the signed-in user's session from
 * cookies. Everything the web app reads goes through this, so row-level
 * security is what decides what comes back — the UI never filters by owner
 * itself. A check that exists only in React is a convenience, not security.
 */
export async function supabaseServer() {
  const store = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => store.getAll(),
        setAll: (items) => {
          try {
            for (const { name, value, options } of items) store.set(name, value, options);
          } catch {
            // Called from a server component, where cookies are read-only.
            // Middleware refreshes the session instead.
          }
        },
      },
    },
  );
}

export async function requireUser() {
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getUser();
  return data.user ?? null;
}
