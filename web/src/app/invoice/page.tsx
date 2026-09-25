'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { BackLink, Protected } from '@/components/shell';
import { DocImage } from '@/components/doc-image';
import { AllocationHistory } from '@/components/history';
import { Shortlist } from '@/components/shortlist';
import { allocateManual, getInvoice, listFiles, proposeMatches, updateInvoice } from '@/lib/data';
import { formatRupees, minorToRupeeInput, rupeeInputToMinor } from '@/lib/money';
import type { DocumentFile, InvoiceRow } from '@/lib/types';

/**
 * One invoice: the original full size, the extracted fields beside it, and the
 * allocation history underneath. The image is the evidence; the fields are the
 * claim, and the owner correcting the claim is the normal case rather than the
 * exception.
 *
 * Saving an edit re-runs the matcher, because the old proposal was scored on
 * whatever was wrong.
 */
export default function InvoicePage() {
  return (
    <Protected>
      <Suspense fallback={<main><p className="muted">Loading…</p></main>}>
        <Invoice />
      </Suspense>
    </Protected>
  );
}

function Invoice() {
  const id = useSearchParams().get('id');
  const [invoice, setInvoice] = useState<InvoiceRow | null | 'missing'>(null);
  const [files, setFiles] = useState<DocumentFile[]>([]);
  const [form, setForm] = useState({ customer: '', amount: '', invoiceNo: '', issued: '', due: '', description: '' });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [matching, setMatching] = useState(false);

  const load = useCallback(async () => {
    if (!id) { setInvoice('missing'); return; }
    try {
      const [row, fileRows] = await Promise.all([getInvoice(id), listFiles('invoice', id)]);
      if (!row) { setInvoice('missing'); return; }
      setInvoice(row);
      setFiles(fileRows);
      setForm({
        customer: row.customer_name ?? '',
        amount: minorToRupeeInput(row.amount_minor),
        invoiceNo: row.invoice_no ?? '',
        issued: row.issued_on ?? '',
        due: row.due_on ?? '',
        description: row.description ?? '',
      });
    } catch (e) {
      setError((e as Error).message);
      setInvoice('missing');
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  if (invoice === null) return <main><p className="muted">Loading…</p></main>;
  if (invoice === 'missing') {
    return (
      <main>
        <BackLink href="/outstanding" label="Outstanding" />
        <p className="muted">That invoice could not be found.</p>
        {error && <p className="err">{error}</p>}
      </main>
    );
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!id) return;
    const amountMinor = form.amount.trim() === '' ? null : rupeeInputToMinor(form.amount);
    if (form.amount.trim() !== '' && amountMinor === null) {
      setError('Enter an amount above zero, or leave it blank');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await updateInvoice(id, {
        customer_name: form.customer.trim() || null,
        amount_minor: amountMinor === null ? null : amountMinor.toString(),
        invoice_no: form.invoiceNo.trim() || null,
        issued_on: form.issued || null,
        due_on: form.due || null,
        description: form.description.trim() || null,
      });
      // The correction changes what the matcher would conclude, so ask again.
      await proposeMatches('invoice', id).catch(() => 0);
      setSaved(true);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <BackLink href="/outstanding" label="Outstanding" />
      <h1>{invoice.customer_name ?? 'Invoice'}</h1>
      <p className="muted">
        {formatRupees(invoice.amount_minor)} invoiced ·{' '}
        {formatRupees(invoice.balance_minor)} outstanding
        {invoice.settle_status === 'settled' ? ' · settled' : ''}
      </p>

      {invoice.extraction_notes && <p className="pill">{invoice.extraction_notes}</p>}
      {error && <p className="err">{error}</p>}

      {files.map((f) => (
        <DocImage
          key={f.id}
          storagePath={f.storage_path}
          mimeType={f.mime_type}
          alt="The invoice"
          full
        />
      ))}

      <h2>Fields</h2>
      <form onSubmit={save}>
        <div className="field">
          <label htmlFor="customer">Customer</label>
          <input id="customer" value={form.customer}
            onChange={(e) => setForm({ ...form, customer: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="amount">Amount (₹)</label>
          <input id="amount" inputMode="decimal" value={form.amount}
            onChange={(e) => setForm({ ...form, amount: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="invoiceNo">Invoice number</label>
          <input id="invoiceNo" value={form.invoiceNo}
            onChange={(e) => setForm({ ...form, invoiceNo: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="issued">Issued on</label>
          <input id="issued" type="date" value={form.issued}
            onChange={(e) => setForm({ ...form, issued: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="due">Due on</label>
          <input id="due" type="date" value={form.due}
            onChange={(e) => setForm({ ...form, due: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="description">Description</label>
          <input id="description" value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </div>
        <div className="actions">
          <button className="btn" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          {saved && <span className="tiny">Saved, and re-matched.</span>}
        </div>
      </form>

      {(invoice.balance_minor ?? 0) !== 0 && (
        <>
          <h2>Match a payment</h2>
          {matching ? (
            <Shortlist
              side="invoice"
              documentId={invoice.id}
              onCancel={() => setMatching(false)}
              onPick={async (candidate, amountMinor) => {
                await allocateManual(candidate.invoice_id, candidate.payment_id, amountMinor);
                setMatching(false);
                await load();
              }}
            />
          ) : (
            <button className="btn secondary" onClick={() => setMatching(true)}>
              Find a payment for this
            </button>
          )}
        </>
      )}

      <AllocationHistory kind="invoice" documentId={invoice.id} onChange={() => void load()} />
    </main>
  );
}
