'use client';

import type { User } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';
import { supabase } from './client';

/**
 * Who is signed in, or null. `undefined` while we are still finding out —
 * the three states matter, because redirecting on `null` before the session
 * has loaded would bounce a signed-in user back to the sign-in screen on
 * every refresh.
 */
export function useSession(): { user: User | null | undefined } {
  const [user, setUser] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    const client = supabase();
    void client.auth.getUser().then(({ data }) => setUser(data.user ?? null));
    const { data: sub } = client.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  return { user };
}
