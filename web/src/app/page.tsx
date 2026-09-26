'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Protected, TopNav } from '@/components/shell';
import { CountsHeader } from '@/components/counts-header';
import { DocImage } from '@/components/doc-image';
import { Shortlist } from '@/components/shortlist';
import {
  acceptAllocations, allocateManual, classifyRawMessage, getCounts, listFiles,
  listProposals, listUnappliedPayments, listUnclassified, listUnreadable,
  rejectAllocations, rematch, undoAllocation,
} from '@/lib/data';
import { formatDate, formatRupees, toMinor } from '@/lib/money';
import type {
  Counts, DocumentFile, PaymentRow, Proposal, UnclassifiedRow, UnreadableRow,
} from '@/lib/types';

/**
 * The review session. This is the product.
 *
 * The interaction is a **queue, not a list**: prev/next with the keyboard is the
 * everyday path, and no list of items ever has to be opened to move between them.
 * Three layers, cheapest first —
 *
 *  1. Arrow keys and buttons to step through. Enter confirms, Backspace rejects.
 *  2. A filmstrip of the few items either side, to jump sideways without leaving
 *     the card. Not the whole queue — just enough context to know where you are.
 *  3. A filter rail of broad buckets, to land in the right group to begin with.
 *
 * Deliberately no search box and no "all items" table on the everyday path.
 * Having to find a row in a list before you can act on it is the spreadsheet
 * this product exists to replace.
 */
export default function ReviewPage() {
  return (
    <Protected>
      <Review />
    </Protected>
  );
}

type Bucket = 'proposals' | 'unapplied' | 'unreadable';

type Item =
  | { kind: 'proposal'; id: string; proposal: Proposal }
  | { kind: 'payment'; id: string; payment: PaymentRow }
  | { kind: 'unreadable'; id: string; row: UnreadableRow }
  | { kind: 'unclassified'; id: string; row: UnclassifiedRow };

interface Loaded {
  counts: Counts | null;
  proposals: Proposal[];
  unapplied: PaymentRow[];
  unreadable: UnreadableRow[];
  unclassified: UnclassifiedRow[];
}

const BUCKETS: Array<{ key: Bucket; label: string }> = [
  { key: 'proposals', label: 'Needs review' },
  { key: 'unapplied', label: 'Unmatched' },
  { key: 'unreadable', label: 'Could not read' },
];

function Review() {
  const [data, setData] = useState<Loaded | null>(null);
  const [bucket, setBucket] = useState<Bucket>('proposals');
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undoable, setUndoable] = useState<{ id: string; text: string } | null>(null);
  const [matching, setMatching] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [counts, proposals, unapplied, unreadable, unclassified] = await Promise.all([
        getCounts(), listProposals(), listUnappliedPayments(), listUnreadable(), listUnclassified(),
      ]);
      setData({ counts, proposals, unapplied, unreadable, unclassified });
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const queues = useMemo<Record<Bucket, Item[]>>(() => ({
    proposals: (data?.proposals ?? []).map((p) => ({ kind: 'proposal' as const, id: p.allocation_id, proposal: p })),
    unapplied: (data?.unapplied ?? []).map((p) => ({ kind: 'payment' as const, id: p.id, payment: p })),
    unreadable: [
      ...(data?.unclassified ?? []).map((r) => ({ kind: 'unclassified' as const, id: r.raw_message_id, row: r })),
      ...(data?.unreadable ?? []).map((r) => ({ kind: 'unreadable' as const, id: `${r.kind}-${r.id}`, row: r })),
    ],
  }), [data]);

  const queue = queues[bucket];
  const index = Math.min(cursor, Math.max(queue.length - 1, 0));
  const current = queue[index];

  const step = useCallback((by: number) => {
    setMatching(false);
    setCursor((c) => Math.max(0, Math.min(c + by, queue.length - 1)));
  }, [queue.length]);

  const act = useCallback(async (
    run: () => Promise<unknown>,
    undo: { id: string; text: string } | null,
  ) => {
    setBusy(true);
    setError(null);
    try {
      await run();
      setUndoable(undo);
      setMatching(false);
      await reload();
      // Staying at the same index lands on the next item, because the one just
      // dealt with has left the queue.
      setCursor((c) => Math.max(0, Math.min(c, queue.length - 2)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [reload, queue.length]);

  const accept = useCallback(() => {
    if (!current || current.kind !== 'proposal') return;
    void act(
      () => acceptAllocations([current.proposal.allocation_id]),
      { id: current.proposal.allocation_id, text: `Matched ${formatRupees(current.proposal.proposed_minor)}` },
    );
  }, [current, act]);

  const reject = useCallback(() => {
    if (!current || current.kind !== 'proposal') return;
    void act(
      () => rejectAllocations([current.proposal.allocation_id]),
      { id: current.proposal.allocation_id, text: 'Rejected that match' },
    );
  }, [current, act]);

  // Keyboard first. Forty items should take two minutes, and reaching for the
  // mouse forty times is most of why it currently takes an evening.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (busy) return;

      if (event.key === 'ArrowRight' || event.key === 'j') { step(1); return; }
      if (event.key === 'ArrowLeft' || event.key === 'k') { step(-1); return; }
      if (!current) return;
      if (event.key === 'Enter') { event.preventDefault(); accept(); return; }
      if (event.key === 'Backspace') {
        // Backspace is the browser's back gesture; this screen claims it.
        event.preventDefault();
        reject();
        return;
      }
      if (event.key === 'm') { event.preventDefault(); setMatching((m) => !m); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, busy, step, accept, reject]);

  if (!data) {
    return <main><TopNav /><p className="muted">Loading…</p></main>;
  }

  const { counts } = data;
  const total = queues.proposals.length + queues.unapplied.length + queues.unreadable.length;
  const certainTotal = (data.proposals ?? []).reduce(
    (sum, p) => sum + (toMinor(p.proposed_minor) ?? 0n), 0n,
  );

  return (
    <main>
      <TopNav />
      <h1>Review</h1>
      <CountsHeader counts={counts} />
      {error && <p className="err">{error}</p>}

      {total === 0 ? (
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
      ) : (
        <div className="layout">
          <div className="rail">
            {BUCKETS.map((b) => (
              <button
                key={b.key}
                className={bucket === b.key ? 'on' : undefined}
                onClick={() => { setBucket(b.key); setCursor(0); setMatching(false); }}
              >
                <span>{b.label}</span>
                <span className="n">{queues[b.key].length}</span>
              </button>
            ))}
          </div>

          <div>
            {bucket === 'proposals' && queues.proposals.length > 0 && (
              <div className="banner">
                <span>
                  <strong>
                    {queues.proposals.length} match{queues.proposals.length === 1 ? '' : 'es'} look certain
                  </strong>
                  {' — '}{formatRupees(certainTotal)}
                </span>
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() => void act(
                    () => acceptAllocations(data.proposals.map((p) => p.allocation_id)), null,
                  )}
                >
                  Accept all
                </button>
              </div>
            )}

            {queue.length === 0 ? (
              <div className="empty"><p style={{ margin: 0 }}>Nothing in this group.</p></div>
            ) : (
              <>
                <div className="progress">
                  <span>Reviewing {index + 1} of {queue.length}</span>
                  <span>
                    <kbd>←</kbd> <kbd>→</kbd> move
                    {current?.kind === 'proposal' && <> · <kbd>↵</kbd> confirm · <kbd>⌫</kbd> reject</>}
                  </span>
                </div>
                <div className="bar">
                  <i style={{ width: `${((index + 1) / queue.length) * 100}%` }} />
                </div>

                {current?.kind === 'proposal' && (
                  <ProposalCard
                    proposal={current.proposal}
                    busy={busy}
                    matching={matching}
                    onAccept={accept}
                    onReject={reject}
                    onToggleMatch={() => setMatching((m) => !m)}
                    onPick={(candidate, amountMinor) => act(
                      () => rematch(current.proposal.allocation_id, candidate.invoice_id, candidate.payment_id, amountMinor),
                      null,
                    )}
                  />
                )}

                {current?.kind === 'payment' && (
                  <PaymentCard
                    payment={current.payment}
                    matching={matching}
                    onToggleMatch={() => setMatching((m) => !m)}
                    onPick={(candidate, amountMinor) => act(
                      () => allocateManual(candidate.invoice_id, candidate.payment_id, amountMinor), null,
                    )}
                  />
                )}

                {current?.kind === 'unclassified' && (
                  <UnclassifiedCard
                    row={current.row}
                    busy={busy}
                    onClassify={(kind) => void act(
                      () => classifyRawMessage(current.row.raw_message_id, kind), null,
                    )}
                  />
                )}

                {current?.kind === 'unreadable' && <UnreadableCard row={current.row} />}

                <div className="actions">
                  <button className="btn secondary small" disabled={index === 0} onClick={() => step(-1)}>
                    ← Previous
                  </button>
                  <button className="btn secondary small" disabled={index >= queue.length - 1} onClick={() => step(1)}>
                    Next →
                  </button>
                </div>

                {queue.length > 1 && (
                  <div className="filmstrip">
                    {/* Only the items either side. A window, not an index. */}
                    {queue
                      .map((item, i) => ({ item, i }))
                      .filter(({ i }) => Math.abs(i - index) <= 3)
                      .map(({ item, i }) => (
                        <button
                          key={item.id}
                          className={i === index ? 'on' : undefined}
                          onClick={() => { setCursor(i); setMatching(false); }}
                        >
                          {i + 1}. {labelFor(item)}
                        </button>
                      ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {undoable && (
        <div className="toast" role="status">
          <span>{undoable.text}</span>
          <button onClick={() => void act(async () => {
            await undoAllocation(undoable.id);
            setUndoable(null);
          }, null)}>
            Undo
          </button>
          <button aria-label="Dismiss" onClick={() => setUndoable(null)}>✕</button>
        </div>
      )}
    </main>
  );
}

function labelFor(item: Item): string {
  if (item.kind === 'proposal') {
    return `${item.proposal.customer_name ?? '—'} ${formatRupees(item.proposal.proposed_minor)}`;
  }
  if (item.kind === 'payment') {
    return `${item.payment.payer_name ?? '—'} ${formatRupees(item.payment.unapplied_minor)}`;
  }
  if (item.kind === 'unreadable') {
    return `${item.row.party_name ?? 'unread'} ${formatRupees(item.row.amount_minor)}`;
  }
  return 'unread image';
}

function useFiles(kind: 'invoice' | 'payment', id: string | null): DocumentFile[] {
  const [files, setFiles] = useState<DocumentFile[]>([]);
  useEffect(() => {
    let live = true;
    setFiles([]);
    if (!id) return;
    void listFiles(kind, id)
      .then((f) => { if (live) setFiles(f); })
      .catch(() => { /* images are evidence, not a blocker */ });
    return () => { live = false; };
  }, [kind, id]);
  return files;
}

function ProposalCard({
  proposal, busy, matching, onAccept, onReject, onToggleMatch, onPick,
}: {
  proposal: Proposal;
  busy: boolean;
  matching: boolean;
  onAccept: () => void;
  onReject: () => void;
  onToggleMatch: () => void;
  onPick: (candidate: { invoice_id: string; payment_id: string }, amountMinor: bigint) => Promise<void>;
}) {
  const paymentFiles = useFiles('payment', proposal.payment_id);
  const invoiceFiles = useFiles('invoice', proposal.invoice_id);

  return (
    <div className="card focused">
      <div className="row">
        <strong>{proposal.payer_name ?? 'Payer not read'} → {proposal.customer_name ?? 'Customer not read'}</strong>
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
            purgedAt={paymentFiles[0]?.purged_at}
            alt="The payment screenshot"
          />
          <dl>
            <dt>From</dt><dd>{proposal.payer_name ?? '—'}</dd>
            <dt>Amount</dt><dd className="amount">{formatRupees(proposal.payment_amount_minor)}</dd>
            <dt>Paid</dt><dd>{formatDate(proposal.paid_on)}</dd>
            {proposal.app && <><dt>App</dt><dd>{proposal.app}</dd></>}
            {proposal.utr && <><dt>Reference</dt><dd>{proposal.utr}</dd></>}
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
            purgedAt={invoiceFiles[0]?.purged_at}
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
      <ul className="reasons">{proposal.reasons.map((r) => <li key={r}>{r}</li>)}</ul>

      <div className="actions">
        <button className="btn" disabled={busy} onClick={onAccept}>Accept <kbd>↵</kbd></button>
        <button className="btn danger" disabled={busy} onClick={onReject}>Not a match <kbd>⌫</kbd></button>
        <button className="btn secondary" disabled={busy} onClick={onToggleMatch}>
          {matching ? 'Cancel' : <>Re-match <kbd>m</kbd></>}
        </button>
      </div>

      {matching && (
        <Shortlist
          side="payment"
          documentId={proposal.payment_id}
          actionLabel="Use this one"
          onCancel={onToggleMatch}
          onPick={onPick}
        />
      )}
    </div>
  );
}

function PaymentCard({
  payment, matching, onToggleMatch, onPick,
}: {
  payment: PaymentRow;
  matching: boolean;
  onToggleMatch: () => void;
  onPick: (candidate: { invoice_id: string; payment_id: string }, amountMinor: bigint) => Promise<void>;
}) {
  const files = useFiles('payment', payment.id);
  return (
    <div className="card focused">
      <div className="row">
        <strong>{payment.payer_name ?? 'Payer not read'}</strong>
        <span className="amount">{formatRupees(payment.unapplied_minor)}</span>
      </div>
      <p className="tiny" style={{ margin: '2px 0 10px' }}>
        Received {formatDate(payment.paid_on)}
        {payment.app ? ` · ${payment.app}` : ''}
        {payment.utr ? ` · ${payment.utr}` : ''}
        {payment.method !== 'upi' ? ` · ${payment.method}` : ''}
        {' · the ledger cannot say what this was for'}
      </p>
      <DocImage
        storagePath={files[0]?.storage_path ?? null}
        thumbnailPath={files[0]?.thumbnail_path}
        mimeType={files[0]?.mime_type}
        purgedAt={files[0]?.purged_at}
        alt="The payment screenshot"
      />
      {payment.note && <p className="tiny">“{payment.note}”</p>}
      <div className="actions">
        <button className="btn" onClick={onToggleMatch}>
          {matching ? 'Close' : 'Find its invoice'} <kbd>m</kbd>
        </button>
        <Link className="btn secondary small" href={`/payment/?id=${payment.id}`}>Open</Link>
      </div>
      {matching && (
        <Shortlist side="payment" documentId={payment.id} onCancel={onToggleMatch} onPick={onPick} />
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
    <div className="card focused">
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
        <button className="btn secondary" disabled={busy} onClick={() => onClassify('invoice')}>
          An invoice we sent
        </button>
        <button className="btn secondary" disabled={busy} onClick={() => onClassify('payment')}>
          A payment we received
        </button>
      </div>
    </div>
  );
}

function UnreadableCard({ row }: { row: UnreadableRow }) {
  const files = useFiles(row.kind, row.id);
  return (
    <div className="card focused">
      <div className="row">
        <strong>{row.party_name ?? 'Name not read'}</strong>
        <span className="amount">{formatRupees(row.amount_minor)}</span>
      </div>
      <p className="tiny" style={{ margin: '2px 0 10px' }}>
        {row.kind === 'invoice' ? 'Invoice' : 'Payment'} · {formatDate(row.dated)}
        {row.confidence !== null ? ` · read with ${(row.confidence * 100).toFixed(0)}% confidence` : ''}
      </p>
      <DocImage
        storagePath={files[0]?.storage_path ?? null}
        thumbnailPath={files[0]?.thumbnail_path}
        mimeType={files[0]?.mime_type}
        purgedAt={files[0]?.purged_at}
        alt="The document"
      />
      {row.extraction_notes && <p className="pill">{row.extraction_notes}</p>}
      <div className="actions">
        <Link className="btn" href={`/${row.kind}/?id=${row.id}`}>Fix the fields</Link>
      </div>
    </div>
  );
}
