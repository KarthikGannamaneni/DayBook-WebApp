/**
 * Shapes of the view rows the app reads. Hand-written rather than generated:
 * the generator needs a live database at build time, which a static export on
 * GitHub Pages does not have.
 *
 * Amounts are typed as `Minor` because PostgREST may hand back either a JSON
 * number or a string depending on the column; lib/money.ts is the only place
 * that resolves the difference.
 */
import type { Minor } from './money';

export type DocKind = 'invoice' | 'payment';
export type SettleStatus = 'open' | 'part_paid' | 'settled' | 'unreadable';
export type TxnStatus = 'completed' | 'pending' | 'failed';

export interface Counts {
  review_count: number;
  unreadable_count: number;
  pending_count: number;
  pending_minor: Minor;
  matched_count: number;
  matched_minor: Minor;
  unapplied_count: number;
  unapplied_minor: Minor;
  oldest_age_days: number | null;
}

export interface Proposal {
  allocation_id: string;
  score: number | null;
  reasons: string[];
  proposed_minor: Minor;
  invoice_id: string;
  customer_name: string | null;
  invoice_no: string | null;
  issued_on: string | null;
  invoice_amount_minor: Minor;
  invoice_balance_minor: Minor;
  payment_id: string;
  payer_name: string | null;
  paid_on: string | null;
  utr: string | null;
  app: string | null;
  payer_vpa: string | null;
  payee_vpa: string | null;
  note: string | null;
  payment_amount_minor: Minor;
  payment_unapplied_minor: Minor;
}

export interface InvoiceRow {
  id: string;
  customer_name: string | null;
  amount_minor: Minor;
  invoice_no: string | null;
  issued_on: string | null;
  due_on: string | null;
  description: string | null;
  confidence: number | null;
  extraction_notes: string | null;
  allocated_minor: Minor;
  balance_minor: Minor;
  settle_status: SettleStatus;
  age_days: number | null;
}

export interface PaymentRow {
  id: string;
  payer_name: string | null;
  amount_minor: Minor;
  paid_on: string | null;
  utr: string | null;
  payer_vpa: string | null;
  payee_vpa: string | null;
  app: string | null;
  txn_status: TxnStatus;
  note: string | null;
  method: string;
  confidence: number | null;
  extraction_notes: string | null;
  applied_minor: Minor;
  unapplied_minor: Minor;
}

/** A row from match_candidates: one possible pairing, with its reasoning. */
export interface Candidate {
  invoice_id: string;
  payment_id: string;
  suggested_minor: Minor;
  score: number;
  reasons: string[];
  full_settlement: boolean;
  date_ok: boolean;
  customer_name: string | null;
  invoice_amount_minor: Minor;
  invoice_balance_minor: Minor;
  issued_on: string | null;
  invoice_no: string | null;
  payer_name: string | null;
  payment_amount_minor: Minor;
  payment_unapplied_minor: Minor;
  paid_on: string | null;
  utr: string | null;
}

export interface UnreadableRow {
  kind: DocKind;
  id: string;
  party_name: string | null;
  amount_minor: Minor;
  dated: string | null;
  confidence: number | null;
  extraction_notes: string | null;
}

export interface UnclassifiedRow {
  raw_message_id: string;
  body: string | null;
  sender_name: string | null;
  received_at: string;
  storage_path: string;
  thumbnail_path: string | null;
  mime_type: string;
}

export interface DocumentFile {
  id: string;
  storage_path: string;
  thumbnail_path: string | null;
  mime_type: string;
}

export interface DecisionEvent {
  id: number;
  allocation_id: string;
  from_state: 'proposed' | 'accepted' | 'rejected' | null;
  to_state: 'proposed' | 'accepted' | 'rejected';
  amount_minor: Minor;
  actor: 'auto' | 'owner';
  at: string;
}

export interface CustomerBalance {
  customer_key: string;
  display_name: string | null;
  invoice_count: number;
  balance_minor: Minor;
  oldest_age_days: number | null;
}

export interface GroupRow {
  id: string;
  wa_group_id: string;
  name: string | null;
  linked_at: string | null;
}
