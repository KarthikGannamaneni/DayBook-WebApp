'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Protected, TopNav } from '@/components/shell';
import { supabase } from '@/lib/client';
import { formatDate, formatRupees } from '@/lib/money';

interface Row {
  id: string;
  amount_minor: string | null;
  spent_on: string | null;
  vendor: string | null;
  description: string | null;
  extraction_notes: string | null;
  projects: { name: string } | null;
}

function Review() {
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => {
    void supabase()
      .from('expenses')
      .select('id, amount_minor, spent_on, vendor, description, extraction_notes, projects(name)')
      .eq('status', 'needs_review')
      .is('deleted_at', null)
      .order('created_at', { ascending: true })
      .limit(100)
      .then(({ data }) => setRows((data ?? []) as unknown as Row[]));
  }, []);

  return (
    <main>
      <TopNav back={{ href: '/', label: 'Projects' }} />
      <h1>Needs review</h1>
      <p className="muted">Nothing here counts towards a project total yet.</p>

      <div style={{ marginTop: 20 }}>
        {rows === null && <p className="muted">Loading…</p>}
        {rows?.length === 0 && <p className="muted">Nothing waiting. Everything captured is confirmed.</p>}
        {rows?.map((e) => (
          <Link key={e.id} href={`/expense/?id=${e.id}`} className="card">
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

export default function Page() {
  return <Protected><Review /></Protected>;
}
