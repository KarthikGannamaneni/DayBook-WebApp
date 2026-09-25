'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/client';

/**
 * Where the magic link lands. On a static site there is no route handler to
 * exchange the code, so the browser does it.
 */
export default function Callback() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('code');
    if (!code) {
      setError('That link is missing its code. Ask for a new one.');
      return;
    }
    void supabase()
      .auth.exchangeCodeForSession(code)
      .then(({ error: authError }) => {
        if (authError) setError(authError.message);
        else router.replace('/');
      });
  }, [router]);

  return (
    <main>
      <h1>Signing you in</h1>
      {error ? <p role="alert" className="muted">{error}</p> : <p className="muted">One moment…</p>}
    </main>
  );
}
