'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useSession } from '@/lib/useSession';

/**
 * Sends a signed-out visitor to the sign-in screen, and renders nothing until we
 * know which they are. On a static site the session is restored asynchronously
 * from storage, so rendering the app before that resolves would flash the empty
 * state at somebody who is signed in.
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

const LINKS = [
  { href: '/', label: 'Review' },
  { href: '/outstanding', label: 'Outstanding' },
  { href: '/summary', label: 'Cash flow' },
  { href: '/payments', label: 'Payments' },
  { href: '/settings', label: 'Settings' },
];

export function TopNav() {
  const path = usePathname();
  const here = (href: string) =>
    href === '/' ? path === '/' : (path ?? '').startsWith(href);

  return (
    <nav className="top">
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} className={here(l.href) ? 'here' : undefined}>
          {l.label}
        </Link>
      ))}
    </nav>
  );
}

export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <nav className="top">
      <Link href={href}>← {label}</Link>
    </nav>
  );
}
