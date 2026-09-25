import Link from 'next/link';
import { redirect } from 'next/navigation';
import { formatRupees } from '@/lib/money';
import { requireUser, supabaseServer } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

interface ProjectTotal {
  project_id: string;
  name: string;
  confirmed_minor: string;
  confirmed_count: number;
  review_count: number;
}

export default async function Projects() {
  if (!(await requireUser())) redirect('/sign-in');
  const supabase = await supabaseServer();

  // No owner filter here on purpose: row-level security decides what this
  // query can see, and duplicating the check in the query would hide a bug
  // in the policy rather than surface it.
  const { data } = await supabase
    .from('v_project_totals')
    .select('project_id, name, confirmed_minor, confirmed_count, review_count')
    .is('archived_at', null)
    .order('name');

  const projects = (data ?? []) as ProjectTotal[];
  const needingReview = projects.reduce((n, p) => n + Number(p.review_count), 0);

  return (
    <main>
      <nav className="top">
        <Link href="/review">Needs review{needingReview > 0 ? ` (${needingReview})` : ''}</Link>
        <Link href="/settings">Settings</Link>
      </nav>

      <h1>Projects</h1>
      <p className="muted">Totals count confirmed expenses only.</p>

      <div style={{ marginTop: 20 }}>
        {projects.length === 0 && (
          <p className="muted">
            No projects yet. Add one in <Link href="/settings">Settings</Link>, then point a
            WhatsApp group at it.
          </p>
        )}
        {projects.map((p) => (
          <Link key={p.project_id} href={`/projects/${p.project_id}`} className="card">
            <div className="row">
              <strong>{p.name}</strong>
              <span className="amount">{formatRupees(p.confirmed_minor)}</span>
            </div>
            <div className="muted">
              {p.confirmed_count} confirmed
              {Number(p.review_count) > 0 && <> · <span className="pill">{p.review_count} to review</span></>}
            </div>
          </Link>
        ))}
      </div>
    </main>
  );
}
