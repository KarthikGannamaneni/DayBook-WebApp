import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, handleMessage, readability, toPaise } from '../src/pipeline.ts';
import type { IncomingMessage } from '../src/sources/types.ts';
import type { Extraction } from '../src/extract/types.ts';
import type {
  FileOwner, SaveFileInput, SaveInvoiceInput, SavePaymentInput, Store,
} from '../src/store/types.ts';

const OWNER = 'owner-1';

function message(over: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    waMessageId: 'wamid.1',
    waGroupId: 'group-1@g.us',
    senderWaId: '919999900001@s.whatsapp.net',
    senderName: 'Ravi',
    text: 'invoice 45000',
    sentAt: new Date('2026-09-20T10:00:00Z'),
    media: null,
    ...over,
  };
}

function invoice(over: Partial<Extraction> = {}): Extraction {
  return {
    docKind: 'invoice',
    confidence: 0.95,
    invoice: {
      customerName: 'Ravi Kumar',
      amountRupees: 45000,
      invoiceNo: 'INV-001',
      issuedOn: '2026-09-18',
      dueOn: null,
      description: 'Kukatpally job',
    },
    payment: null,
    language: 'en',
    notes: null,
    ...over,
  };
}

function payment(over: Partial<Extraction> = {}): Extraction {
  return {
    docKind: 'payment',
    confidence: 0.95,
    invoice: null,
    payment: {
      payerName: 'Ravi Kumar',
      amountRupees: 45000,
      paidOn: '2026-09-20',
      utr: '500000000001',
      payerVpa: 'ravi@okaxis',
      payeeVpa: 'business@okhdfcbank',
      app: 'GPay',
      txnStatus: 'completed',
      note: null,
    },
    language: 'en',
    notes: null,
    ...over,
  };
}

interface Harness {
  store: Store;
  files: { put: (p: string, b: Uint8Array, m: string) => Promise<void> };
  extractor: { extract: () => Promise<Extraction> };
  invoices: SaveInvoiceInput[];
  payments: SavePaymentInput[];
  savedFiles: SaveFileInput[];
  rawInserts: string[];
  marks: Array<{ id: string; docKind: string; needsClassification?: boolean }>;
  putPaths: string[];
  proposeCalls: Array<{ side: string; id: string }>;
}

function harness(options: {
  group?: { ownerId: string } | null;
  extraction?: Extraction;
  extractThrows?: boolean;
  seenMessageIds?: Set<string>;
  existingDocument?: boolean;
  filePutThrows?: boolean;
  proposeThrows?: boolean;
  proposed?: number;
  thumbnail?: boolean;
} = {}): Harness {
  const invoices: SaveInvoiceInput[] = [];
  const payments: SavePaymentInput[] = [];
  const savedFiles: SaveFileInput[] = [];
  const rawInserts: string[] = [];
  const putPaths: string[] = [];
  const marks: Array<{ id: string; docKind: string; needsClassification?: boolean }> = [];
  const proposeCalls: Array<{ side: string; id: string }> = [];
  const seen = options.seenMessageIds ?? new Set<string>();

  const store: Store = {
    findGroup: async () =>
      options.group === undefined ? { ownerId: OWNER } : options.group,
    saveRawMessage: async (input) => {
      if (seen.has(input.waMessageId)) return null;
      seen.add(input.waMessageId);
      rawInserts.push(input.waMessageId);
      return { id: `raw-${input.waMessageId}` };
    },
    markRawMessage: async (id, fields) => {
      marks.push({ id, ...fields });
    },
    saveInvoice: async (input) => {
      invoices.push(input);
      return { id: `inv-${invoices.length}`, existing: options.existingDocument === true };
    },
    savePayment: async (input) => {
      payments.push(input);
      return { id: `pay-${payments.length}`, existing: options.existingDocument === true };
    },
    saveFile: async (input) => {
      savedFiles.push(input);
    },
    proposeMatches: async (side, id) => {
      proposeCalls.push({ side, id });
      if (options.proposeThrows) throw new Error('matcher unavailable');
      return options.proposed ?? 1;
    },
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
        return options.extraction ?? invoice();
      },
    },
    invoices, payments, savedFiles, rawInserts, marks, putPaths, proposeCalls,
  };
}

const IMAGE = { mimeType: 'image/jpeg', bytes: new Uint8Array([1, 2, 3]), fileName: 'bill.jpg' };

describe('toPaise', () => {
  it('converts rupees to integer paise', () => {
    expect(toPaise(45000)).toBe(4500000n);
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
    // transaction in this product. A human should look at it.
    expect(toPaise(50_000_000)).toBeNull();
  });
});

describe('readability', () => {
  it('passes a complete invoice', () => {
    expect(readability(invoice(), 4500000n)).toEqual([]);
  });

  it('holds a document whose amount could not be read', () => {
    expect(readability(invoice(), null)).toContain('no amount could be read');
  });

  it('holds an invoice with no customer, because there is nothing to match on', () => {
    expect(readability(invoice({ invoice: { ...invoice().invoice!, customerName: null } }), 4500000n))
      .toContain('no customer name');
  });

  it('holds a payment the app did not report as completed', () => {
    const pending = payment({ payment: { ...payment().payment!, txnStatus: 'pending' } });
    // A screenshot of a failed transfer is a screenshot of money that did not
    // arrive. This is the field a ledger gets wrong by ignoring.
    expect(readability(pending, 4500000n).join(' ')).toContain('pending');
  });

  it('says nothing about confidence, which is a different question', () => {
    // Extraction confidence and match confidence are deliberately separate:
    // a perfectly legible screenshot can still be a confidently wrong pairing.
    expect(readability(invoice({ confidence: 0.1 }), 4500000n)).toEqual([]);
  });
});

describe('handleMessage', () => {
  it('ignores a group nobody has claimed, and stores nothing', async () => {
    const h = harness({ group: null });
    const result = await handleMessage(message(), h);

    expect(result).toEqual({ outcome: 'ignored', reason: 'unknown-group' });
    // The bot may sit in groups that are not customers'. It must not keep their
    // messages.
    expect(h.rawInserts).toEqual([]);
  });

  it('writes the raw message before calling the model', async () => {
    // The ordering is the whole recovery story: if extraction dies, the
    // document is still on disk.
    const h = harness({ extractThrows: true });
    await handleMessage(message({ media: null }), h);

    expect(h.rawInserts).toEqual(['wamid.1']);
  });

  it('processes a message once, however many times it is delivered', async () => {
    const h = harness({ seenMessageIds: new Set<string>() });

    const first = await handleMessage(message(), h);
    const second = await handleMessage(message(), h);

    expect(first.outcome).toBe('saved');
    expect(second).toEqual({ outcome: 'ignored', reason: 'duplicate-message' });
    // Baileys re-delivers on reconnect. Without this, every disconnect would
    // duplicate a day of receivables.
    expect(h.invoices).toHaveLength(1);
  });

  it('keeps chatter as a raw message but writes no document', async () => {
    const h = harness({ extraction: { ...invoice(), docKind: 'neither', invoice: null } });
    const result = await handleMessage(message({ text: 'coming to site at 4' }), h);

    expect(result.outcome).toBe('not-document');
    expect(h.invoices).toEqual([]);
    expect(h.payments).toEqual([]);
    // Kept for 30 days, so a misclassified document can be recovered.
    expect(h.rawInserts).toEqual(['wamid.1']);
  });

  it('treats a payment request as chatter, not as money', async () => {
    // "Please pay 5000" is the single most common thing in these groups that
    // looks like a payment and is not one.
    const h = harness({ extraction: { ...payment(), docKind: 'neither', payment: null } });
    const result = await handleMessage(message({ text: 'please pay 5000' }), h);

    expect(result.outcome).toBe('not-document');
    expect(h.payments).toEqual([]);
  });

  it('saves an invoice in paise, against the owner from the group mapping', async () => {
    const h = harness();
    const result = await handleMessage(message(), h);

    expect(result).toMatchObject({ outcome: 'saved', kind: 'invoice' });
    expect(h.invoices[0]?.amountMinor).toBe(4500000n);
    expect(h.invoices[0]?.ownerId).toBe(OWNER);
    expect(h.invoices[0]?.invoiceNo).toBe('INV-001');
  });

  it('saves a payment with its reference and status', async () => {
    const h = harness({ extraction: payment() });
    const result = await handleMessage(message(), h);

    expect(result).toMatchObject({ outcome: 'saved', kind: 'payment' });
    expect(h.payments[0]?.utr).toBe('500000000001');
    expect(h.payments[0]?.txnStatus).toBe('completed');
    // Captured so it can be checked: a screenshot of a payment to somebody
    // else's handle is not a receipt for this business.
    expect(h.payments[0]?.payeeVpa).toBe('business@okhdfcbank');
  });

  it('never takes the owner from the message, only from the group mapping', async () => {
    const h = harness();
    await handleMessage(message({ senderWaId: 'attacker@s.whatsapp.net' }), h);

    // The bot bypasses row-level security, so this is the only thing keeping one
    // customer's books out of another's.
    expect(h.invoices[0]?.ownerId).toBe(OWNER);
  });

  it('falls back to the message date when the document shows none', async () => {
    const h = harness({ extraction: invoice({ invoice: { ...invoice().invoice!, issuedOn: null } }) });
    await handleMessage(message(), h);

    expect(h.invoices[0]?.issuedOn).toBe('2026-09-20');
  });

  it('rejects a malformed date rather than storing it', async () => {
    const h = harness({ extraction: invoice({ invoice: { ...invoice().invoice!, issuedOn: 'last tuesday' } }) });
    await handleMessage(message(), h);

    expect(h.invoices[0]?.issuedOn).toBe('2026-09-20');
  });

  it('asks the database to match a saved document, on its own side', async () => {
    const h = harness({ extraction: payment(), proposed: 1 });
    const result = await handleMessage(message(), h);

    // The matcher searches the OPPOSITE side; the side passed in is the side of
    // the document that just arrived, which is how order-independence works
    // without a pending-pool table.
    expect(h.proposeCalls).toEqual([{ side: 'payment', id: 'pay-1' }]);
    expect(result).toMatchObject({ proposed: 1 });
  });

  it('never offers an unreadable document to the matcher', async () => {
    const h = harness({ extraction: invoice({ invoice: { ...invoice().invoice!, amountRupees: null } }) });
    const result = await handleMessage(message(), h);

    // An amount that could not be read cannot be compared to a balance, so
    // asking would only waste a query and risk a nonsense pairing.
    expect(h.proposeCalls).toEqual([]);
    expect(result).toMatchObject({ outcome: 'saved', proposed: 0 });
    expect((result as { attention: string[] }).attention).toContain('no amount could be read');
  });

  it('never offers a failed payment to the matcher', async () => {
    const h = harness({ extraction: payment({ payment: { ...payment().payment!, txnStatus: 'failed' } }) });
    await handleMessage(message(), h);

    expect(h.payments).toHaveLength(1);
    expect(h.proposeCalls).toEqual([]);
  });

  it('keeps the document when the matcher is unavailable', async () => {
    const h = harness({ proposeThrows: true });
    const result = await handleMessage(message(), h);

    // Matching is derivable and re-runnable. A document is not.
    expect(result).toMatchObject({ outcome: 'saved', proposed: 0 });
    expect(h.invoices).toHaveLength(1);
  });

  it('stops at a re-sent invoice instead of creating a second receivable', async () => {
    const h = harness({ existingDocument: true });
    const result = await handleMessage(message({ media: IMAGE }), h);

    expect(result).toEqual({ outcome: 'duplicate-document', kind: 'invoice', documentId: 'inv-1' });
    // No second copy of the image, and no second attempt to match it.
    expect(h.putPaths).toEqual([]);
    expect(h.proposeCalls).toEqual([]);
  });

  it('stores the original under owner/kind/document', async () => {
    const h = harness();
    await handleMessage(message({ media: IMAGE }), h);

    expect(h.putPaths[0]).toBe(`${OWNER}/invoice/inv-1/original.jpg`);
    expect(h.savedFiles[0]?.sizeBytes).toBe(3);
    expect(h.savedFiles[0]?.attachTo).toEqual({ kind: 'invoice', id: 'inv-1' });
  });

  it('stores a thumbnail beside the original when it can make one', async () => {
    const h = harness();
    const result = await handleMessage(message({ media: IMAGE }), {
      ...h,
      thumbnail: async () => new Uint8Array([9]),
    });

    expect(result.outcome).toBe('saved');
    expect(h.putPaths).toEqual([
      `${OWNER}/invoice/inv-1/original.jpg`,
      `${OWNER}/invoice/inv-1/thumb.webp`,
    ]);
    expect(h.savedFiles[0]?.thumbnailPath).toBe(`${OWNER}/invoice/inv-1/thumb.webp`);
  });

  it('keeps the original when the thumbnail cannot be made', async () => {
    const h = harness();
    await handleMessage(message({ media: IMAGE }), {
      ...h,
      thumbnail: async () => { throw new Error('sharp missing'); },
    });

    // A missing thumbnail costs bandwidth. Nothing else.
    expect(h.putPaths).toEqual([`${OWNER}/invoice/inv-1/original.jpg`]);
    expect(h.savedFiles[0]?.thumbnailPath).toBeNull();
  });

  it('keeps the document when the bucket is unreachable', async () => {
    const h = harness({ filePutThrows: true });
    const result = await handleMessage(message({ media: IMAGE }), h);

    // A document without its image is recoverable. An image with no row is
    // invisible to everyone.
    expect(result.outcome).toBe('saved');
    expect(h.invoices).toHaveLength(1);
    expect(h.savedFiles).toEqual([]);
  });

  it('parks an unreadable image for the owner to classify rather than guessing', async () => {
    const h = harness({ extractThrows: true });
    const result = await handleMessage(message({ text: null, media: IMAGE }), h);

    // We know a document arrived; we do not know which side of the ledger it
    // belongs to. Filing a receipt as a receivable would be worse than asking.
    expect(result).toEqual({ outcome: 'unclassified', rawMessageId: 'raw-wamid.1' });
    expect(h.marks.at(-1)).toMatchObject({ needsClassification: true });
    expect(h.invoices).toEqual([]);
    expect(h.payments).toEqual([]);
  });

  it('keeps the unreadable image itself, attached to the message', async () => {
    const h = harness({ extractThrows: true });
    await handleMessage(message({ text: null, media: IMAGE }), h);

    expect(h.putPaths[0]).toBe(`${OWNER}/unclassified/raw-wamid.1/original.jpg`);
    const attachTo = h.savedFiles[0]?.attachTo as FileOwner;
    expect(attachTo).toEqual({ kind: 'raw_message', id: 'raw-wamid.1' });
  });

  it('writes nothing extra when extraction fails on a message with no image', async () => {
    const h = harness({ extractThrows: true });
    const result = await handleMessage(message({ text: 'something odd', media: null }), h);

    // The body is already stored. Inventing a document from text we could not
    // parse would put a row in the ledger that nothing supports.
    expect(result).toEqual({ outcome: 'not-document', rawMessageId: 'raw-wamid.1' });
    expect(h.putPaths).toEqual([]);
  });

  it('parks a document whose claimed kind came back empty', async () => {
    const h = harness({ extraction: { ...invoice(), invoice: null } });
    const result = await handleMessage(message({ media: IMAGE }), h);

    expect(result).toEqual({ outcome: 'unclassified', rawMessageId: 'raw-wamid.1' });
    expect(h.invoices).toEqual([]);
  });

  it('uses the configured ceiling, not a hardcoded one', async () => {
    const h = harness();
    await handleMessage(message(), h, { ...DEFAULT_CONFIG, maxRupees: 1000 });

    expect(h.invoices[0]?.amountMinor).toBeNull();
  });
});
