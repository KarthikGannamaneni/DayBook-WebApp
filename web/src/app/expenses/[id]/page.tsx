import Link from 'next/link';
import { redirect } from 'next/navigation';
import { confirmExpense, deleteExpense, updateExpense } from '@/app/actions';
import { formatDate } from '@/lib/money';
import { requireUser, supabaseServer } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

interface ExpenseRow {
  id: string;
  project_id: string;
  amount_minor: string | null;
  spent_on: string | null;
  vendor: string | null;
  description: string | null;
  status: 'confirmed' | 'needs_review';
  confidence: number | null;
  extraction_notes: string | null;
  posted_by_name: string | null;
  category_id: string | null;
  raw_messages: { body: string | null } | null;
}

export default async function Expense({ params }: { params: Promise<{ id: string }> }) {
  if (!(await requireUser())) redirect('/sign-in');
  const { id } = await params;
  const supabase = await supabaseServer();

  const { data: expenseRow } = await supabase
    .from('expenses')
    .select(
      'id, project_id, amount_minor, spent_on, vendor, description, status, confidence, ' +
        'extraction_notes, posted_by_name, category_id, raw_messages(body, received_at)',
    )
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();

  // PostgREST's inferred type for an embedded resource is a union that
  // includes an error shape; the shape we actually get back is this one.
  const expense = expenseRow as unknown as ExpenseRow | null;
  if (!expense) redirect('/');

  const [{ data: categories }, { data: files }] = await Promise.all([
    supabase.from('categories').select('id, name').order('name'),
    supabase.from('expense_files').select('id, mime_type').eq('expense_id', id),
  ]);

  const raw = expense.raw_messages;
  const amount = expense.amount_minor ? Number(BigInt(expense.amount_minor)) / 100 : '';

  return (
    <main>
      <nav className="top">
        <Link href={`/projects/${expense.project_id}`}>← Project</Link>
        <Link href="/review">Needs review</Link>
      </nav>

      <h1>{expense.vendor ?? 'Expense'}</h1>
      <p className="muted">
        {formatDate(expense.spent_on)}
        {expense.posted_by_name && <> · posted by {expense.posted_by_name}</>}
        {expense.confidence !== null && <> · confidence {Number(expense.confidence).toFixed(2)}</>}
      </p>

      {expense.status === 'needs_review' && expense.extraction_notes && (
        <p className="pill" style={{ marginTop: 10 }}>{expense.extraction_notes}</p>
      )}

      {/* The original is the source of truth; the fields below are a claim
          about it. Show it first and show it large. */}
      <h2>The bill</h2>
      {(files ?? []).length === 0 && <p className="muted">No file — this came in as text.</p>}
      {(files ?? []).map((f) => (
        <p key={f.id}>
          {f.mime_type === 'application/pdf' ? (
            <a className="btn secondary" href={`/api/file/${f.id}`} target="_blank" rel="noreferrer">
              Open the PDF
            </a>
          ) : (
            <a href={`/api/file/${f.id}`} target="_blank" rel="noreferrer">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/file/${f.id}`}
                alt="The original bill"
                style={{ maxWidth: '100%', borderRadius: 10, border: '1px solid var(--border)' }}
              />
            </a>
          )}
        </p>
      ))}

      {raw?.body && (
        <>
          <h2>Original message</h2>
          <p className="card" style={{ whiteSpace: 'pre-wrap' }}>{raw.body}</p>
        </>
      )}

      <h2>Details</h2>
      <form action={updateExpense}>
        <input type="hidden" name="id" value={expense.id} />
        <div style={{ display: 'grid', gap: 12 }}>
          <div>
            <label htmlFor="amount">Amount (₹)</label>
            <input id="amount" name="amount" type="number" step="0.01" min="0" defaultValue={amount} />
          </div>
          <div>
            <label htmlFor="vendor">Vendor</label>
            <input id="vendor" name="vendor" defaultValue={expense.vendor ?? ''} />
          </div>
          <div>
            <label htmlFor="description">Description</label>
            <input id="description" name="description" defaultValue={expense.description ?? ''} />
          </div>
          <div>
            <label htmlFor="spent_on">Date</label>
            <input id="spent_on" name="spent_on" type="date" defaultValue={expense.spent_on ?? ''} />
          </div>
          <div>
            <label htmlFor="category_id">Category</label>
            <select id="category_id" name="category_id" defaultValue={expense.category_id ?? ''}>
              <option value="">Uncategorised</option>
              {(categories ?? []).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
        </div>
        <button className="btn" style={{ marginTop: 14 }}>Save changes</button>
      </form>

      <div style={{ display: 'flex', gap: 10, marginTop: 20, flexWrap: 'wrap' }}>
        {expense.status === 'needs_review' && (
          <form action={confirmExpense}>
            <input type="hidden" name="id" value={expense.id} />
            <button className="btn">Confirm</button>
          </form>
        )}
        <form action={deleteExpense}>
          <input type="hidden" name="id" value={expense.id} />
          <button className="btn secondary">Delete</button>
        </form>
      </div>
    </main>
  );
}
