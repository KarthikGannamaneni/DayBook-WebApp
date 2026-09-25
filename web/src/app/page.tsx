'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Protected, TopNav } from '@/components/shell';
import { CountsHeader } from '@/components/counts-header';
import { DocImage } from '@/components/doc-image';
import { Shortlist } from '@/components/shortlist';
import {
  acceptAllocations, classifyRawMessage, getCounts, listFiles, listProposals,
  listUnappliedPayments, listUnclassified, listUnreadable, rejectAllocations,
  rematch, allocateManual, undoAllocation,
} from '@/lib/data';
import { formatDate, formatRupees, toMinor } from '@/lib/money';
import type {
  Counts, DocumentFile, PaymentRow, Proposal, UnclassifiedRow, UnreadableRow,
} from '@/lib/types';

/**
 * The review session. This is the product.
 *
 * Three kinds of work, in the order they deserve attention:
 *
 *  1. Proposals the matcher is confident about. Because `propose_matches` only
 *     writes a pairing that is unique, exact, in date order and above 0.90,
 *     everything in this list is by construction an "obvious one" — which is why
 *     Accept all sits at the top rather than being a separate mode. The
 *     one-at-a-time card exists for the owner who wants to look anyway.
 *  2. Payments the matcher would not guess about. This is where the real work
 *     is: money arrived, and the ledger cannot say what for. Each one opens the
 *     shortlist.
 *  3. Documents nothing can be done with until a human reads them.
 *
 * Undo is server state (`allocation_events`), so it survives a refresh. The
 * moment undo only works until reload is the moment it stops being trustworthy.
 */
export default function ReviewPage() {
  return (
    <Protected>
      <Review />
    </Protected>
  );
}

interface Loaded {
  counts: Counts | null;
  proposals: Proposal[];
  unapplied: PaymentRow[];
  unreadable: UnreadableRow[];
  unclassified: UnclassifiedRow[];
}

const EMPTY: Loaded = {
  counts: null, proposals: [], unapplied: [], unreadable: [], unclassified: [],
};

function Review() {
  const [data, setData] = useState<Loaded | null>(null);
  const [focus, setFocus] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undoable, setUndoable] = useState<{ id: string; text: string } | null>(null);
  const [rematching, setRematching] = useState<string | null>(null);
  const [openPayment, setOpenPayment] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [counts, proposals, unapplied, unreadable, unclassified] = await Promise.all([
        getCounts(), listProposals(), listUnappliedPayments(), listUnreadable(), listUnclassified(),
      ]);
      setData({ counts, proposals, unapplied, unreadable, unclassified });
      setFocus((f) => Math.min(f, Math.max(proposals.length - 1, 0)));
    } catch (e) {
      setError((e as Error).message);
      setData(EMPTY);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const act = useCallback(async (
    run: () => Promise<unknown>,
    undo: { id: string; text: string } | null,
  ) => {
    setBusy(true);
    setError(null);
    try {
      await run();
      setUndoable(undo);
      setRematching(null);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [reload]);

  const proposals = data?.proposals ?? [];
  const current = proposals[Math.min(focus, proposals.length - 1)];

  // Keyboard first: forty items should take two minutes, and reaching for the
  // mouse forty times is most of why it currently takes an evening.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (!current || busy) return;

      if (event.key === 'j') { setFocus((f) => Math.min(f + 1, proposals.length - 1)); return; }
      if (event.key === 'k') { setFocus((f) => Math.max(f - 1, 0)); return; }
      if (event.key === 'a') {
        event.preventDefault();
        void act(() => acceptAllocations([current.allocation_id]),
          { id: current.allocation_id, text: `Matched ${formatRupees(current.proposed_minor)}` });
        return;
      }
      if (event.key === 'r') {
        event.preventDefault();
        void act(() => rejectAllocations([current.allocation_id]),
          { id: current.allocation_id, text: 'Rejected that match' });
        return;
      }
      if (event.key === 'm') {
        event.preventDefault();
        setRematching(current.allocation_id);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, busy, proposals.length, act]);

  if (!data) {
    return (
      <main>
        <TopNav />
        <p className="muted">Loading…</p>
      </main>
    );
  }

  const { counts, unapplied, unreadable, unclassified } = data;
  const certainTotal = proposals.reduce(
    (sum, p) => sum + (toMinor(p.proposed_minor) ?? 0n), 0n,
  );
  const nothingToDo =
    proposals.length === 0 && unapplied.length === 0 &&
    unreadable.length === 0 && unclassified.length === 0;

  return (
    <main>
      <TopNav />
      <h1>Review</h1>
      <CountsHeader counts={counts} />
      {error && <p className="err">{error}</p>}

      {nothingToDo && (
        <div className="empty">
          <p style={{ margin: 0 }}>Nothing to review.</p>
          <p className="muted" style={{ margin: '6px 0 0' }}>
            {counts && counts.pending_count > 0
              ? <>
                  {formatRupees(counts.pending_minor)} outstanding across {counts.pending_count}{' '}
                  invoice{counts.pending_count === 1 ? '' : 's'}
                  {counts.oldest_age_days ? `, oldest ${counts.oldest_age_days} days` : ''}.{' '}
                  <Link href="/outstanding">See who owes it</Link>.
                </>
              : 'Nothing is outstanding either.'}
          </p>
        </div>
      )}

      {proposals.length > 0 && (
        <>
          <div className="banner">
            <span>
              <strong>{proposals.length} match{proposals.length === 1 ? '' : 'es'} look certain</strong>
              {' — '}{formatRupees(certainTotal)}
            </span>
            <button
              className="btn"
              disabled={busy}
              onClick={() => void act(
                () => acceptAllocations(proposals.map((p) => p.allocation_id)),
                null,
              )}
            >
              Accept all
            </button>
          </div>

          {current && (
            <ProposalCard
              proposal={current}
              index={Math.min(focus, proposals.length - 1)}
              total={proposals.length}
              busy={busy}
              rematching={rematching === current.allocation_id}
              onAccept={() => void act(
                () => acceptAllocations([current.allocation_id]),
                { id: current.allocation_id, text: `Matched ${formatRupees(current.proposed_minor)}` },
              )}
              onReject={() => void act(
                () => rejectAllocations([current.allocation_id]),
                { id: current.allocation_id, text: 'Rejected that match' },
              )}
              onRematch={() => setRematching(current.allocation_id)}
              onCancelRematch={() => setRematching(null)}
              onPick={(candidate, amountMinor) => act(
                () => rematch(current.allocation_id, candidate.invoice_id, candidate.payment_id, amountMinor),
                null,
              )}
              onPrev={() => setFocus((f) => Math.max(f - 1, 0))}
              onNext={() => setFocus((f) => Math.min(f + 1, proposals.length - 1))}
            />
          )}
        </>
      )}

      {unapplied.length > 0 && (
        <>
          <h2>Money received, not yet matched ({unapplied.length})</h2>
          <p className="muted" style={{ marginTop: -4 }}>
            The ledger cannot say what these were for. Either the invoice has not
            arrived yet, or the matcher was not confident enough to guess.
          </p>
          {unapplied.map((p) => (
            <div className="card" key={p.id}>
              <div className="row">
                <strong>{p.payer_name ?? 'Payer not read'}</strong>
                <span className="amount">{formatRupees(p.unapplied_minor)}</span>
              </div>
              <p className="tiny" style={{ margin: '2px 0 0' }}>
                paid {formatDate(p.paid_on)}
                {p.app ? ` · ${p.app}` : ''}
                {p.utr ? ` · ${p.utr}` : ''}
                {p.method !== 'upi' ? ` · ${p.method}` : ''}
                {toMinor(p.applied_minor) !== 0n ? ` · ${formatRupees(p.applied_minor)} already applied` : ''}
              </p>
              {p.note && <p className="tiny" style={{ margin: '4px 0 0' }}>“{p.note}”</p>}

              <div className="actions">
                <button
                  className="btn secondary small"
                  onClick={() => setOpenPayment(openPayment === p.id ? null : p.id)}
                >
                  {openPayment === p.id ? 'Close' : 'Find its invoice'}
                </button>
                <Link className="btn secondary small" href={`/payment/?id=${p.id}`}>Open</Link>
              </div>

              {openPayment === p.id && (
                <Shortlist
                  side="payment"
                  documentId={p.id}
                  onCancel={() => setOpenPayment(null)}
                  onPick={(candidate, amountMinor) => act(
                    () => allocateManual(candidate.invoice_id, candidate.payment_id, amountMinor),
                    null,
                  )}
                />
              )}
            </div>
          ))}
        </>
      )}

      {(unreadable.length > 0 || unclassified.length > 0) && (
        <>
          <h2>Needs a human first ({unreadable.length + unclassified.length})</h2>
          <p className="muted" style={{ marginTop: -4 }}>
            Nothing can be matched until these are readable. The original is always
            kept, so nothing here is lost — only unread.
          </p>

          {unclassified.map((u) => (
            <UnclassifiedCard
              key={u.raw_message_id}
              row={u}
              busy={busy}
              onClassify={(kind) => void act(
                () => classifyRawMessage(u.raw_message_id, kind), null,
              )}
            />
          ))}

          {unreadable.map((u) => (
            <Link className="card" key={`${u.kind}-${u.id}`} href={`/${u.kind}/?id=${u.id}`}>
              <div className="row">
                <strong>{u.party_name ?? 'Name not read'}</strong>
                <span className="amount">{formatRupees(u.amount_minor)}</span>
              </div>
              <p className="tiny" style={{ margin: '2px 0 0' }}>
                {u.kind === 'invoice' ? 'Invoice' : 'Payment'} · {formatDate(u.dated)}
                {u.confidence !== null ? ` · read with ${(u.confidence * 100).toFixed(0)}% confidence` : ''}
              </p>
              {u.extraction_notes && (
                <p className="tiny" style={{ margin: '4px 0 0' }}>{u.extraction_notes}</p>
              )}
            </Link>
          ))}
        </>
      )}

      {undoable && (
        <div className="toast" role="status">
          <span>{undoable.text}</span>
          <button
            onClick={() => void act(async () => {
              await undoAllocation(undoable.id);
              setUndoable(null);
            }, null)}
          >
            Undo
          </button>
          <button aria-label="Dismiss" onClick={() => setUndoable(null)}>✕</button>
        </div>
      )}
    </main>
  );
}

function ProposalCard({
  proposal, index, total, busy, rematching,
  onAccept, onReject, onRematch, onCancelRematch, onPick, onPrev, onNext,
}: {
  proposal: Proposal;
  index: number;
  total: number;
  busy: boolean;
  rematching: boolean;
  onAccept: () => void;
  onReject: () => void;
  onRematch: () => void;
  onCancelRematch: () => void;
  onPick: (candidate: { invoice_id: string; payment_id: string }, amountMinor: bigint) => Promise<void>;
  onPrev: () => void;
  onNext: () => void;
}) {
  const [paymentFiles, setPaymentFiles] = useState<DocumentFile[]>([]);
  const [invoiceFiles, setInvoiceFiles] = useState<DocumentFile[]>([]);

  useEffect(() => {
    let live = true;
    void Promise.all([
      listFiles('payment', proposal.payment_id),
      listFiles('invoice', proposal.invoice_id),
    ]).then(([p, i]) => {
      if (!live) return;
      setPaymentFiles(p);
      setInvoiceFiles(i);
    }).catch(() => { /* images are evidence, not a blocker */ });
    return () => { live = false; };
  }, [proposal.payment_id, proposal.invoice_id]);

  return (
    <div className="card focused">
      <div className="row">
        <span className="tiny">Match {index + 1} of {total}</span>
        <span className={`pill ${(proposal.score ?? 0) >= 0.9 ? 'ok' : ''}`}>
          <span className="score">{(proposal.score ?? 0).toFixed(2)}</span> confidence
        </span>
      </div>

      <div className="pair">
        <div className="side">
          <h3>Payment received</h3>
          <DocImage
            storagePath={paymentFiles[0]?.storage_path ?? null}
            thumbnailPath={paymentFiles[0]?.thumbnail_path}
            mimeType={paymentFiles[0]?.mime_type}
            alt="The payment screenshot"
          />
          <dl>
            <dt>From</dt><dd>{proposal.payer_name ?? '—'}</dd>
            <dt>Amount</dt><dd className="amount">{formatRupees(proposal.payment_amount_minor)}</dd>
            <dt>Paid</dt><dd>{formatDate(proposal.paid_on)}</dd>
            {proposal.app && <><dt>App</dt><dd>{proposal.app}</dd></>}
            {proposal.utr && <><dt>Reference</dt><dd>{proposal.utr}</dd></>}
            {proposal.payer_vpa && <><dt>Sender</dt><dd>{proposal.payer_vpa}</dd></>}
            {/* Shown because a forwarded screenshot of a payment to somebody
                else's handle is not a receipt for this business. */}
            {proposal.payee_vpa && <><dt>Paid to</dt><dd>{proposal.payee_vpa}</dd></>}
            {proposal.note && <><dt>Note</dt><dd>{proposal.note}</dd></>}
          </dl>
        </div>

        <div className="side">
          <h3>Invoice</h3>
          <DocImage
            storagePath={invoiceFiles[0]?.storage_path ?? null}
            thumbnailPath={invoiceFiles[0]?.thumbnail_path}
            mimeType={invoiceFiles[0]?.mime_type}
            alt="The invoice"
          />
          <dl>
            <dt>Customer</dt><dd>{proposal.customer_name ?? '—'}</dd>
            <dt>Amount</dt><dd className="amount">{formatRupees(proposal.invoice_amount_minor)}</dd>
            <dt>Outstanding</dt><dd className="amount">{formatRupees(proposal.invoice_balance_minor)}</dd>
            <dt>Issued</dt><dd>{formatDate(proposal.issued_on)}</dd>
            {proposal.invoice_no && <><dt>Number</dt><dd>{proposal.invoice_no}</dd></>}
          </dl>
        </div>
      </div>

      <p style={{ margin: 0 }}>
        Settles <strong className="amount">{formatRupees(proposal.proposed_minor)}</strong> of this invoice.
      </p>
      <ul className="reasons">
        {proposal.reasons.map((r) => <li key={r}>{r}</li>)}
      </ul>

      <div className="actions">
        <button className="btn" disabled={busy} onClick={onAccept}>
          Accept <kbd>a</kbd>
        </button>
        <button className="btn danger" disabled={busy} onClick={onReject}>
          Not a match <kbd>r</kbd>
        </button>
        <button className="btn secondary" disabled={busy} onClick={rematching ? onCancelRematch : onRematch}>
          {rematching ? 'Cancel' : <>Re-match <kbd>m</kbd></>}
        </button>
        {total > 1 && (
          <>
            <button className="btn secondary small" disabled={busy || index === 0} onClick={onPrev}>
              <kbd>k</kbd> prev
            </button>
            <button className="btn secondary small" disabled={busy || index >= total - 1} onClick={onNext}>
              <kbd>j</kbd> next
            </button>
          </>
        )}
      </div>

      {rematching && (
        <Shortlist
          side="payment"
          documentId={proposal.payment_id}
          actionLabel="Use this one"
          onCancel={onCancelRematch}
          onPick={onPick}
        />
      )}
    </div>
  );
}

function UnclassifiedCard({
  row, busy, onClassify,
}: {
  row: UnclassifiedRow;
  busy: boolean;
  onClassify: (kind: 'invoice' | 'payment') => void;
}) {
  return (
    <div className="card">
      <DocImage
        storagePath={row.storage_path}
        thumbnailPath={row.thumbnail_path}
        mimeType={row.mime_type}
        alt="An image that could not be read"
      />
      <p style={{ margin: 0 }}>This could not be read automatically. What is it?</p>
      <p className="tiny" style={{ margin: '2px 0 0' }}>
        {row.sender_name ? `Posted by ${row.sender_name}` : 'Posted'} on {formatDate(row.received_at)}
        {row.body ? ` · “${row.body}”` : ''}
      </p>
      <div className="actions">
        <button className="btn secondary small" disabled={busy} onClick={() => onClassify('invoice')}>
          An invoice we sent
        </button>
        <button className="btn secondary small" disabled={busy} onClick={() => onClassify('payment')}>
          A payment we received
        </button>
      </div>
    </div>
  );
}
