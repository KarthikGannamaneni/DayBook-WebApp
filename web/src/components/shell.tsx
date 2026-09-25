'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useSession } from '@/lib/useSession';

/**
 * Sends a signed-out visitor to the sign-in screen, and renders nothing until
 * we know which they are. On a static site the session is restored
 * asynchronously from storage, so rendering the app before that resolves
 * would flash the empty state at somebody who is signed in.
 */
export function Protected({ children }: { children: ReactNode }) {
  const { user } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (user === null) router.replace('/sign-in');
  }, [user, router]);

  if (user === undefined) return <main><p className="muted">Loading…</p></main>;
  if (user === null) return null;
  return <>{children}</>;
}

export function TopNav({ back, reviewCount }: { back?: { href: string; label: string }; reviewCount?: number }) {
  return (
    <nav className="top">
      {back ? <Link href={back.href}>← {back.label}</Link> : <Link href="/">Projects</Link>}
      <Link href="/review">
        Needs review{reviewCount ? ` (${reviewCount})` : ''}
      </Link>
      <Link href="/settings">Settings</Link>
    </nav>
  );
}
