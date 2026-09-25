'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Protected, TopNav } from '@/components/shell';
import { supabase } from '@/lib/client';
import { formatRupees } from '@/lib/money';

interface ProjectTotal {
  project_id: string;
  name: string;
  confirmed_minor: string;
  confirmed_count: number;
  review_count: number;
}

function Projects() {
  const [rows, setRows] = useState<ProjectTotal[] | null>(null);

  useEffect(() => {
    // No owner filter: row-level security decides what comes back, and
    // repeating the check here would hide a broken policy rather than surface
    // it.
    void supabase()
      .from('v_project_totals')
      .select('project_id, name, confirmed_minor, confirmed_count, review_count')
      .is('archived_at', null)
      .order('name')
      .then(({ data }) => setRows((data ?? []) as ProjectTotal[]));
  }, []);

  const reviewing = (rows ?? []).reduce((n, p) => n + Number(p.review_count), 0);

  return (
    <main>
      <TopNav reviewCount={reviewing} />
      <h1>Projects</h1>
      <p className="muted">Totals count confirmed expenses only.</p>

      <div style={{ marginTop: 20 }}>
        {rows === null && <p className="muted">Loading…</p>}
        {rows?.length === 0 && (
          <p className="muted">
            No projects yet. Add one in <Link href="/settings">Settings</Link>, then point a
            WhatsApp group at it.
          </p>
        )}
        {rows?.map((p) => (
          <Link key={p.project_id} href={`/project/?id=${p.project_id}`} className="card">
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

export default function Page() {
  return <Protected><Projects /></Protected>;
}
