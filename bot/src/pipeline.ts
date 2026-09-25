import type { IncomingMessage } from './sources/types.ts';
import type { Extraction, Extractor } from './extract/types.ts';
import type { FileStore, Store } from './store/types.ts';

/**
 * receive → dedupe → persist raw → classify+extract → store file → save
 * expense → confidence gate.
 *
 * Everything the bot does to a message happens here, and it is a plain
 * function over four ports so the whole thing can be tested without WhatsApp,
 * Gemini, Postgres or R2. See docs/p0-tech-design.md §4.
 *
 * The bot runs with the service-role key and therefore bypasses row-level
 * security entirely. That makes `ownerId` in this file load-bearing: it is
 * resolved once, from the group mapping, and every write is scoped by it.
 * Nothing from the message itself is ever trusted to say who owns a row.
 */

export interface PipelineDeps {
  store: Store;
  files: FileStore;
  extractor: Extractor;
  now?: () => Date;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

export interface PipelineConfig {
  confidenceThreshold: number;
  duplicateWindowDays: number;
}

export const DEFAULT_CONFIG: PipelineConfig = {
  confidenceThreshold: 0.75,
  duplicateWindowDays: 7,
};

export type PipelineResult =
  | { outcome: 'ignored'; reason: 'unknown-group' | 'unlinked-group' | 'duplicate' }
  | { outcome: 'not-expense'; rawMessageId: string }
  | { outcome: 'saved'; expenseId: string; status: 'confirmed' | 'needs_review'; reasons: string[] };

/** Rupees as a float from the model, to paise as an integer, or null. */
export function toPaise(rupees: number | null): bigint | null {
  if (rupees === null || !Number.isFinite(rupees)) return null;
  if (rupees <= 0) return null;
  // A single expense above ₹1 crore is a misread decimal point far more often
  // than it is a real bill in this product. Refuse it and let a human look.
  if (rupees > 10_000_000) return null;
  return BigInt(Math.round(rupees * 100));
}

function isIsoDate(value: string | null): value is string {
  return value !== null && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

/**
 * Decides confirmed vs needs_review, and says why.
 *
 * Exported because the reasons are shown to the owner, and because this is the
 * rule most likely to be tuned once there is real accuracy data.
 */
export function gate(
  extraction: Extraction,
  amountMinor: bigint | null,
  spentOn: string | null,
  threshold: number,
): { status: 'confirmed' | 'needs_review'; reasons: string[] } {
  const reasons: string[] = [];

  if (amountMinor === null) reasons.push('no amount could be read');
  if (spentOn === null) reasons.push('no date could be read');
  if (extraction.confidence < threshold) {
    reasons.push(`confidence ${extraction.confidence.toFixed(2)} below ${threshold}`);
  }
  if (!extraction.vendor) reasons.push('no vendor');

  return { status: reasons.length === 0 ? 'confirmed' : 'needs_review', reasons };
}

function dayString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function extensionFor(mimeType: string): string {
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/webp') return 'webp';
  return 'jpg';
}

export async function handleMessage(
  message: IncomingMessage,
  deps: PipelineDeps,
  config: PipelineConfig = DEFAULT_CONFIG,
): Promise<PipelineResult> {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? (() => new Date());

  // 1. Whose group is this? Unknown groups are ignored entirely — the bot may
  //    sit in groups nobody has claimed, and it must not store their contents.
  const group = await deps.store.findGroup(message.waGroupId);
  if (!group) {
    log('ignored', { reason: 'unknown-group', waGroupId: message.waGroupId });
    return { outcome: 'ignored', reason: 'unknown-group' };
  }
  if (!group.projectId) {
    log('ignored', { reason: 'unlinked-group', waGroupId: message.waGroupId });
    return { outcome: 'ignored', reason: 'unlinked-group' };
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
    log('ignored', { reason: 'duplicate', waMessageId: message.waMessageId });
    return { outcome: 'ignored', reason: 'duplicate' };
  }

  // 4. One call: classify and extract together.
  const categories = await deps.store.listCategoryNames(group.ownerId);
  let extraction: Extraction;
  try {
    extraction = await deps.extractor.extract({
      text: message.text,
      media: message.media,
      messageDate: dayString(message.sentAt),
      senderName: message.senderName,
      categories,
    });
  } catch (error) {
    // The model failing must never lose the bill. Save it for review with
    // whatever we have; the raw row and the file are the source of truth.
    log('extract-failed', { waMessageId: message.waMessageId, error: String(error) });
    extraction = {
      isExpense: message.media !== null,
      confidence: 0,
      amountRupees: null,
      date: null,
      vendor: null,
      description: message.text?.slice(0, 60) ?? null,
      category: null,
      language: 'en',
      notes: 'Could not be read automatically.',
    };
    if (!extraction.isExpense) {
      return { outcome: 'not-expense', rawMessageId: raw.id };
    }
  }

  if (!extraction.isExpense) {
    log('not-expense', { waMessageId: message.waMessageId });
    return { outcome: 'not-expense', rawMessageId: raw.id };
  }

  const amountMinor = toPaise(extraction.amountRupees);
  const spentOn = isIsoDate(extraction.date) ? extraction.date : dayString(message.sentAt);
  const verdict = gate(extraction, amountMinor, spentOn, config.confidenceThreshold);

  // The same bill posted twice has two different message ids, so dedupe does
  // not catch it. Flag, never discard.
  if (amountMinor !== null) {
    const similar = await deps.store.findRecentSimilarExpense({
      projectId: group.projectId,
      amountMinor,
      spentOn,
      vendor: extraction.vendor,
      withinDays: config.duplicateWindowDays,
    });
    if (similar) {
      verdict.status = 'needs_review';
      verdict.reasons.push('possible duplicate of a recent expense');
    }
  }

  const categoryId = await deps.store.resolveCategoryId(group.ownerId, extraction.category);

  const notes = [extraction.notes, ...verdict.reasons].filter(Boolean).join('; ') || null;
  const expense = await deps.store.saveExpense({
    ownerId: group.ownerId,
    projectId: group.projectId,
    amountMinor,
    spentOn,
    vendor: extraction.vendor,
    description: extraction.description,
    categoryId,
    postedByWaId: message.senderWaId,
    postedByName: message.senderName,
    sourceMessageId: raw.id,
    status: verdict.status,
    confidence: extraction.confidence,
    extractionNotes: notes,
  });

  // 5. The file last, so a storage outage cannot cost us the expense row. An
  //    expense without its bill is recoverable; a bill with no row is not
  //    visible to anyone.
  if (message.media) {
    const path = `${group.ownerId}/${group.projectId}/${expense.id}/original.${extensionFor(message.media.mimeType)}`;
    try {
      await deps.files.put(path, message.media.bytes, message.media.mimeType);
      await deps.store.saveFile({
        ownerId: group.ownerId,
        expenseId: expense.id,
        storagePath: path,
        thumbnailPath: null,
        mimeType: message.media.mimeType,
        sizeBytes: message.media.bytes.byteLength,
        waMessageId: message.waMessageId,
        senderWaId: message.senderWaId,
      });
    } catch (error) {
      log('file-store-failed', { expenseId: expense.id, error: String(error) });
    }
  }

  log('saved', { expenseId: expense.id, status: verdict.status, at: now().toISOString() });
  return { outcome: 'saved', expenseId: expense.id, status: verdict.status, reasons: verdict.reasons };
}
