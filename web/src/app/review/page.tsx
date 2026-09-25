import Link from 'next/link';
import { redirect } from 'next/navigation';
import { formatDate, formatRupees } from '@/lib/money';
import { requireUser, supabaseServer } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

/**
 * The queue. Oldest first, because the point is to clear it rather than to
 * browse it — and because a bill from three weeks ago is the one nobody
 * remembers.
 *
 * This screen decides whether the product is trusted, so it shows what the
 * model doubted rather than making the owner guess.
 */
export default async function Review() {
  if (!(await requireUser())) redirect('/sign-in');
  const supabase = await supabaseServer();

  const { data } = await supabase
    .from('expenses')
    .select('id, amount_minor, spent_on, vendor, description, extraction_notes, projects(name)')
    .eq('status', 'needs_review')
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .limit(100);

  const rows = (data ?? []) as unknown as Array<{
    id: string; amount_minor: string | null; spent_on: string | null;
    vendor: string | null; description: string | null;
    extraction_notes: string | null; projects: { name: string } | null;
  }>;

  return (
    <main>
      <nav className="top"><Link href="/">← Projects</Link></nav>
      <h1>Needs review</h1>
      <p className="muted">
        Nothing here is in a project total yet. Open one to fix it and confirm.
      </p>

      <div style={{ marginTop: 20 }}>
        {rows.length === 0 && <p className="muted">Nothing waiting. Everything captured is confirmed.</p>}
        {rows.map((e) => (
          <Link key={e.id} href={`/expenses/${e.id}`} className="card">
            <div className="row">
              <strong>{e.vendor ?? e.description ?? 'Unreadable bill'}</strong>
              <span className="amount">{formatRupees(e.amount_minor)}</span>
            </div>
            <div className="muted">
              {formatDate(e.spent_on)}
              {e.projects?.name && <> · {e.projects.name}</>}
            </div>
            {e.extraction_notes && <div className="pill" style={{ marginTop: 8 }}>{e.extraction_notes}</div>}
          </Link>
        ))}
      </div>
    </main>
  );
}
