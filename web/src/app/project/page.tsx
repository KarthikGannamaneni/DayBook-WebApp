'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { Protected, TopNav } from '@/components/shell';
import { supabase } from '@/lib/client';
import { formatDate, formatRupees } from '@/lib/money';

/**
 * /project/?id=… rather than /project/[id].
 *
 * A static export cannot prerender a dynamic segment without knowing every id
 * in advance, and these are arbitrary uuids that only exist in somebody's
 * ledger. A query parameter is read in the browser and behaves identically.
 */
interface Row {
  id: string;
  amount_minor: string | null;
  spent_on: string | null;
  vendor: string | null;
  description: string | null;
  status: 'confirmed' | 'needs_review';
  categories: { name: string } | null;
}

function ProjectView() {
  const id = useSearchParams().get('id');
  const [name, setName] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [categories, setCategories] = useState<Array<{ id: string; name: string }>>([]);
  const [filters, setFilters] = useState({ category: '', from: '', to: '' });

  const load = useCallback(async () => {
    if (!id) return;
    const client = supabase();

    const [{ data: project }, { data: cats }] = await Promise.all([
      client.from('projects').select('name').eq('id', id).maybeSingle(),
      client.from('categories').select('id, name').order('name'),
    ]);
    setName(project?.name ?? null);
    setCategories(cats ?? []);

    let query = client
      .from('expenses')
      .select('id, amount_minor, spent_on, vendor, description, status, categories(name)')
      .eq('project_id', id)
      .is('deleted_at', null)
      .order('spent_on', { ascending: false, nullsFirst: false })
      .limit(200);

    if (filters.category) query = query.eq('category_id', filters.category);
    if (filters.from) query = query.gte('spent_on', filters.from);
    if (filters.to) query = query.lte('spent_on', filters.to);

    const { data } = await query;
    setRows((data ?? []) as unknown as Row[]);
  }, [id, filters]);

  useEffect(() => {
    void load();
  }, [load]);

  const total = (rows ?? [])
    .filter((r) => r.status === 'confirmed' && r.amount_minor)
    .reduce((sum, r) => sum + BigInt(r.amount_minor!), 0n);

  if (!id) return <main><TopNav /><p className="muted">No project was named.</p></main>;

  return (
    <main>
      <TopNav back={{ href: '/', label: 'Projects' }} />
      <h1>{name ?? 'Project'}</h1>
      <p className="muted">
        {rows?.length ?? 0} shown · {formatRupees(total)} confirmed in this view
      </p>

      <div className="inline" style={{ margin: '18px 0' }}>
        <div style={{ flex: '1 1 150px' }}>
          <label htmlFor="category">Category</label>
          <select
            id="category"
            value={filters.category}
            onChange={(e) => setFilters((f) => ({ ...f, category: e.target.value }))}
          >
            <option value="">All</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div style={{ flex: '1 1 130px' }}>
          <label htmlFor="from">From</label>
          <input id="from" type="date" value={filters.from}
            onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))} />
        </div>
        <div style={{ flex: '1 1 130px' }}>
          <label htmlFor="to">To</label>
          <input id="to" type="date" value={filters.to}
            onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))} />
        </div>
      </div>

      {rows === null && <p className="muted">Loading…</p>}
      {rows?.length === 0 && <p className="muted">Nothing matches.</p>}
      {rows?.map((e) => (
        <Link key={e.id} href={`/expense/?id=${e.id}`} className="card">
          <div className="row">
            <strong>{e.vendor ?? e.description ?? 'Untitled'}</strong>
            <span className="amount">{formatRupees(e.amount_minor)}</span>
          </div>
          <div className="muted">
            {formatDate(e.spent_on)}
            {e.categories?.name && <> · {e.categories.name}</>}
            {e.status === 'needs_review' && <> · <span className="pill">needs review</span></>}
          </div>
        </Link>
      ))}
    </main>
  );
}

export default function Page() {
  return (
    <Protected>
      <Suspense fallback={<main><p className="muted">Loading…</p></main>}>
        <ProjectView />
      </Suspense>
    </Protected>
  );
}
