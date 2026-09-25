import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  GroupLink, SaveFileInput, SaveInvoiceInput, SavePaymentInput,
  SavedDocument, SavedRawMessage, Store,
} from './types.ts';

/** Unique violation. Both dedupe paths in this file turn on it. */
const UNIQUE_VIOLATION = '23505';

/**
 * The bot's database adapter. It holds the SERVICE ROLE key and therefore
 * bypasses row-level security completely, which is why every method here takes
 * an explicit ownerId and never derives one from message content.
 *
 * bigint crosses the wire as a string throughout. A JS number cannot hold large
 * paise values without losing precision, and money that loses precision on the
 * way to the database is the bug this whole schema is shaped to avoid.
 */
export class SupabaseStore implements Store {
  constructor(private readonly db: SupabaseClient) {}

  static fromEnv(): SupabaseStore {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
    return new SupabaseStore(createClient(url, key, { auth: { persistSession: false } }));
  }

  async findGroup(waGroupId: string): Promise<GroupLink | null> {
    const { data } = await this.db
      .from('whatsapp_groups')
      .select('owner_id')
      .eq('wa_group_id', waGroupId)
      .maybeSingle();
    return data ? { ownerId: data.owner_id } : null;
  }

  async saveRawMessage(input: {
    ownerId: string; waGroupId: string; waMessageId: string;
    senderWaId: string | null; senderName: string | null;
    body: string | null; hasMedia: boolean; receivedAt: Date;
  }): Promise<SavedRawMessage | null> {
    const { data, error } = await this.db
      .from('raw_messages')
      .insert({
        owner_id: input.ownerId,
        wa_group_id: input.waGroupId,
        wa_message_id: input.waMessageId,
        sender_wa_id: input.senderWaId,
        sender_name: input.senderName,
        body: input.body,
        has_media: input.hasMedia,
        received_at: input.receivedAt.toISOString(),
      })
      .select('id')
      .single();

    // A unique violation on wa_message_id means we have seen this message. That
    // is the dedupe, and it is why reconnection is safe.
    if (error) {
      if (error.code === UNIQUE_VIOLATION) return null;
      throw new Error(`saveRawMessage: ${error.message}`);
    }
    return { id: data.id };
  }

  async markRawMessage(
    rawMessageId: string,
    fields: { docKind: 'invoice' | 'payment' | 'neither'; needsClassification?: boolean },
  ): Promise<void> {
    const { error } = await this.db
      .from('raw_messages')
      .update({
        doc_kind: fields.docKind,
        ...(fields.needsClassification === undefined
          ? {}
          : { needs_classification: fields.needsClassification }),
      })
      .eq('id', rawMessageId);
    if (error) throw new Error(`markRawMessage: ${error.message}`);
  }

  async saveInvoice(input: SaveInvoiceInput): Promise<SavedDocument> {
    const { data, error } = await this.db
      .from('invoices')
      .insert({
        owner_id: input.ownerId,
        customer_name: input.customerName,
        amount_minor: input.amountMinor === null ? null : input.amountMinor.toString(),
        invoice_no: input.invoiceNo,
        issued_on: input.issuedOn,
        due_on: input.dueOn,
        description: input.description,
        source_message_id: input.sourceMessageId,
        confidence: input.confidence,
        extraction_notes: input.extractionNotes,
        entered_by: 'auto',
      })
      .select('id')
      .single();

    if (!error) return { id: data.id, existing: false };
    if (error.code !== UNIQUE_VIOLATION) throw new Error(`saveInvoice: ${error.message}`);

    // The same invoice forwarded again as a reminder. Find the receivable it
    // already created rather than making a second one.
    if (input.invoiceNo) {
      const existing = await this.db
        .from('invoices')
        .select('id')
        .eq('owner_id', input.ownerId)
        .eq('invoice_no', input.invoiceNo)
        .maybeSingle();
      if (existing.data) return { id: existing.data.id, existing: true };
    }
    throw new Error(`saveInvoice: ${error.message}`);
  }

  async savePayment(input: SavePaymentInput): Promise<SavedDocument> {
    const { data, error } = await this.db
      .from('payments')
      .insert({
        owner_id: input.ownerId,
        payer_name: input.payerName,
        amount_minor: input.amountMinor === null ? null : input.amountMinor.toString(),
        paid_on: input.paidOn,
        utr: input.utr,
        payer_vpa: input.payerVpa,
        payee_vpa: input.payeeVpa,
        app: input.app,
        txn_status: input.txnStatus,
        note: input.note,
        method: 'upi',
        source_message_id: input.sourceMessageId,
        confidence: input.confidence,
        extraction_notes: input.extractionNotes,
        entered_by: 'auto',
      })
      .select('id')
      .single();

    if (!error) return { id: data.id, existing: false };
    if (error.code !== UNIQUE_VIOLATION) throw new Error(`savePayment: ${error.message}`);

    // A second screenshot of one transaction. The UTR is what makes this
    // detectable at all.
    if (input.utr) {
      const existing = await this.db
        .from('payments')
        .select('id')
        .eq('owner_id', input.ownerId)
        .eq('utr', input.utr)
        .maybeSingle();
      if (existing.data) return { id: existing.data.id, existing: true };
    }
    throw new Error(`savePayment: ${error.message}`);
  }

  async saveFile(input: SaveFileInput): Promise<void> {
    const { error } = await this.db.from('document_files').insert({
      owner_id: input.ownerId,
      invoice_id: input.attachTo.kind === 'invoice' ? input.attachTo.id : null,
      payment_id: input.attachTo.kind === 'payment' ? input.attachTo.id : null,
      raw_message_id: input.attachTo.kind === 'raw_message' ? input.attachTo.id : null,
      storage_path: input.storagePath,
      thumbnail_path: input.thumbnailPath,
      mime_type: input.mimeType,
      size_bytes: input.sizeBytes,
      wa_message_id: input.waMessageId,
      sender_wa_id: input.senderWaId,
    });
    if (error) throw new Error(`saveFile: ${error.message}`);
  }

  async proposeMatches(side: 'invoice' | 'payment', documentId: string): Promise<number> {
    const { data, error } = await this.db.rpc('propose_matches', {
      p_side: side,
      p_id: documentId,
    });
    if (error) throw new Error(`proposeMatches: ${error.message}`);
    return typeof data === 'number' ? data : 0;
  }
}
