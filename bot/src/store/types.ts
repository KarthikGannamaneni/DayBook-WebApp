/**
 * Storage ports. Two of them, because they fail independently: Postgres can be
 * up while the bucket is unreachable, and the pipeline has to keep the document
 * either way.
 */

import type { TxnStatus } from '../extract/types.ts';

export interface GroupLink {
  ownerId: string;
}

export interface SavedRawMessage {
  id: string;
}

/**
 * `existing: true` means the document was already in the books — the same
 * invoice forwarded as a reminder, or a second screenshot of one payment. The
 * pipeline stops there rather than attaching another copy of the image.
 */
export interface SavedDocument {
  id: string;
  existing: boolean;
}

export interface SaveInvoiceInput {
  ownerId: string;
  customerName: string | null;
  amountMinor: bigint | null;
  invoiceNo: string | null;
  issuedOn: string | null;
  dueOn: string | null;
  description: string | null;
  sourceMessageId: string;
  confidence: number;
  extractionNotes: string | null;
}

export interface SavePaymentInput {
  ownerId: string;
  payerName: string | null;
  amountMinor: bigint | null;
  paidOn: string | null;
  utr: string | null;
  payerVpa: string | null;
  payeeVpa: string | null;
  app: string | null;
  txnStatus: TxnStatus;
  note: string | null;
  sourceMessageId: string;
  confidence: number;
  extractionNotes: string | null;
}

export type FileOwner =
  | { kind: 'invoice'; id: string }
  | { kind: 'payment'; id: string }
  /** An image whose document could not be created, because extraction failed. */
  | { kind: 'raw_message'; id: string };

export interface SaveFileInput {
  ownerId: string;
  attachTo: FileOwner;
  storagePath: string;
  thumbnailPath: string | null;
  mimeType: string;
  sizeBytes: number;
  waMessageId: string;
  senderWaId: string | null;
}

export interface Store {
  /** Which owner a group belongs to, or null if nobody has claimed it. */
  findGroup(waGroupId: string): Promise<GroupLink | null>;

  /**
   * Writes the raw message. Returns null when `waMessageId` already exists —
   * the idempotency key that makes reconnection safe.
   */
  saveRawMessage(input: {
    ownerId: string;
    waGroupId: string;
    waMessageId: string;
    senderWaId: string | null;
    senderName: string | null;
    body: string | null;
    hasMedia: boolean;
    receivedAt: Date;
  }): Promise<SavedRawMessage | null>;

  /** Records what the model decided this message was, for debugging a bad run. */
  markRawMessage(
    rawMessageId: string,
    fields: { docKind: 'invoice' | 'payment' | 'neither'; needsClassification?: boolean },
  ): Promise<void>;

  saveInvoice(input: SaveInvoiceInput): Promise<SavedDocument>;
  savePayment(input: SavePaymentInput): Promise<SavedDocument>;
  saveFile(input: SaveFileInput): Promise<void>;

  /**
   * Asks the database for candidate pairings on the opposite side of the
   * ledger and writes any it is sure of as proposals. Returns how many.
   *
   * The matcher is SQL, not TypeScript, because the review screen needs the
   * same ranking live for its shortlist. See docs/p0-tech-design.md §1.
   */
  proposeMatches(side: 'invoice' | 'payment', documentId: string): Promise<number>;
}

export interface FileStore {
  /** Full quality, no re-encoding. A document that loses a digit is worthless. */
  put(path: string, bytes: Uint8Array, mimeType: string): Promise<void>;
}

/**
 * Optional. The review screen shows two images side by side, and a weekly
 * session over a phone connection cannot fetch 600 KB per item.
 */
export type Thumbnailer = (bytes: Uint8Array, mimeType: string) => Promise<Uint8Array | null>;
