/**
 * The seam between the pipeline and the model, so the pipeline can be tested
 * without a network call or an API key.
 */

export type DocKind = 'invoice' | 'payment' | 'neither';

/** What a UPI app says about the transaction. Only 'completed' is money. */
export type TxnStatus = 'completed' | 'pending' | 'failed';

export interface ExtractionInput {
  text: string | null;
  media: { mimeType: string; bytes: Uint8Array } | null;
  /** The message's own date, used when the document shows none. */
  messageDate: string;
  senderName: string | null;
}

export interface InvoiceFields {
  customerName: string | null;
  amountRupees: number | null;
  invoiceNo: string | null;
  issuedOn: string | null;
  dueOn: string | null;
  description: string | null;
}

export interface PaymentFields {
  payerName: string | null;
  amountRupees: number | null;
  paidOn: string | null;
  /** The UPI reference. The one dedupe key strong enough to collapse reposts. */
  utr: string | null;
  payerVpa: string | null;
  /**
   * Who was paid. A forwarded screenshot of a payment to somebody else's handle
   * is not a receipt for this business, so this is read even though P0 only
   * displays it.
   */
  payeeVpa: string | null;
  app: string | null;
  txnStatus: TxnStatus;
  /** Sometimes carries an invoice number, which makes matching decisive. */
  note: string | null;
}

export interface Extraction {
  docKind: DocKind;
  /** 0–1, and about the AMOUNT specifically. See the prompt. */
  confidence: number;
  /** Set when docKind is 'invoice'. */
  invoice: InvoiceFields | null;
  /** Set when docKind is 'payment'. */
  payment: PaymentFields | null;
  language: 'en' | 'te' | 'mixed';
  /** What was unclear. Shown to the owner in the review queue. */
  notes: string | null;
}

export interface Extractor {
  extract(input: ExtractionInput): Promise<Extraction>;
}
