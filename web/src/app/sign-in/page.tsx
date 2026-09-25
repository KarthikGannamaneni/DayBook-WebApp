'use client';

import { createBrowserClient } from '@supabase/ssr';
import { useState } from 'react';

/**
 * Email magic link. Phone OTP needs an SMS provider and, in India, DLT
 * registration of sender ids and templates — weeks of lead time. Email is free
 * and works today, so P0 starts there.
 */
export default function SignIn() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (!email.includes('@')) {
      setError('Enter a valid email address');
      return;
    }
    setBusy(true);
    setError(null);

    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
    const { error: authError } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });

    setBusy(false);
    if (authError) setError(authError.message);
    else setSent(true);
  }

  return (
    <main>
      <h1>Sign in</h1>
      <p className="muted">We send a link. There is no password to forget.</p>

      {sent ? (
        <p style={{ marginTop: 24 }} role="status">
          Check {email} for the link. It expires in an hour.
        </p>
      ) : (
        <form onSubmit={send} style={{ marginTop: 24, maxWidth: 360 }}>
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
          {error && (
            <p role="alert" style={{ color: '#a32d2d', fontSize: 14 }}>
              {error}
            </p>
          )}
          <button className="btn" style={{ marginTop: 14 }} disabled={busy}>
            {busy ? 'Sending…' : 'Send link'}
          </button>
        </form>
      )}
    </main>
  );
}
