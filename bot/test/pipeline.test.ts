import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, gate, handleMessage, toPaise } from '../src/pipeline.ts';
import type { IncomingMessage } from '../src/sources/types.ts';
import type { Extraction } from '../src/extract/types.ts';
import type { SaveExpenseInput, SaveFileInput, Store } from '../src/store/types.ts';

const OWNER = 'owner-1';
const PROJECT = 'project-1';

function message(over: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    waMessageId: 'wamid.1',
    waGroupId: 'group-1@g.us',
    senderWaId: '919999900001@s.whatsapp.net',
    senderName: 'Ravi',
    text: 'cement 4500',
    sentAt: new Date('2026-09-20T10:00:00Z'),
    media: null,
    ...over,
  };
}

function extraction(over: Partial<Extraction> = {}): Extraction {
  return {
    isExpense: true,
    confidence: 0.95,
    amountRupees: 4500,
    date: '2026-09-20',
    vendor: 'Sri Balaji Cements',
    description: 'Cement bags',
    category: 'Materials',
    language: 'en',
    notes: null,
    ...over,
  };
}

interface Harness {
  store: Store;
  files: { put: (p: string, b: Uint8Array, m: string) => Promise<void> };
  extractor: { extract: () => Promise<Extraction> };
  saved: SaveExpenseInput[];
  savedFiles: SaveFileInput[];
  rawInserts: string[];
  putPaths: string[];
}

function harness(options: {
  group?: { ownerId: string; projectId: string | null } | null;
  extraction?: Extraction;
  extractThrows?: boolean;
  seenMessageIds?: Set<string>;
  similar?: boolean;
  filePutThrows?: boolean;
} = {}): Harness {
  const saved: SaveExpenseInput[] = [];
  const savedFiles: SaveFileInput[] = [];
  const rawInserts: string[] = [];
  const putPaths: string[] = [];
  const seen = options.seenMessageIds ?? new Set<string>();

  const store: Store = {
    findGroup: async () =>
      options.group === undefined ? { ownerId: OWNER, projectId: PROJECT } : options.group,
    saveRawMessage: async (input) => {
      if (seen.has(input.waMessageId)) return null;
      seen.add(input.waMessageId);
      rawInserts.push(input.waMessageId);
      return { id: `raw-${input.waMessageId}` };
    },
    listCategoryNames: async () => ['Materials', 'Labour', 'Other'],
    resolveCategoryId: async (_owner, name) => (name ? `cat-${name}` : null),
    saveExpense: async (input) => {
      saved.push(input);
      return { id: `exp-${saved.length}` };
    },
    saveFile: async (input) => {
      savedFiles.push(input);
    },
    findRecentSimilarExpense: async () => options.similar === true,
  };

  return {
    store,
    files: {
      put: async (path) => {
        if (options.filePutThrows) throw new Error('bucket unreachable');
        putPaths.push(path);
      },
    },
    extractor: {
      extract: async () => {
        if (options.extractThrows) throw new Error('gemini timeout');
        return options.extraction ?? extraction();
      },
    },
    saved,
    savedFiles,
    rawInserts,
    putPaths,
  };
}

describe('toPaise', () => {
  it('converts rupees to integer paise', () => {
    expect(toPaise(4500)).toBe(4500_00n);
    expect(toPaise(1234.56)).toBe(123456n);
  });

  it('rounds half-up rather than truncating', () => {
    expect(toPaise(0.015)).toBe(2n);
  });

  it('refuses anything that is not a usable amount', () => {
    expect(toPaise(null)).toBeNull();
    expect(toPaise(0)).toBeNull();
    expect(toPaise(-100)).toBeNull();
    expect(toPaise(Number.NaN)).toBeNull();
  });

  it('refuses an implausibly large amount', () => {
    // Above a crore is a misplaced decimal point far more often than a real
    // bill in this product. A human should look at it.
    expect(toPaise(50_000_000)).toBeNull();
  });
});

describe('the confidence gate', () => {
  it('confirms a complete, confident extraction', () => {
    const v = gate(extraction(), 4500_00n, '2026-09-20', 0.75);
    expect(v.status).toBe('confirmed');
    expect(v.reasons).toEqual([]);
  });

  it('holds anything below the threshold, and says so', () => {
    const v = gate(extraction({ confidence: 0.4 }), 4500_00n, '2026-09-20', 0.75);
    expect(v.status).toBe('needs_review');
    expect(v.reasons.join(' ')).toContain('0.40');
  });

  it('holds a confident extraction that still has no amount', () => {
    // Confidence is about the amount, so this combination should be rare —
    // but an unreadable total must never reach the ledger regardless.
    const v = gate(extraction({ confidence: 0.99 }), null, '2026-09-20', 0.75);
    expect(v.status).toBe('needs_review');
    expect(v.reasons).toContain('no amount could be read');
  });

  it('holds an extraction with no vendor', () => {
    const v = gate(extraction({ vendor: null }), 4500_00n, '2026-09-20', 0.75);
    expect(v.status).toBe('needs_review');
  });
});

describe('handleMessage', () => {
  it('ignores a group nobody has claimed, and stores nothing', async () => {
    const h = harness({ group: null });
    const result = await handleMessage(message(), h);

    expect(result).toEqual({ outcome: 'ignored', reason: 'unknown-group' });
    // The bot may sit in groups that are not customers'. It must not keep
    // their messages.
    expect(h.rawInserts).toEqual([]);
  });

  it('ignores a known group that is not pointed at a project yet', async () => {
    const h = harness({ group: { ownerId: OWNER, projectId: null } });
    const result = await handleMessage(message(), h);

    expect(result).toEqual({ outcome: 'ignored', reason: 'unlinked-group' });
    expect(h.rawInserts).toEqual([]);
  });

  it('writes the raw message before calling the model', async () => {
    // The ordering is the whole recovery story: if extraction dies, the bill
    // is still on disk.
    const h = harness({ extractThrows: true });
    await handleMessage(message({ media: null }), h);

    expect(h.rawInserts).toEqual(['wamid.1']);
  });

  it('processes a message once, however many times it is delivered', async () => {
    const seen = new Set<string>();
    const h = harness({ seenMessageIds: seen });

    const first = await handleMessage(message(), h);
    const second = await handleMessage(message(), h);

    expect(first.outcome).toBe('saved');
    expect(second).toEqual({ outcome: 'ignored', reason: 'duplicate' });
    // Baileys re-delivers on reconnect. Without this, every disconnect would
    // double-count a day of expenses.
    expect(h.saved).toHaveLength(1);
  });

  it('keeps chatter as a raw message but writes no expense', async () => {
    const h = harness({ extraction: extraction({ isExpense: false }) });
    const result = await handleMessage(message({ text: 'coming to site at 4' }), h);

    expect(result.outcome).toBe('not-expense');
    expect(h.saved).toEqual([]);
    // Kept for 30 days, so a misclassified bill can be recovered.
    expect(h.rawInserts).toEqual(['wamid.1']);
  });

  it('saves a confident expense as confirmed, in paise', async () => {
    const h = harness();
    const result = await handleMessage(message(), h);

    expect(result).toMatchObject({ outcome: 'saved', status: 'confirmed' });
    expect(h.saved[0]?.amountMinor).toBe(4500_00n);
    expect(h.saved[0]?.ownerId).toBe(OWNER);
    expect(h.saved[0]?.projectId).toBe(PROJECT);
  });

  it('never takes the owner from the message, only from the group mapping', async () => {
    const h = harness();
    await handleMessage(message({ senderWaId: 'attacker@s.whatsapp.net' }), h);

    // The bot bypasses row-level security, so this is the only thing keeping
    // one customer's bills out of another's project.
    expect(h.saved[0]?.ownerId).toBe(OWNER);
  });

  it('holds a low-confidence extraction for review with a reason', async () => {
    const h = harness({ extraction: extraction({ confidence: 0.3 }) });
    const result = await handleMessage(message(), h);

    expect(result).toMatchObject({ outcome: 'saved', status: 'needs_review' });
    expect(h.saved[0]?.extractionNotes).toContain('confidence');
  });

  it('falls back to the message date when the bill shows none', async () => {
    const h = harness({ extraction: extraction({ date: null }) });
    await handleMessage(message(), h);

    expect(h.saved[0]?.spentOn).toBe('2026-09-20');
  });

  it('rejects a malformed date rather than storing it', async () => {
    const h = harness({ extraction: extraction({ date: 'last tuesday' }) });
    await handleMessage(message(), h);

    expect(h.saved[0]?.spentOn).toBe('2026-09-20');
  });

  it('flags a possible duplicate instead of dropping it', async () => {
    const h = harness({ similar: true });
    const result = await handleMessage(message(), h);

    // Buying the same cement twice in one day is ordinary. Discarding the
    // second silently would lose a real expense.
    expect(result).toMatchObject({ status: 'needs_review' });
    expect(h.saved[0]?.extractionNotes).toContain('duplicate');
    expect(h.saved).toHaveLength(1);
  });

  it('still saves the bill when the model fails', async () => {
    const h = harness({
      extractThrows: true,
      // A photo with no text: clearly a bill, unreadable by the model.
    });
    const result = await handleMessage(
      message({ text: null, media: { mimeType: 'image/jpeg', bytes: new Uint8Array([1, 2]), fileName: null } }),
      h,
    );

    expect(result).toMatchObject({ outcome: 'saved', status: 'needs_review' });
    expect(h.putPaths).toHaveLength(1);
  });

  it('stores the original under owner/project/expense', async () => {
    const h = harness();
    await handleMessage(
      message({ media: { mimeType: 'image/jpeg', bytes: new Uint8Array([1, 2, 3]), fileName: 'bill.jpg' } }),
      h,
    );

    expect(h.putPaths[0]).toBe(`${OWNER}/${PROJECT}/exp-1/original.jpg`);
    expect(h.savedFiles[0]?.sizeBytes).toBe(3);
  });

  it('keeps the expense when the bucket is unreachable', async () => {
    const h = harness({ filePutThrows: true });
    const result = await handleMessage(
      message({ media: { mimeType: 'image/jpeg', bytes: new Uint8Array([1]), fileName: null } }),
      h,
    );

    // An expense without its bill is recoverable. A bill with no row is
    // invisible to everyone.
    expect(result.outcome).toBe('saved');
    expect(h.saved).toHaveLength(1);
    expect(h.savedFiles).toEqual([]);
  });

  it('uses the configured threshold, not a hardcoded one', async () => {
    const h = harness({ extraction: extraction({ confidence: 0.8 }) });
    const result = await handleMessage(message(), h, { ...DEFAULT_CONFIG, confidenceThreshold: 0.9 });

    expect(result).toMatchObject({ status: 'needs_review' });
  });
});
