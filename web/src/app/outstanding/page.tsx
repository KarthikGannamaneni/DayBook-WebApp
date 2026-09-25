'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Protected, TopNav } from '@/components/shell';
import { listCustomerBalances, listOutstanding } from '@/lib/data';
import { formatAge, formatDate, formatRupees, toMinor } from '@/lib/money';
import type { CustomerBalance, InvoiceRow } from '@/lib/types';

/**
 * Who owes money. This is the question the business currently answers by
 * scrolling a WhatsApp group for an hour, so it is the screen that justifies the
 * product existing.
 *
 * Grouped by normalised name rather than by a customer table — P0 deliberately
 * has no customer entity, because OCR produces several spellings of one person
 * and auto-creating a row per variant means twelve customers become fifty. The
 * grouping is also the measurement: if these groups look wrong, that is the
 * answer to whether names can carry the matcher at all.
 */
export default function OutstandingPage() {
  return (
    <Protected>
      <Outstanding />
    </Protected>
  );
}

function Outstanding() {
  const [invoices, setInvoices] = useState<InvoiceRow[] | null>(null);
  const [customers, setCustomers] = useState<CustomerBalance[]>([]);
  const [byCustomer, setByCustomer] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([listOutstanding(), listCustomerBalances()])
      .then(([i, c]) => { setInvoices(i); setCustomers(c); })
      .catch((e: Error) => { setError(e.message); setInvoices([]); });
  }, []);

  if (!invoices) {
    return <main><TopNav /><p className="muted">Loading…</p></main>;
  }

  const total = invoices.reduce((sum, i) => sum + (toMinor(i.balance_minor) ?? 0n), 0n);

  return (
    <main>
      <TopNav />
      <h1>Outstanding</h1>
      <p className="muted">
        {invoices.length === 0
          ? 'Nothing is outstanding.'
          : <>{formatRupees(total)} across {invoices.length} invoice{invoices.length === 1 ? '' : 's'}.</>}
      </p>
      {error && <p className="err">{error}</p>}

      {invoices.length > 0 && (
        <div className="actions">
          <button
            className={byCustomer ? 'btn small' : 'btn secondary small'}
            onClick={() => setByCustomer(true)}
          >
            By customer
          </button>
          <button
            className={byCustomer ? 'btn secondary small' : 'btn small'}
            onClick={() => setByCustomer(false)}
          >
            Oldest first
          </button>
        </div>
      )}

      {byCustomer ? (
        <div style={{ marginTop: 14 }}>
          {customers.map((c) => (
            <div className="card" key={c.customer_key}>
              <div className="row">
                <strong>{c.display_name ?? 'Name not read'}</strong>
                <span className="amount">{formatRupees(c.balance_minor)}</span>
              </div>
              <p className="tiny" style={{ margin: '2px 0 0' }}>
                {c.invoice_count} invoice{c.invoice_count === 1 ? '' : 's'}
                {c.oldest_age_days ? ` · oldest ${formatAge(c.oldest_age_days)}` : ''}
              </p>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ marginTop: 14 }}>
          {invoices.map((i) => (
            <Link className="card" key={i.id} href={`/invoice/?id=${i.id}`}>
              <div className="row">
                <strong>{i.customer_name ?? 'Customer not read'}</strong>
                <span className="amount">{formatRupees(i.balance_minor)}</span>
              </div>
              <p className="tiny" style={{ margin: '2px 0 0' }}>
                {i.invoice_no ?? 'no number'} · issued {formatDate(i.issued_on)}
                {i.age_days ? ` · ${formatAge(i.age_days)} old` : ''}
              </p>
              <div className="row" style={{ marginTop: 6 }}>
                {i.settle_status === 'part_paid' && (
                  <span className="pill">
                    {formatRupees(i.allocated_minor)} of {formatRupees(i.amount_minor)} paid
                  </span>
                )}
                {i.settle_status === 'unreadable' && (
                  <span className="pill bad">amount could not be read</span>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
