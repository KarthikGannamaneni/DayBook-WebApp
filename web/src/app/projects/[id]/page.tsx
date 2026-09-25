import Link from 'next/link';
import { redirect } from 'next/navigation';
import { formatDate, formatRupees } from '@/lib/money';
import { requireUser, supabaseServer } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

interface Row {
  id: string;
  amount_minor: string | null;
  spent_on: string | null;
  vendor: string | null;
  description: string | null;
  status: 'confirmed' | 'needs_review';
  categories: { name: string } | null;
}

export default async function Project({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ category?: string; from?: string; to?: string }>;
}) {
  if (!(await requireUser())) redirect('/sign-in');
  const { id } = await params;
  const filters = await searchParams;
  const supabase = await supabaseServer();

  const [{ data: project }, { data: categories }] = await Promise.all([
    supabase.from('projects').select('id, name').eq('id', id).maybeSingle(),
    supabase.from('categories').select('id, name').order('name'),
  ]);

  // RLS returns nothing for a project belonging to someone else, which is
  // indistinguishable from one that does not exist — and should be.
  if (!project) redirect('/');

  let query = supabase
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
  const rows = (data ?? []) as unknown as Row[];
  const total = rows
    .filter((r) => r.status === 'confirmed' && r.amount_minor)
    .reduce((sum, r) => sum + BigInt(r.amount_minor!), 0n);

  return (
    <main>
      <nav className="top">
        <Link href="/">← Projects</Link>
      </nav>

      <h1>{project.name}</h1>
      <p className="muted">
        {rows.length} shown · {formatRupees(total)} confirmed in this view
      </p>

      <form className="inline" style={{ margin: '18px 0' }}>
        <div style={{ flex: '1 1 150px' }}>
          <label htmlFor="category">Category</label>
          <select id="category" name="category" defaultValue={filters.category ?? ''}>
            <option value="">All</option>
            {(categories ?? []).map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
        <div style={{ flex: '1 1 130px' }}>
          <label htmlFor="from">From</label>
          <input id="from" name="from" type="date" defaultValue={filters.from ?? ''} />
        </div>
        <div style={{ flex: '1 1 130px' }}>
          <label htmlFor="to">To</label>
          <input id="to" name="to" type="date" defaultValue={filters.to ?? ''} />
        </div>
        <button className="btn secondary">Filter</button>
      </form>

      {rows.length === 0 && <p className="muted">Nothing matches.</p>}
      {rows.map((e) => (
        <Link key={e.id} href={`/expenses/${e.id}`} className="card">
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
