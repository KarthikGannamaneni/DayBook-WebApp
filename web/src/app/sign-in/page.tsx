'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { supabase } from '@/lib/client';

/**
 * Two ways in, chosen at build time by NEXT_PUBLIC_PASSWORD_LOGIN.
 *
 * Password mode exists so the site can be used before the magic-link redirect
 * URLs are configured, and so testing does not need an email round trip every
 * time. It is a real Supabase session either way — this is a different way to
 * authenticate, NOT a way around authentication.
 *
 * There is deliberately no "secret code" that skips Supabase. Every policy in
 * the database resolves to auth.uid(); without a session the app would read
 * nothing at all, and the only way to make a bypass work would be to ship the
 * service-role key to the browser. On a public static site that is a full
 * read/write grant on the database to anyone who opens dev tools.
 *
 * Turn this off by unsetting the variable in .github/workflows/pages.yml.
 */
const PASSWORD_MODE = process.env.NEXT_PUBLIC_PASSWORD_LOGIN === '1';

export default function SignIn() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!email.includes('@')) {
      setError('Enter a valid email address');
      return;
    }
    if (PASSWORD_MODE && password.length === 0) {
      setError('Enter your password');
      return;
    }

    setBusy(true);
    setError(null);

    if (PASSWORD_MODE) {
      const { error: authError } = await supabase().auth.signInWithPassword({ email, password });
      setBusy(false);
      if (authError) setError(authError.message);
      else router.replace('/');
      return;
    }

    // The redirect must carry the basePath: a GitHub project site lives at
    // /DayBook-WebApp/, not at the domain root.
    const base = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
    const { error: authError } = await supabase().auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}${base}/auth/callback/` },
    });
    setBusy(false);
    if (authError) setError(authError.message);
    else setSent(true);
  }

  return (
    <main>
      <h1>Sign in</h1>
      <p className="muted">
        {PASSWORD_MODE
          ? 'Private testing build.'
          : 'We send a link. There is no password to forget.'}
      </p>

      {sent ? (
        <p style={{ marginTop: 24 }} role="status">
          Check {email} for the link. It expires in an hour.
        </p>
      ) : (
        <form onSubmit={submit} style={{ marginTop: 24, maxWidth: 360 }}>
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

          {PASSWORD_MODE && (
            <div style={{ marginTop: 12 }}>
              <label htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          )}

          {error && (
            <p role="alert" style={{ color: '#a32d2d', fontSize: 14 }}>
              {error}
            </p>
          )}

          <button className="btn" style={{ marginTop: 14 }} disabled={busy}>
            {busy ? 'Signing in…' : PASSWORD_MODE ? 'Sign in' : 'Send link'}
          </button>
        </form>
      )}
    </main>
  );
}
