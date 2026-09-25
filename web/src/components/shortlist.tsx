'use client';

import { useEffect, useState } from 'react';
import { matchCandidates } from '@/lib/data';
import { formatDate, formatRupees, minorToRupeeInput, rupeeInputToMinor, toMinor } from '@/lib/money';
import type { Candidate, DocKind } from '@/lib/types';

/**
 * The shortlist, which the requirement is specific about: when the matcher is
 * unsure, show the candidates instantly instead of making the owner search.
 *
 * It calls the same `match_candidates` function the bot used, so the ranking the
 * owner sees is the ranking that produced (or withheld) the proposal. Two
 * implementations of a money-matching rule would drift apart within a month.
 */
export function Shortlist({
  side, documentId, onPick, onCancel, actionLabel = 'Match',
}: {
  side: DocKind;
  documentId: string;
  /** Called with the chosen pairing and the amount to allocate. */
  onPick: (candidate: Candidate, amountMinor: bigint) => Promise<void>;
  onCancel?: () => void;
  actionLabel?: string;
}) {
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setCandidates(null);
    void matchCandidates(side, documentId)
      .then((rows) => {
        if (!live) return;
        setCandidates(rows);
        setAmounts(Object.fromEntries(
          rows.map((r) => [key(r), minorToRupeeInput(r.suggested_minor)]),
        ));
      })
      .catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [side, documentId]);

  if (error) return <p className="err">{error}</p>;
  if (!candidates) return <p className="tiny">Looking…</p>;

  if (candidates.length === 0) {
    return (
      <div style={{ marginTop: 10 }}>
        <p className="tiny">
          Nothing on the other side of the ledger looks like a match. An invoice with
          no payment is the normal case; a payment with no invoice may be for work
          that was never billed.
        </p>
        {onCancel && <button className="btn secondary small" onClick={onCancel}>Close</button>}
      </div>
    );
  }

  return (
    <div style={{ marginTop: 10 }}>
      <h3>{candidates.length === 1 ? 'One possible match' : `${candidates.length} possible matches`}</h3>
      {candidates.map((c) => {
        const k = key(c);
        const typed = amounts[k] ?? '';
        const amountMinor = rupeeInputToMinor(typed);
        const suggested = toMinor(c.suggested_minor);
        const partial = amountMinor !== null && suggested !== null && amountMinor < suggested;
        return (
          <div className="card" key={k}>
            <div className="row">
              <strong>{other(c, side) || 'Name not read'}</strong>
              <span className="amount">{formatRupees(otherAmount(c, side))}</span>
            </div>
            <p className="tiny" style={{ margin: '2px 0 0' }}>
              {side === 'payment'
                ? `${c.invoice_no ?? 'no number'} · issued ${formatDate(c.issued_on)} · ${formatRupees(c.invoice_balance_minor)} outstanding`
                : `paid ${formatDate(c.paid_on)} · ${c.utr ?? 'no reference'} · ${formatRupees(c.payment_unapplied_minor)} unapplied`}
            </p>

            <div className="row" style={{ marginTop: 8 }}>
              <span className={`pill ${c.score >= 0.9 ? 'ok' : ''}`}>
                <span className="score">{c.score.toFixed(2)}</span>
                {c.full_settlement ? ' · settles in full' : ' · partial'}
              </span>
              {!c.date_ok && <span className="pill bad">dates out of order</span>}
            </div>

            <ul className="reasons">
              {c.reasons.map((r) => <li key={r}>{r}</li>)}
            </ul>

            <form
              className="inline"
              style={{ marginTop: 10 }}
              onSubmit={async (e) => {
                e.preventDefault();
                if (amountMinor === null) { setError('Enter an amount above zero'); return; }
                setBusy(k);
                setError(null);
                try {
                  await onPick(c, amountMinor);
                } catch (err) {
                  setError((err as Error).message);
                } finally {
                  setBusy(null);
                }
              }}
            >
              <div className="field" style={{ maxWidth: 160 }}>
                <label htmlFor={`amt-${k}`}>Allocate ₹</label>
                <input
                  id={`amt-${k}`}
                  inputMode="decimal"
                  value={typed}
                  onChange={(e) => setAmounts({ ...amounts, [k]: e.target.value })}
                />
              </div>
              <button className="btn small" disabled={busy !== null}>
                {busy === k ? 'Saving…' : actionLabel}
              </button>
              {partial && (
                <span className="tiny">
                  Leaves {formatRupees((suggested ?? 0n) - (amountMinor ?? 0n))} still open
                </span>
              )}
            </form>
          </div>
        );
      })}
      {error && <p className="err">{error}</p>}
      {onCancel && (
        <button className="btn secondary small" style={{ marginTop: 8 }} onClick={onCancel}>
          Close
        </button>
      )}
    </div>
  );
}

function key(c: Candidate): string {
  return `${c.invoice_id}:${c.payment_id}`;
}

function other(c: Candidate, side: DocKind): string | null {
  return side === 'payment' ? c.customer_name : c.payer_name;
}

function otherAmount(c: Candidate, side: DocKind) {
  return side === 'payment' ? c.invoice_amount_minor : c.payment_amount_minor;
}
