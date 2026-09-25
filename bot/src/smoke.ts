import { FakeSource } from './sources/fake.ts';
import { SupabaseStore } from './store/supabase.ts';
import { handleMessage } from './pipeline.ts';
import type { Extractor } from './extract/types.ts';
import type { FileStore } from './store/types.ts';

/**
 * Drives the real pipeline against the real local database with no WhatsApp
 * pairing, no Gemini key and no R2 bucket — so the wiring can be exercised
 * without a ban risk or a bill.
 *
 *   supabase start
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… pnpm --filter bot smoke
 *
 * It expects a linked group; create one in the web app's Settings first, or
 * pass SMOKE_GROUP_ID for a group you have already linked.
 */

const groupId = process.env.SMOKE_GROUP_ID ?? 'smoke-group@g.us';

const stubExtractor: Extractor = {
  extract: async (input) => ({
    isExpense: /\d/.test(input.text ?? '') || input.media !== null,
    confidence: 0.9,
    amountRupees: Number(/(\d+(?:\.\d+)?)/.exec(input.text ?? '')?.[1] ?? 0) || null,
    date: input.messageDate,
    vendor: 'Smoke vendor',
    description: input.text?.slice(0, 60) ?? 'Smoke bill',
    category: input.categories[0] ?? null,
    language: 'en',
    notes: null,
  }),
};

const memoryFiles: FileStore = {
  put: async (path) => console.log(JSON.stringify({ event: 'file-put', path })),
};

async function main(): Promise<void> {
  const store = SupabaseStore.fromEnv();
  const source = new FakeSource([
    {
      waMessageId: `smoke-${Date.now()}-1`,
      waGroupId: groupId,
      senderWaId: '919999900001@s.whatsapp.net',
      senderName: 'Smoke tester',
      text: 'cement 4500',
      sentAt: new Date(),
      media: null,
    },
    {
      waMessageId: `smoke-${Date.now()}-2`,
      waGroupId: groupId,
      senderWaId: '919999900001@s.whatsapp.net',
      senderName: 'Smoke tester',
      text: 'on my way to the site',
      sentAt: new Date(),
      media: null,
    },
  ]);

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
