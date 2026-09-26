'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Protected, TopNav } from '@/components/shell';
import { getCounts, listCashFlowWeeks, listCustomerBalances, listUnappliedPayments } from '@/lib/data';
import { formatAge, formatDate, formatRupees, toMinor } from '@/lib/money';
import type { CashFlowWeek, Counts, CustomerBalance, PaymentRow } from '@/lib/types';

/**
 * Cash flow, which the requirement calls "a side benefit of data the business was
 * already producing" — and that is exactly what it is: a view over invoices and
 * payments that already exist, not a second pipeline.
 *
 * The chart is inline divs rather than a charting library. Twelve bar pairs do not
 * justify 50 KB on a phone connection, and the home screen has a budget.
 *
 * Empty weeks are drawn as zeroes rather than skipped. A chart that silently drops
 * quiet weeks makes a slow month look like a busy one, which is the opposite of
 * what somebody checking their cash position needs.
 */
export default function SummaryPage() {
  return (
    <Protected>
      <Summary />
    </Protected>
  );
}

function Summary() {
  const [weeks, setWeeks] = useState<CashFlowWeek[] | null>(null);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [customers, setCustomers] = useState<CustomerBalance[]>([]);
  const [unapplied, setUnapplied] = useState<PaymentRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([listCashFlowWeeks(), getCounts(), listCustomerBalances(), listUnappliedPayments()])
      .then(([w, c, b, u]) => { setWeeks(w); setCounts(c); setCustomers(b); setUnapplied(u); })
      .catch((e: Error) => { setError(e.message); setWeeks([]); });
  }, []);

  if (!weeks) return <main><TopNav /><p className="muted">Loading…</p></main>;

  const peak = weeks.reduce((max, w) => {
    const a = Number(toMinor(w.invoiced_minor) ?? 0n);
    const b = Number(toMinor(w.collected_minor) ?? 0n);
    return Math.max(max, a, b);
  }, 0);

  const collected12 = weeks.reduce((sum, w) => sum + (toMinor(w.collected_minor) ?? 0n), 0n);
  const invoiced12 = weeks.reduce((sum, w) => sum + (toMinor(w.invoiced_minor) ?? 0n), 0n);

  // Oldest first: an invoice nobody has paid for 60 days is the one to chase.
  const aging = [...customers].sort(
    (a, b) => (b.oldest_age_days ?? 0) - (a.oldest_age_days ?? 0),
  ).slice(0, 5);

  return (
    <main>
      <TopNav />
      <h1>Cash flow</h1>
      <p className="muted">The last twelve weeks, from the same documents the bot read.</p>
      {error && <p className="err">{error}</p>}

      <div className="counts">
        <div className="stat">
          <span className="k">Collected, 12 weeks</span>
          <span className="v">{formatRupees(collected12)}</span>
        </div>
        <div className="stat">
          <span className="k">Invoiced, 12 weeks</span>
          <span className="v">{formatRupees(invoiced12)}</span>
        </div>
        <div className="stat">
          <span className="k">Still outstanding</span>
          <span className="v">{formatRupees(counts?.pending_minor ?? 0)}</span>
        </div>
      </div>

      <h2>Week by week</h2>
      {peak === 0 ? (
        <div className="empty"><p style={{ margin: 0 }}>Nothing invoiced or collected yet.</p></div>
      ) : (
        <>
          <div className="chart" role="img" aria-label="Invoiced and collected per week for the last twelve weeks">
            {weeks.map((w) => {
              const inv = Number(toMinor(w.invoiced_minor) ?? 0n);
              const got = Number(toMinor(w.collected_minor) ?? 0n);
              return (
                <div className="wk" key={w.week_start}>
                  <div
                    className="pair"
                    title={`${formatDate(w.week_start)}: invoiced ${formatRupees(w.invoiced_minor)}, collected ${formatRupees(w.collected_minor)}`}
                  >
                    <i className="inv" style={{ height: `${(inv / peak) * 100}%` }} />
                    <i className="got" style={{ height: `${(got / peak) * 100}%` }} />
                  </div>
                  <span>{new Date(w.week_start).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span>
                </div>
              );
            })}
          </div>
          <div className="legend">
            <span><i style={{ background: 'var(--border)' }} />Invoiced</span>
            <span><i style={{ background: 'var(--accent)' }} />Collected</span>
          </div>
        </>
      )}

      <h2>Needs attention</h2>
      {unapplied.length === 0 && aging.length === 0 ? (
        <div className="empty"><p style={{ margin: 0 }}>Nothing is waiting.</p></div>
      ) : (
        <>
          {unapplied.length > 0 && (
            <Link className="card" href="/">
              <div className="row">
                <strong>
                  {unapplied.length} payment{unapplied.length === 1 ? '' : 's'} not matched to an invoice
                </strong>
                <span className="amount">{formatRupees(counts?.unapplied_minor ?? 0)}</span>
              </div>
              <p className="tiny" style={{ margin: '2px 0 0' }}>
                Money arrived and the ledger cannot say what for. Review these first.
              </p>
            </Link>
          )}
          {aging.map((c) => (
            <Link className="card" key={c.customer_key} href="/outstanding">
              <div className="row">
                <strong>{c.display_name ?? 'Name not read'}</strong>
                <span className="amount">{formatRupees(c.balance_minor)}</span>
              </div>
              <p className="tiny" style={{ margin: '2px 0 0' }}>
                {c.invoice_count} invoice{c.invoice_count === 1 ? '' : 's'}
                {c.oldest_age_days ? ` · oldest ${formatAge(c.oldest_age_days)}` : ''}
              </p>
            </Link>
          ))}
        </>
      )}
    </main>
  );
}
