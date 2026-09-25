import type { IncomingMessage } from './sources/types.ts';
import type { Extraction, InvoiceFields, PaymentFields } from './extract/types.ts';
import type { FileOwner, FileStore, Store, Thumbnailer } from './store/types.ts';

/**
 * receive → dedupe → persist raw → classify+extract → insert invoice|payment
 * → store file → propose matches.
 *
 * Everything the bot does to a message happens here, and it is a plain function
 * over four ports so the whole thing can be tested without WhatsApp, Gemini,
 * Postgres or a bucket. See docs/p0-tech-design.md §5.
 *
 * The bot runs with the service-role key and therefore bypasses row-level
 * security entirely. That makes `ownerId` in this file load-bearing: it is
 * resolved once, from the group mapping, and every write is scoped by it.
 * Nothing from the message itself is ever trusted to say who owns a row.
 */

export interface PipelineDeps {
  store: Store;
  files: FileStore;
  extractor: { extract: (input: {
    text: string | null;
    media: { mimeType: string; bytes: Uint8Array } | null;
    messageDate: string;
    senderName: string | null;
  }) => Promise<Extraction> };
  thumbnail?: Thumbnailer;
  now?: () => Date;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

export interface PipelineConfig {
  /** Above this, a single amount is a misread decimal point far more often
   *  than a real transaction in this product. */
  maxRupees: number;
}

export const DEFAULT_CONFIG: PipelineConfig = {
  maxRupees: 10_000_000,
};

export type PipelineResult =
  | { outcome: 'ignored'; reason: 'unknown-group' | 'duplicate-message' }
  | { outcome: 'not-document'; rawMessageId: string }
  | { outcome: 'unclassified'; rawMessageId: string }
  | { outcome: 'duplicate-document'; kind: 'invoice' | 'payment'; documentId: string }
  | {
      outcome: 'saved';
      kind: 'invoice' | 'payment';
      documentId: string;
      proposed: number;
      attention: string[];
    };

/** Rupees as a float from the model, to paise as an integer, or null. */
export function toPaise(rupees: number | null, maxRupees = DEFAULT_CONFIG.maxRupees): bigint | null {
  if (rupees === null || !Number.isFinite(rupees)) return null;
  if (rupees <= 0) return null;
  if (rupees > maxRupees) return null;
  return BigInt(Math.round(rupees * 100));
}

function isIsoDate(value: string | null): value is string {
  return value !== null && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

function dayString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Whether a human has to look at this document before it can be matched at all,
 * and why.
 *
 * This is a readability check, NOT a matching decision — the two confidences are
 * deliberately separate. A perfectly legible payment screenshot can still be a
 * confidently wrong pairing, and the fix is different in each case: correct a
 * field, or pick a different invoice. Conflating them produces a review screen
 * that cannot say what it doubts.
 */
export function readability(extraction: Extraction, amountMinor: bigint | null): string[] {
  const reasons: string[] = [];
  if (amountMinor === null) reasons.push('no amount could be read');

  if (extraction.docKind === 'invoice') {
    if (!extraction.invoice?.customerName) reasons.push('no customer name');
  }

  if (extraction.docKind === 'payment') {
    if (!extraction.payment?.payerName) reasons.push('no payer name');
    // A screenshot of a failed or pending transaction is a screenshot of money
    // that did not arrive. It is stored and shown, never allocated.
    if (extraction.payment && extraction.payment.txnStatus !== 'completed') {
      reasons.push(`the app reports this payment as ${extraction.payment.txnStatus}`);
    }
  }

  return reasons;
}

function extensionFor(mimeType: string): string {
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/webp') return 'webp';
  return 'jpg';
}

function folderFor(attachTo: FileOwner): string {
  return attachTo.kind === 'raw_message' ? 'unclassified' : attachTo.kind;
}

/**
 * Stores the original, and a thumbnail if one can be made.
 *
 * Deliberately last in the pipeline and deliberately swallowing its own errors:
 * a document without its image is recoverable, an image with no row is
 * invisible to everyone. A bucket outage must not cost the row.
 */
async function storeFile(
  message: IncomingMessage,
  deps: PipelineDeps,
  ownerId: string,
  attachTo: FileOwner,
): Promise<void> {
  if (!message.media) return;
  const log = deps.log ?? (() => {});
  const media = message.media;
  const base = `${ownerId}/${folderFor(attachTo)}/${attachTo.id}`;
  const path = `${base}/original.${extensionFor(media.mimeType)}`;

  try {
    await deps.files.put(path, media.bytes, media.mimeType);

    let thumbnailPath: string | null = null;
    if (deps.thumbnail) {
      try {
        const thumb = await deps.thumbnail(media.bytes, media.mimeType);
        if (thumb) {
          thumbnailPath = `${base}/thumb.webp`;
          await deps.files.put(thumbnailPath, thumb, 'image/webp');
        }
      } catch (error) {
        // A missing thumbnail costs bandwidth, nothing else.
        thumbnailPath = null;
        log('thumbnail-failed', { path, error: String(error) });
      }
    }

    await deps.store.saveFile({
      ownerId,
      attachTo,
      storagePath: path,
      thumbnailPath,
      mimeType: media.mimeType,
      sizeBytes: media.bytes.byteLength,
      waMessageId: message.waMessageId,
      senderWaId: message.senderWaId,
    });
  } catch (error) {
    log('file-store-failed', { path, error: String(error) });
  }
}

export async function handleMessage(
  message: IncomingMessage,
  deps: PipelineDeps,
  config: PipelineConfig = DEFAULT_CONFIG,
): Promise<PipelineResult> {
  const log = deps.log ?? (() => {});

  // 1. Whose group is this? Unknown groups are ignored entirely — the bot may
  //    sit in groups nobody has claimed, and it must not store their contents.
  const group = await deps.store.findGroup(message.waGroupId);
  if (!group) {
    log('ignored', { reason: 'unknown-group', waGroupId: message.waGroupId });
    return { outcome: 'ignored', reason: 'unknown-group' };
  }

  // 2 + 3. Dedupe and persist, in one insert. The unique constraint on
  //        wa_message_id is the dedupe; a null return means we have seen it.
  //        This happens BEFORE the model call so a crash mid-pipeline loses
  //        nothing and the 30-day recovery window starts immediately.
  const raw = await deps.store.saveRawMessage({
    ownerId: group.ownerId,
    waGroupId: message.waGroupId,
    waMessageId: message.waMessageId,
    senderWaId: message.senderWaId,
    senderName: message.senderName,
    body: message.text,
    hasMedia: message.media !== null,
    receivedAt: message.sentAt,
  });
  if (!raw) {
    log('ignored', { reason: 'duplicate-message', waMessageId: message.waMessageId });
    return { outcome: 'ignored', reason: 'duplicate-message' };
  }

  // 4. One call: decide what this is, and read it.
  let extraction: Extraction;
  try {
    extraction = await deps.extractor.extract({
      text: message.text,
      media: message.media,
      messageDate: dayString(message.sentAt),
      senderName: message.senderName,
    });
  } catch (error) {
    log('extract-failed', { waMessageId: message.waMessageId, error: String(error) });

    // With no image there is nothing to lose: the message body is already
    // stored, and inventing a document from text we could not parse would put a
    // row in the ledger that nothing supports.
    if (!message.media) return { outcome: 'not-document', rawMessageId: raw.id };

    // With an image, we know a document arrived but not which side of the
    // ledger it belongs to. Park the image against the message and let the
    // owner say. Guessing here would file a receipt as a receivable.
    await deps.store.markRawMessage(raw.id, { docKind: 'neither', needsClassification: true });
    await storeFile(message, deps, group.ownerId, { kind: 'raw_message', id: raw.id });
    return { outcome: 'unclassified', rawMessageId: raw.id };
  }

  await deps.store.markRawMessage(raw.id, { docKind: extraction.docKind });

  if (extraction.docKind === 'neither') {
    log('not-document', { waMessageId: message.waMessageId });
    return { outcome: 'not-document', rawMessageId: raw.id };
  }

  const fields: InvoiceFields | PaymentFields | null =
    extraction.docKind === 'invoice' ? extraction.invoice : extraction.payment;

  // The model claimed a kind but returned no body for it. Treat it as a failed
  // read rather than writing an empty document.
  if (!fields) {
    log('extract-empty', { waMessageId: message.waMessageId, docKind: extraction.docKind });
    if (!message.media) return { outcome: 'not-document', rawMessageId: raw.id };
    await deps.store.markRawMessage(raw.id, { docKind: 'neither', needsClassification: true });
    await storeFile(message, deps, group.ownerId, { kind: 'raw_message', id: raw.id });
    return { outcome: 'unclassified', rawMessageId: raw.id };
  }

  const amountMinor = toPaise(fields.amountRupees, config.maxRupees);
  const attention = readability(extraction, amountMinor);
  const notes = [extraction.notes, ...attention].filter(Boolean).join('; ') || null;

  // 5. Insert the document. A conflict here is the SECOND dedupe: the same
  //    invoice forwarded as a reminder, or another screenshot of one payment.
  //    Both arrive as new messages with new ids, so wa_message_id cannot catch
  //    them, and without this receivables double every time somebody chases.
  let saved;
  let side: 'invoice' | 'payment';

  if (extraction.docKind === 'invoice') {
    const invoice = fields as InvoiceFields;
    side = 'invoice';
    saved = await deps.store.saveInvoice({
      ownerId: group.ownerId,
      customerName: invoice.customerName,
      amountMinor,
      invoiceNo: invoice.invoiceNo,
      issuedOn: isIsoDate(invoice.issuedOn) ? invoice.issuedOn : dayString(message.sentAt),
      dueOn: isIsoDate(invoice.dueOn) ? invoice.dueOn : null,
      description: invoice.description,
      sourceMessageId: raw.id,
      confidence: extraction.confidence,
      extractionNotes: notes,
    });
  } else {
    const payment = fields as PaymentFields;
    side = 'payment';
    saved = await deps.store.savePayment({
      ownerId: group.ownerId,
      payerName: payment.payerName,
      amountMinor,
      paidOn: isIsoDate(payment.paidOn) ? payment.paidOn : dayString(message.sentAt),
      utr: payment.utr,
      payerVpa: payment.payerVpa,
      payeeVpa: payment.payeeVpa,
      app: payment.app,
      txnStatus: payment.txnStatus,
      note: payment.note,
      sourceMessageId: raw.id,
      confidence: extraction.confidence,
      extractionNotes: notes,
    });
  }

  if (saved.existing) {
    log('duplicate-document', { kind: side, documentId: saved.id, waMessageId: message.waMessageId });
    return { outcome: 'duplicate-document', kind: side, documentId: saved.id };
  }

  // 6. The file after the row.
  await storeFile(message, deps, group.ownerId, { kind: side, id: saved.id });

  // 7. Matching last. It is derivable and idempotent — it only ever writes
  //    proposals and never touches an accepted allocation — so a failure here
  //    costs a proposal, never a document, and re-running it is always safe.
  //
  //    Nothing unreadable is offered to the matcher: an amount that could not
  //    be read cannot be compared to a balance, and a payment the app reports
  //    as failed is not money.
  let proposed = 0;
  if (attention.length === 0) {
    try {
      proposed = await deps.store.proposeMatches(side, saved.id);
    } catch (error) {
      log('propose-failed', { kind: side, documentId: saved.id, error: String(error) });
    }
  }

  log('saved', { kind: side, documentId: saved.id, proposed, attention });
  return { outcome: 'saved', kind: side, documentId: saved.id, proposed, attention };
}
