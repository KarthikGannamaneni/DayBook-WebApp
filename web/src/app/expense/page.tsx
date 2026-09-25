'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { Protected, TopNav } from '@/components/shell';
import { signedBillUrl, supabase } from '@/lib/client';
import { formatDate } from '@/lib/money';

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

interface FileRow {
  id: string;
  storage_path: string;
  mime_type: string;
}

function ExpenseView() {
  const id = useSearchParams().get('id');
  const router = useRouter();
  const [expense, setExpense] = useState<ExpenseRow | null | undefined>(undefined);
  const [categories, setCategories] = useState<Array<{ id: string; name: string }>>([]);
  const [files, setFiles] = useState<Array<FileRow & { url: string | null }>>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    const client = supabase();
    const { data } = await client
      .from('expenses')
      .select(
        'id, project_id, amount_minor, spent_on, vendor, description, status, confidence, ' +
          'extraction_notes, posted_by_name, category_id, raw_messages(body)',
      )
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle();

    setExpense((data as unknown as ExpenseRow) ?? null);

    const [{ data: cats }, { data: fileRows }] = await Promise.all([
      client.from('categories').select('id, name').order('name'),
      client.from('expense_files').select('id, storage_path, mime_type').eq('expense_id', id),
    ]);
    setCategories(cats ?? []);

    // Signed per view, short-lived, and only ever minted for a file the
    // storage policies already agreed this user may read.
    const withUrls = await Promise.all(
      ((fileRows ?? []) as FileRow[]).map(async (f) => ({ ...f, url: await signedBillUrl(f.storage_path) })),
    );
    setFiles(withUrls);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!expense) return;
    const form = new FormData(event.currentTarget);
    const rupees = Number(form.get('amount'));

    const patch: Record<string, unknown> = {
      vendor: String(form.get('vendor') ?? '').trim() || null,
      description: String(form.get('description') ?? '').trim() || null,
      spent_on: String(form.get('spent_on') ?? '') || null,
      category_id: String(form.get('category_id') ?? '') || null,
    };
    // Correcting the figure is the point of the review queue, so accept what
    // the owner types — but not a negative or a nonsense one.
    if (Number.isFinite(rupees) && rupees > 0) patch.amount_minor = Math.round(rupees * 100);

    setSaving(true);
    setError(null);
    const { error: updateError } = await supabase().from('expenses').update(patch).eq('id', expense.id);
    setSaving(false);
    if (updateError) setError(updateError.message);
    else {
      setSaved(true);
      void load();
    }
  }

  async function confirm() {
    if (!expense) return;
    await supabase().from('expenses').update({ status: 'confirmed' }).eq('id', expense.id);
    void load();
  }

  async function remove() {
    if (!expense) return;
    // Soft delete: the link to the original bill survives a mistake.
    await supabase().from('expenses').update({ deleted_at: new Date().toISOString() }).eq('id', expense.id);
    router.replace(`/project/?id=${expense.project_id}`);
  }

  if (!id) return <main><TopNav /><p className="muted">No expense was named.</p></main>;
  if (expense === undefined) return <main><TopNav /><p className="muted">Loading…</p></main>;
  if (expense === null) return <main><TopNav /><p className="muted">Not found.</p></main>;

  return (
    <main>
      <TopNav back={{ href: `/project/?id=${expense.project_id}`, label: 'Project' }} />
      <h1>{expense.vendor ?? 'Expense'}</h1>
      <p className="muted">
        {formatDate(expense.spent_on)}
        {expense.posted_by_name && <> · posted by {expense.posted_by_name}</>}
        {expense.confidence !== null && <> · confidence {Number(expense.confidence).toFixed(2)}</>}
      </p>

      {expense.status === 'needs_review' && expense.extraction_notes && (
        <p className="pill" style={{ marginTop: 10 }}>{expense.extraction_notes}</p>
      )}

      {/* The original is the evidence; the fields below are only a claim about
          it. Show it first, and show it large. */}
      <h2>The bill</h2>
      {files.length === 0 && <p className="muted">No file — this came in as text.</p>}
      {files.map((f) =>
        !f.url ? (
          <p key={f.id} className="muted">This file could not be opened.</p>
        ) : f.mime_type === 'application/pdf' ? (
          <p key={f.id}>
            <a className="btn secondary" href={f.url} target="_blank" rel="noreferrer">Open the PDF</a>
          </p>
        ) : (
          <p key={f.id}>
            <a href={f.url} target="_blank" rel="noreferrer">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={f.url} alt="The original bill"
                style={{ maxWidth: '100%', borderRadius: 10, border: '1px solid var(--border)' }} />
            </a>
          </p>
        ),
      )}

      {expense.raw_messages?.body && (
        <>
          <h2>Original message</h2>
          <p className="card" style={{ whiteSpace: 'pre-wrap' }}>{expense.raw_messages.body}</p>
        </>
      )}

      <h2>Details</h2>
      <form onSubmit={save}>
        <div style={{ display: 'grid', gap: 12 }}>
          <div>
            <label htmlFor="amount">Amount (₹)</label>
            <input id="amount" name="amount" type="number" step="0.01" min="0"
              defaultValue={expense.amount_minor ? Number(BigInt(expense.amount_minor)) / 100 : ''} />
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
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        </div>
        {error && <p role="alert" style={{ color: '#a32d2d', fontSize: 14 }}>{error}</p>}
        <button className="btn" style={{ marginTop: 14 }} disabled={saving}>
          {saving ? 'Saving…' : saved ? 'Saved' : 'Save changes'}
        </button>
      </form>

      <div style={{ display: 'flex', gap: 10, marginTop: 20, flexWrap: 'wrap' }}>
        {expense.status === 'needs_review' && (
          <button className="btn" onClick={() => void confirm()}>Confirm</button>
        )}
        <button className="btn secondary" onClick={() => void remove()}>Delete</button>
      </div>
    </main>
  );
}

export default function Page() {
  return (
    <Protected>
      <Suspense fallback={<main><p className="muted">Loading…</p></main>}>
        <ExpenseView />
      </Suspense>
    </Protected>
  );
}
