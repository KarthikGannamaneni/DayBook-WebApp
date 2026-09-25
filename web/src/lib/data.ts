'use client';

import { supabase } from './client';
import type {
  Candidate, Counts, CustomerBalance, DecisionEvent, DocKind, DocumentFile,
  GroupRow, InvoiceRow, PaymentRow, Proposal, UnclassifiedRow, UnreadableRow,
} from './types';

/**
 * Every read and write in one file, so it is obvious what the app asks the
 * database for. None of these filters by owner: row-level security does that,
 * and a `.eq('owner_id', …)` here would be a comforting duplicate of the only
 * check that actually matters.
 */

function rows<T>(data: unknown): T[] {
  return (data ?? []) as T[];
}

async function must<T>(promise: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new Error(error.message);
  return data as T;
}

// --- reads -----------------------------------------------------------------

export async function getCounts(): Promise<Counts | null> {
  const { data } = await supabase().from('v_counts').select('*').maybeSingle();
  return (data as Counts) ?? null;
}

export async function listProposals(): Promise<Proposal[]> {
  const { data, error } = await supabase()
    .from('v_review_queue')
    .select('*')
    .order('score', { ascending: false })
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return rows<Proposal>(data);
}

/** Money received that the ledger cannot yet explain. The real review work. */
export async function listUnappliedPayments(): Promise<PaymentRow[]> {
  const { data, error } = await supabase()
    .from('v_unapplied_payments')
    .select('*')
    .order('paid_on', { ascending: false });
  if (error) throw new Error(error.message);
  return rows<PaymentRow>(data);
}

export async function listUnreadable(): Promise<UnreadableRow[]> {
  const { data, error } = await supabase()
    .from('v_unreadable_documents')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return rows<UnreadableRow>(data);
}

export async function listUnclassified(): Promise<UnclassifiedRow[]> {
  const { data, error } = await supabase()
    .from('v_unclassified_documents')
    .select('*')
    .order('received_at', { ascending: true });
  if (error) throw new Error(error.message);
  return rows<UnclassifiedRow>(data);
}

export async function listOutstanding(): Promise<InvoiceRow[]> {
  const { data, error } = await supabase()
    .from('v_invoice_status')
    .select('*')
    .in('settle_status', ['open', 'part_paid', 'unreadable'])
    .order('issued_on', { ascending: true, nullsFirst: false });
  if (error) throw new Error(error.message);
  return rows<InvoiceRow>(data);
}

export async function listCustomerBalances(): Promise<CustomerBalance[]> {
  const { data, error } = await supabase()
    .from('v_customer_balances')
    .select('*')
    .order('balance_minor', { ascending: false });
  if (error) throw new Error(error.message);
  return rows<CustomerBalance>(data);
}

export async function listPayments(): Promise<PaymentRow[]> {
  const { data, error } = await supabase()
    .from('v_payment_status')
    .select('*')
    .order('paid_on', { ascending: false, nullsFirst: false })
    .limit(200);
  if (error) throw new Error(error.message);
  return rows<PaymentRow>(data);
}

export async function getInvoice(id: string): Promise<InvoiceRow | null> {
  const { data } = await supabase().from('v_invoice_status').select('*').eq('id', id).maybeSingle();
  return (data as InvoiceRow) ?? null;
}

export async function getPayment(id: string): Promise<PaymentRow | null> {
  const { data } = await supabase().from('v_payment_status').select('*').eq('id', id).maybeSingle();
  return (data as PaymentRow) ?? null;
}

export async function listFiles(kind: DocKind, id: string): Promise<DocumentFile[]> {
  const { data, error } = await supabase()
    .from('document_files')
    .select('id, storage_path, thumbnail_path, mime_type')
    .eq(kind === 'invoice' ? 'invoice_id' : 'payment_id', id);
  if (error) throw new Error(error.message);
  return rows<DocumentFile>(data);
}

/** The shortlist. Same function the bot used, so the ranking cannot diverge. */
export async function matchCandidates(side: DocKind, id: string): Promise<Candidate[]> {
  const { data, error } = await supabase().rpc('match_candidates', { p_side: side, p_id: id });
  if (error) throw new Error(error.message);
  return rows<Candidate>(data);
}

export async function listRecentDecisions(limit = 12): Promise<DecisionEvent[]> {
  const { data, error } = await supabase()
    .from('allocation_events')
    .select('*')
    .eq('actor', 'owner')
    .order('at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return rows<DecisionEvent>(data);
}

export async function listGroups(): Promise<GroupRow[]> {
  const { data, error } = await supabase()
    .from('whatsapp_groups')
    .select('id, wa_group_id, name, linked_at')
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return rows<GroupRow>(data);
}

// --- writes ----------------------------------------------------------------

/**
 * Bulk accept goes through one RPC rather than a loop of updates. A
 * half-applied batch over money is the kind of bug that permanently ends trust
 * in the automation, and the deferred constraint in the schema checks the whole
 * batch at commit.
 */
export async function acceptAllocations(ids: string[]): Promise<number> {
  return must(supabase().rpc('accept_allocations', { p_ids: ids })) as Promise<number>;
}

export async function rejectAllocations(ids: string[]): Promise<number> {
  return must(supabase().rpc('reject_allocations', { p_ids: ids })) as Promise<number>;
}

export async function allocateManual(
  invoiceId: string, paymentId: string, amountMinor: bigint,
): Promise<string> {
  return must(supabase().rpc('allocate_manual', {
    p_invoice_id: invoiceId,
    p_payment_id: paymentId,
    p_amount_minor: amountMinor.toString(),
  })) as Promise<string>;
}

/** Reject one pairing and make another in a single transaction. */
export async function rematch(
  allocationId: string, invoiceId: string, paymentId: string, amountMinor: bigint,
): Promise<string> {
  return must(supabase().rpc('rematch', {
    p_allocation_id: allocationId,
    p_invoice_id: invoiceId,
    p_payment_id: paymentId,
    p_amount_minor: amountMinor.toString(),
  })) as Promise<string>;
}

export async function undoAllocation(allocationId: string): Promise<string> {
  return must(supabase().rpc('undo_allocation', { p_allocation_id: allocationId })) as Promise<string>;
}

export async function classifyRawMessage(rawMessageId: string, kind: DocKind): Promise<string> {
  return must(supabase().rpc('classify_raw_message', {
    p_raw_message_id: rawMessageId,
    p_kind: kind,
  })) as Promise<string>;
}

export async function updateInvoice(id: string, fields: Record<string, unknown>): Promise<void> {
  const { error } = await supabase().from('invoices').update(fields).eq('id', id);
  if (error) throw new Error(error.message);
}

export async function updatePayment(id: string, fields: Record<string, unknown>): Promise<void> {
  const { error } = await supabase().from('payments').update(fields).eq('id', id);
  if (error) throw new Error(error.message);
}

/**
 * A cash payment, which never has a screenshot. Without this a cash-settled
 * invoice looks permanently outstanding, and for a small business in South
 * India that is not an edge case. See docs §10.
 */
export async function recordManualPayment(input: {
  payerName: string;
  amountMinor: bigint;
  paidOn: string;
  method: 'cash' | 'bank' | 'other';
  note: string | null;
}): Promise<string> {
  const { data, error } = await supabase()
    .from('payments')
    .insert({
      owner_id: (await supabase().auth.getUser()).data.user?.id,
      payer_name: input.payerName,
      amount_minor: input.amountMinor.toString(),
      paid_on: input.paidOn,
      method: input.method,
      txn_status: 'completed',
      note: input.note,
      entered_by: 'owner',
    })
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  return data.id as string;
}

/** An invoice that never reached the group. Insurance against §10's first question. */
export async function recordManualInvoice(input: {
  customerName: string;
  amountMinor: bigint;
  issuedOn: string;
  invoiceNo: string | null;
  description: string | null;
}): Promise<string> {
  const { data, error } = await supabase()
    .from('invoices')
    .insert({
      owner_id: (await supabase().auth.getUser()).data.user?.id,
      customer_name: input.customerName,
      amount_minor: input.amountMinor.toString(),
      issued_on: input.issuedOn,
      invoice_no: input.invoiceNo,
      description: input.description,
      entered_by: 'owner',
    })
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  return data.id as string;
}

/** Re-scores a document after the owner corrects it. */
export async function proposeMatches(side: DocKind, id: string): Promise<number> {
  return must(supabase().rpc('propose_matches', { p_side: side, p_id: id })) as Promise<number>;
}
