import { FakeSource } from './sources/fake.ts';
import { SupabaseStore } from './store/supabase.ts';
import { handleMessage } from './pipeline.ts';
import type { Extraction, ExtractionInput } from './extract/types.ts';
import type { FileStore } from './store/types.ts';

/**
 * Drives the real pipeline against the real local database with no WhatsApp
 * pairing, no Gemini key and no bucket — so the wiring, the matcher and the
 * review queue can be exercised without a ban risk or a bill.
 *
 *   supabase start
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… pnpm --filter bot smoke
 *
 * It expects a linked group. Create one in the web app's Settings first, or
 * pass SMOKE_GROUP_ID for a group you have already linked.
 *
 * The three messages are chosen to produce one of each outcome: an invoice, a
 * payment that should match it exactly, and a line of chatter that should be
 * kept but produce nothing. If the run ends with one proposal in the review
 * queue, the whole path works.
 */

const groupId = process.env.SMOKE_GROUP_ID ?? 'smoke-group@g.us';
const today = new Date();
const day = (offset: number): string =>
  new Date(today.getTime() + offset * 86_400_000).toISOString().slice(0, 10);

/** A stand-in for Gemini that reads the canned messages below and nothing else. */
const stubExtractor = {
  extract: async (input: ExtractionInput): Promise<Extraction> => {
    const text = input.text ?? '';
    if (/invoice/i.test(text)) {
      return {
        docKind: 'invoice',
        confidence: 0.95,
        invoice: {
          customerName: 'Ravi Kumar',
          amountRupees: 45000,
          invoiceNo: `SMOKE-${Date.now()}`,
          issuedOn: day(-3),
          dueOn: null,
          description: 'Smoke invoice',
        },
        payment: null,
        language: 'en',
        notes: null,
      };
    }
    if (/paid|upi|payment/i.test(text)) {
      return {
        docKind: 'payment',
        confidence: 0.95,
        invoice: null,
        payment: {
          payerName: 'Ravi Kumar',
          amountRupees: 45000,
          paidOn: day(-1),
          utr: `${Date.now()}`.slice(-12),
          payerVpa: 'ravi@okaxis',
          payeeVpa: 'business@okhdfcbank',
          app: 'GPay',
          txnStatus: 'completed',
          note: null,
        },
        language: 'en',
        notes: null,
      };
    }
    return {
      docKind: 'neither', confidence: 0, invoice: null, payment: null,
      language: 'en', notes: null,
    };
  },
};

const memoryFiles: FileStore = {
  put: async (path) => console.log(JSON.stringify({ event: 'file-put', path })),
};

async function main(): Promise<void> {
  const store = SupabaseStore.fromEnv();
  const stamp = Date.now();
  const source = new FakeSource([
    { text: 'Invoice for the Kukatpally job, 45000', offset: -3 },
    { text: 'Payment received, UPI 45000', offset: -1 },
    { text: 'coming to the site at 4', offset: 0 },
  ].map((m, i) => ({
    waMessageId: `smoke-${stamp}-${i}`,
    waGroupId: groupId,
    senderWaId: '919999900001@s.whatsapp.net',
    senderName: 'Smoke tester',
    text: m.text,
    sentAt: new Date(today.getTime() + m.offset * 86_400_000),
    media: null,
  })));

  await source.start(async (message) => {
    const result = await handleMessage(message, {
      store,
      files: memoryFiles,
      extractor: stubExtractor,
      log: (event, detail) => console.log(JSON.stringify({ event, ...detail })),
    });
    console.log(JSON.stringify({ result }));
  });
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
