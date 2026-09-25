'use client';

import { useCallback, useEffect, useState } from 'react';
import { Protected, TopNav } from '@/components/shell';
import { supabase } from '@/lib/client';
import { listGroups, recordManualInvoice, recordManualPayment } from '@/lib/data';
import { rupeeInputToMinor } from '@/lib/money';
import type { GroupRow } from '@/lib/types';

/**
 * Groups, and the two manual entry paths that stop the ledger lying.
 *
 * Cash payments have no screenshot, ever, so without manual entry a cash-settled
 * invoice looks permanently outstanding — and for a small business in South India
 * that is not an edge case. Manual invoice entry is insurance against the open
 * question in docs §10: if invoices go out by email or a Tally print rather than
 * into the group, one whole side of the ledger has no ingestion path.
 */
export default function SettingsPage() {
  return (
    <Protected>
      <Settings />
    </Protected>
  );
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function Settings() {
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setGroups(await listGroups());
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  return (
    <main>
      <TopNav />
      <h1>Settings</h1>
      {error && <p className="err">{error}</p>}
      {notice && <p className="pill ok">{notice}</p>}

      <h2>WhatsApp groups</h2>
      <p className="muted" style={{ marginTop: -4 }}>
        The bot only reads groups listed here. Anything it is added to and that is
        not on this list is ignored entirely, and its messages are not stored.
      </p>
      <GroupForm onDone={async (message) => { setNotice(message); await reload(); }} />
      {groups.length === 0 ? (
        <p className="muted">No groups linked yet.</p>
      ) : (
        groups.map((g) => (
          <div className="card" key={g.id}>
            <div className="row">
              <strong>{g.name ?? g.wa_group_id}</strong>
              <span className="tiny">{g.wa_group_id}</span>
            </div>
          </div>
        ))
      )}

      <hr />

      <h2>Record a cash payment</h2>
      <p className="muted" style={{ marginTop: -4 }}>
        There is never a screenshot for cash. Recording it here puts it in the same
        ledger, so it can settle an invoice like any other payment.
      </p>
      <CashForm onDone={(message) => setNotice(message)} />

      <hr />

      <h2>Add an invoice by hand</h2>
      <p className="muted" style={{ marginTop: -4 }}>
        For an invoice that never went through the group.
      </p>
      <InvoiceForm onDone={(message) => setNotice(message)} />

      <hr />
      <SignOut />
    </main>
  );
}

function GroupForm({ onDone }: { onDone: (message: string) => Promise<void> }) {
  const [waGroupId, setWaGroupId] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="inline"
      style={{ margin: '12px 0' }}
      onSubmit={async (event) => {
        event.preventDefault();
        if (!waGroupId.trim()) { setError('Paste the group id the bot logged'); return; }
        setBusy(true);
        setError(null);
        try {
          const userId = (await supabase().auth.getUser()).data.user?.id;
          const { error: insertError } = await supabase().from('whatsapp_groups').insert({
            owner_id: userId,
            wa_group_id: waGroupId.trim(),
            name: name.trim() || null,
            linked_at: new Date().toISOString(),
          });
          if (insertError) throw new Error(insertError.message);
          setWaGroupId('');
          setName('');
          await onDone('Group linked.');
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="field">
        <label htmlFor="wa">Group id</label>
        <input id="wa" placeholder="1234567890@g.us" value={waGroupId}
          onChange={(e) => setWaGroupId(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="gname">A name for it</label>
        <input id="gname" placeholder="Shop accounts" value={name}
          onChange={(e) => setName(e.target.value)} />
      </div>
      <button className="btn" disabled={busy}>{busy ? 'Linking…' : 'Link'}</button>
      {error && <p className="err" style={{ flexBasis: '100%' }}>{error}</p>}
    </form>
  );
}

function CashForm({ onDone }: { onDone: (message: string) => void }) {
  const [form, setForm] = useState({ payer: '', amount: '', paidOn: today(), note: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="inline"
      onSubmit={async (event) => {
        event.preventDefault();
        const amountMinor = rupeeInputToMinor(form.amount);
        if (!form.payer.trim()) { setError('Who paid?'); return; }
        if (amountMinor === null) { setError('Enter an amount above zero'); return; }
        setBusy(true);
        setError(null);
        try {
          await recordManualPayment({
            payerName: form.payer.trim(),
            amountMinor,
            paidOn: form.paidOn,
            method: 'cash',
            note: form.note.trim() || null,
          });
          setForm({ payer: '', amount: '', paidOn: today(), note: '' });
          onDone('Cash payment recorded. It is in the review queue to be matched.');
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="field">
        <label htmlFor="cpayer">Paid by</label>
        <input id="cpayer" value={form.payer}
          onChange={(e) => setForm({ ...form, payer: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="camount">Amount (₹)</label>
        <input id="camount" inputMode="decimal" value={form.amount}
          onChange={(e) => setForm({ ...form, amount: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="cdate">Paid on</label>
        <input id="cdate" type="date" value={form.paidOn}
          onChange={(e) => setForm({ ...form, paidOn: e.target.value })} />
      </div>
      <button className="btn" disabled={busy}>{busy ? 'Saving…' : 'Record'}</button>
      {error && <p className="err" style={{ flexBasis: '100%' }}>{error}</p>}
    </form>
  );
}

function InvoiceForm({ onDone }: { onDone: (message: string) => void }) {
  const [form, setForm] = useState({ customer: '', amount: '', issuedOn: today(), invoiceNo: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="inline"
      onSubmit={async (event) => {
        event.preventDefault();
        const amountMinor = rupeeInputToMinor(form.amount);
        if (!form.customer.trim()) { setError('Who owes it?'); return; }
        if (amountMinor === null) { setError('Enter an amount above zero'); return; }
        setBusy(true);
        setError(null);
        try {
          await recordManualInvoice({
            customerName: form.customer.trim(),
            amountMinor,
            issuedOn: form.issuedOn,
            invoiceNo: form.invoiceNo.trim() || null,
            description: null,
          });
          setForm({ customer: '', amount: '', issuedOn: today(), invoiceNo: '' });
          onDone('Invoice added.');
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="field">
        <label htmlFor="icustomer">Customer</label>
        <input id="icustomer" value={form.customer}
          onChange={(e) => setForm({ ...form, customer: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="iamount">Amount (₹)</label>
        <input id="iamount" inputMode="decimal" value={form.amount}
          onChange={(e) => setForm({ ...form, amount: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="idate">Issued on</label>
        <input id="idate" type="date" value={form.issuedOn}
          onChange={(e) => setForm({ ...form, issuedOn: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="ino">Number</label>
        <input id="ino" value={form.invoiceNo}
          onChange={(e) => setForm({ ...form, invoiceNo: e.target.value })} />
      </div>
      <button className="btn" disabled={busy}>{busy ? 'Saving…' : 'Add'}</button>
      {error && <p className="err" style={{ flexBasis: '100%' }}>{error}</p>}
    </form>
  );
}

function SignOut() {
  return (
    <button
      className="btn secondary"
      onClick={async () => {
        await supabase().auth.signOut();
        window.location.assign(`${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}/sign-in/`);
      }}
    >
      Sign out
    </button>
  );
}
