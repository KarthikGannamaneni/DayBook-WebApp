'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/client';
import { undoAllocation } from '@/lib/data';
import { formatRupees } from '@/lib/money';
import type { DecisionEvent } from '@/lib/types';

/**
 * Who matched what, and when — read from the append-only decision log.
 *
 * On a detail screen this is the answer to "why does this invoice say settled",
 * which is the first thing anyone asks when a balance looks wrong. Each row
 * carries its own undo, because a mistake found three screens later is still a
 * mistake worth one tap.
 */
export function AllocationHistory({
  kind, documentId, onChange,
}: {
  kind: 'invoice' | 'payment';
  documentId: string;
  onChange?: () => void;
}) {
  const [events, setEvents] = useState<DecisionEvent[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const column = kind === 'invoice' ? 'invoice_id' : 'payment_id';
    const { data: allocations, error: allocError } = await supabase()
      .from('allocations')
      .select('id')
      .eq(column, documentId);
    if (allocError) { setError(allocError.message); setEvents([]); return; }

    const ids = (allocations ?? []).map((a) => a.id as string);
    if (ids.length === 0) { setEvents([]); return; }

    const { data, error: eventError } = await supabase()
      .from('allocation_events')
      .select('*')
      .in('allocation_id', ids)
      .order('at', { ascending: false });
    if (eventError) { setError(eventError.message); setEvents([]); return; }
    setEvents((data ?? []) as DecisionEvent[]);
  }

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [kind, documentId]);

  if (!events || events.length === 0) return null;

  return (
    <>
      <h2>History</h2>
      {error && <p className="err">{error}</p>}
      {events.map((e, index) => (
        <div className="card" key={e.id}>
          <div className="row">
            <span>
              {describe(e)} <span className="amount">{formatRupees(e.amount_minor)}</span>
            </span>
            <span className="tiny">
              {new Date(e.at).toLocaleString('en-IN')} · {e.actor === 'auto' ? 'automatic' : 'by you'}
            </span>
          </div>
          {index === 0 && e.from_state !== null && (
            <div className="actions">
              <button
                className="btn secondary small"
                disabled={busy !== null}
                onClick={async () => {
                  setBusy(e.allocation_id);
                  setError(null);
                  try {
                    await undoAllocation(e.allocation_id);
                    await load();
                    onChange?.();
                  } catch (err) {
                    setError((err as Error).message);
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                {busy === e.allocation_id ? 'Undoing…' : 'Undo this'}
              </button>
            </div>
          )}
        </div>
      ))}
    </>
  );
}

function describe(event: DecisionEvent): string {
  if (event.from_state === null) {
    return event.to_state === 'accepted' ? 'Matched by hand' : 'Match suggested';
  }
  if (event.to_state === 'accepted') return 'Match accepted';
  if (event.to_state === 'rejected') return 'Match rejected';
  return 'Match returned to review';
}
