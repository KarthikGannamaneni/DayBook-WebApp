'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Protected, TopNav } from '@/components/shell';
import { listPayments } from '@/lib/data';
import { formatDate, formatRupees, toMinor } from '@/lib/money';
import type { PaymentRow } from '@/lib/types';

/**
 * Money received, newest first, with the unapplied ones pinned at the top —
 * received money the ledger cannot explain is a real signal, not a tidying-up
 * task.
 *
 * Pending and failed screenshots appear here too, clearly marked. They are never
 * counted as received: a screenshot of a failed transfer is a screenshot of money
 * that did not arrive, and a ledger that treats the two alike is worse than no
 * ledger.
 */
export default function PaymentsPage() {
  return (
    <Protected>
      <Payments />
    </Protected>
  );
}

function Payments() {
  const [payments, setPayments] = useState<PaymentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void listPayments()
      .then(setPayments)
      .catch((e: Error) => { setError(e.message); setPayments([]); });
  }, []);

  if (!payments) return <main><TopNav /><p className="muted">Loading…</p></main>;

  const unapplied = payments.filter(
    (p) => p.txn_status === 'completed' && (toMinor(p.unapplied_minor) ?? 0n) > 0n,
  );
  const rest = payments.filter((p) => !unapplied.includes(p));

  return (
    <main>
      <TopNav />
      <h1>Payments</h1>
      {error && <p className="err">{error}</p>}
      {payments.length === 0 && <p className="muted">No payments yet.</p>}

      {unapplied.length > 0 && (
        <>
          <h2>Not matched to an invoice ({unapplied.length})</h2>
          {unapplied.map((p) => <PaymentCard key={p.id} payment={p} />)}
        </>
      )}

      {rest.length > 0 && (
        <>
          <h2>All payments</h2>
          {rest.map((p) => <PaymentCard key={p.id} payment={p} />)}
        </>
      )}
    </main>
  );
}

function PaymentCard({ payment }: { payment: PaymentRow }) {
  const unapplied = toMinor(payment.unapplied_minor) ?? 0n;
  return (
    <Link className="card" href={`/payment/?id=${payment.id}`}>
      <div className="row">
        <strong>{payment.payer_name ?? 'Payer not read'}</strong>
        <span className="amount">{formatRupees(payment.amount_minor)}</span>
      </div>
      <p className="tiny" style={{ margin: '2px 0 0' }}>
        {formatDate(payment.paid_on)}
        {payment.app ? ` · ${payment.app}` : ''}
        {payment.method !== 'upi' ? ` · ${payment.method}` : ''}
        {payment.utr ? ` · ${payment.utr}` : ''}
      </p>
      <div className="row" style={{ marginTop: 6 }}>
        {payment.txn_status !== 'completed' && (
          <span className="pill bad">the app reports this as {payment.txn_status}</span>
        )}
        {payment.txn_status === 'completed' && unapplied > 0n && (
          <span className="pill">{formatRupees(unapplied)} not matched</span>
        )}
        {payment.txn_status === 'completed' && unapplied === 0n && (
          <span className="pill ok">matched</span>
        )}
      </div>
    </Link>
  );
}
