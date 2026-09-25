import { BaileysSource } from './sources/baileys.ts';
import { GeminiExtractor } from './extract/gemini.ts';
import { SupabaseStore } from './store/supabase.ts';
import { SupabaseFileStore } from './store/supabase-files.ts';
import { DEFAULT_CONFIG, handleMessage } from './pipeline.ts';

/**
 * Wiring, and nothing else. Every decision lives in pipeline.ts, which is
 * where the tests are.
 *
 * One concurrent extraction with a minimum spacing between calls. The free
 * Gemini tier allows 15 requests a minute and the steady state here is well
 * under one — but a supervisor uploading a day of bills at once arrives as a
 * burst, and this is the one place a queue earns its keep. It is an array,
 * not Redis.
 */

const MIN_CALL_SPACING_MS = 4_000;

async function main(): Promise<void> {
  const store = SupabaseStore.fromEnv();
  const files = SupabaseFileStore.fromEnv();

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is required');
  const extractor = new GeminiExtractor(apiKey, process.env.GEMINI_MODEL ?? 'gemini-2.5-flash');

  const config = {
    ...DEFAULT_CONFIG,
    confidenceThreshold: Number(process.env.CONFIDENCE_THRESHOLD ?? DEFAULT_CONFIG.confidenceThreshold),
  };

  let chain: Promise<unknown> = Promise.resolve();
  const source = new BaileysSource(process.env.BAILEYS_AUTH_DIR ?? './auth_state');

  await source.start((message) => {
    chain = chain
      .then(() => handleMessage(message, {
        store, files, extractor,
        log: (event, detail) => console.log(JSON.stringify({ event, ...detail })),
      }, config))
      .then(() => new Promise((resolve) => setTimeout(resolve, MIN_CALL_SPACING_MS)))
      .catch((error) => console.error('[pipeline]', error));
    return chain.then(() => undefined);
  });

  console.log('[bot] listening');
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => void source.stop().then(() => process.exit(0)));
  }
}

void main().catch((error) => {
  console.error('[bot] fatal', error);
  process.exit(1);
});
