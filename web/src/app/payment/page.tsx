'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { BackLink, Protected } from '@/components/shell';
import { DocImage } from '@/components/doc-image';
import { AllocationHistory } from '@/components/history';
import { Shortlist } from '@/components/shortlist';
import { allocateManual, getPayment, listFiles, proposeMatches, updatePayment } from '@/lib/data';
import { formatRupees, minorToRupeeInput, rupeeInputToMinor, toMinor } from '@/lib/money';
import type { DocumentFile, PaymentRow, TxnStatus } from '@/lib/types';

/**
 * One payment: the screenshot full size and the fields beside it.
 *
 * `txn_status` is editable because the model reads it off a screen and can get
 * it wrong in both directions — but it is a select rather than free text, and
 * changing it away from completed un-matches nothing on its own: the schema
 * refuses to allocate a payment that is not completed, so the invariant holds
 * whatever is chosen here.
 */
export default function PaymentPage() {
  return (
    <Protected>
      <Suspense fallback={<main><p className="muted">Loading…</p></main>}>
        <Payment />
      </Suspense>
    </Protected>
  );
}

const STATUSES: TxnStatus[] = ['completed', 'pending', 'failed'];

function Payment() {
  const id = useSearchParams().get('id');
  const [payment, setPayment] = useState<PaymentRow | null | 'missing'>(null);
  const [files, setFiles] = useState<DocumentFile[]>([]);
  const [form, setForm] = useState({
    payer: '', amount: '', paidOn: '', utr: '', status: 'completed' as TxnStatus, note: '',
  });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [matching, setMatching] = useState(false);

  const load = useCallback(async () => {
    if (!id) { setPayment('missing'); return; }
    try {
      const [row, fileRows] = await Promise.all([getPayment(id), listFiles('payment', id)]);
      if (!row) { setPayment('missing'); return; }
      setPayment(row);
      setFiles(fileRows);
      setForm({
        payer: row.payer_name ?? '',
        amount: minorToRupeeInput(row.amount_minor),
        paidOn: row.paid_on ?? '',
        utr: row.utr ?? '',
        status: row.txn_status,
        note: row.note ?? '',
      });
    } catch (e) {
      setError((e as Error).message);
      setPayment('missing');
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  if (payment === null) return <main><p className="muted">Loading…</p></main>;
  if (payment === 'missing') {
    return (
      <main>
        <BackLink href="/payments" label="Payments" />
        <p className="muted">That payment could not be found.</p>
        {error && <p className="err">{error}</p>}
      </main>
    );
  }

  const unapplied = toMinor(payment.unapplied_minor) ?? 0n;

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
      await updatePayment(id, {
        payer_name: form.payer.trim() || null,
        amount_minor: amountMinor === null ? null : amountMinor.toString(),
        paid_on: form.paidOn || null,
        utr: form.utr.trim() || null,
        txn_status: form.status,
        note: form.note.trim() || null,
      });
      await proposeMatches('payment', id).catch(() => 0);
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
      <BackLink href="/payments" label="Payments" />
      <h1>{payment.payer_name ?? 'Payment'}</h1>
      <p className="muted">
        {formatRupees(payment.amount_minor)} received ·{' '}
        {unapplied === 0n ? 'fully matched' : `${formatRupees(unapplied)} not matched`}
      </p>

      {payment.txn_status !== 'completed' && (
        <p className="pill bad">
          The app reports this as {payment.txn_status}, so it cannot settle anything
        </p>
      )}
      {payment.extraction_notes && <p className="pill">{payment.extraction_notes}</p>}
      {error && <p className="err">{error}</p>}

      {files.map((f) => (
        <DocImage key={f.id} storagePath={f.storage_path} mimeType={f.mime_type}
          alt="The payment screenshot" full />
      ))}

      {(payment.payer_vpa || payment.payee_vpa) && (
        <div className="side" style={{ marginBottom: 12 }}>
          <dl>
            {payment.payer_vpa && <><dt>Sender</dt><dd>{payment.payer_vpa}</dd></>}
            {/* Worth a glance: a forwarded screenshot of a payment to somebody
                else's handle is not a receipt for this business. */}
            {payment.payee_vpa && <><dt>Paid to</dt><dd>{payment.payee_vpa}</dd></>}
            {payment.app && <><dt>App</dt><dd>{payment.app}</dd></>}
            <dt>Recorded</dt><dd>{payment.method}</dd>
          </dl>
        </div>
      )}

      <h2>Fields</h2>
      <form onSubmit={save}>
        <div className="field">
          <label htmlFor="payer">Paid by</label>
          <input id="payer" value={form.payer}
            onChange={(e) => setForm({ ...form, payer: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="amount">Amount (₹)</label>
          <input id="amount" inputMode="decimal" value={form.amount}
            onChange={(e) => setForm({ ...form, amount: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="paidOn">Paid on</label>
          <input id="paidOn" type="date" value={form.paidOn}
            onChange={(e) => setForm({ ...form, paidOn: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="utr">Reference / UTR</label>
          <input id="utr" value={form.utr}
            onChange={(e) => setForm({ ...form, utr: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="status">What the app says</label>
          <select id="status" value={form.status}
            onChange={(e) => setForm({ ...form, status: e.target.value as TxnStatus })}>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="note">Note on the transfer</label>
          <input id="note" value={form.note}
            onChange={(e) => setForm({ ...form, note: e.target.value })} />
        </div>
        <div className="actions">
          <button className="btn" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          {saved && <span className="tiny">Saved, and re-matched.</span>}
        </div>
      </form>

      {payment.txn_status === 'completed' && unapplied > 0n && (
        <>
          <h2>Match an invoice</h2>
          {matching ? (
            <Shortlist
              side="payment"
              documentId={payment.id}
              onCancel={() => setMatching(false)}
              onPick={async (candidate, amountMinor) => {
                await allocateManual(candidate.invoice_id, candidate.payment_id, amountMinor);
                setMatching(false);
                await load();
              }}
            />
          ) : (
            <button className="btn secondary" onClick={() => setMatching(true)}>
              Find the invoice this paid
            </button>
          )}
        </>
      )}

      <AllocationHistory kind="payment" documentId={payment.id} onChange={() => void load()} />
    </main>
  );
}
