import { BaileysSource } from './sources/baileys.ts';
import { GeminiExtractor } from './extract/gemini.ts';
import { SupabaseStore } from './store/supabase.ts';
import { SupabaseFileStore } from './store/supabase-files.ts';
import { sharpThumbnailer } from './thumbnail.ts';
import { DEFAULT_CONFIG, handleMessage } from './pipeline.ts';
import { acquireLock } from './lock.ts';

/**
 * Wiring, and nothing else. Every decision lives in pipeline.ts, which is where
 * the tests are.
 *
 * One concurrent extraction with a minimum spacing between calls. The free
 * Gemini tier allows 15 requests a minute and the steady state here is well
 * under one — but a week of documents arrives as one burst when somebody
 * catches up on a Sunday, and this is the one place a queue earns its keep. It
 * is an array, not Redis.
 */

const MIN_CALL_SPACING_MS = 4_000;

async function main(): Promise<void> {
  const authDir = process.env.BAILEYS_AUTH_DIR ?? './auth_state';
  // Before anything else: refuse to be the second bot on one session.
  acquireLock(authDir);

  const store = SupabaseStore.fromEnv();
  const files = SupabaseFileStore.fromEnv();

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is required');
  const extractor = new GeminiExtractor(apiKey, process.env.GEMINI_MODEL ?? 'gemini-3.8-flash');

  const config = {
    ...DEFAULT_CONFIG,
    maxRupees: Number(process.env.MAX_RUPEES ?? DEFAULT_CONFIG.maxRupees),
  };

  let chain: Promise<unknown> = Promise.resolve();
  // Testing only: see the BaileysSource constructor. Paired to your own number,
  // every message you post is `fromMe` and is otherwise dropped in silence.
  const includeOwn = process.env.INCLUDE_OWN_MESSAGES === '1';
  if (includeOwn) {
    console.warn('[bot] INCLUDE_OWN_MESSAGES=1 — processing messages sent by this account. Testing only.');
  }
  const source = new BaileysSource(authDir, includeOwn);

  await source.start((message) => {
    chain = chain
      .then(() => handleMessage(message, {
        store, files, extractor,
        thumbnail: sharpThumbnailer,
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

// Baileys throws from its own async paths — a retry request racing a closing
// socket, for example — and an unhandled rejection would otherwise take the whole
// bot down over something it recovers from. Log it and keep listening; a session
// that is genuinely dead surfaces through connection.update instead.
process.on('unhandledRejection', (reason) => {
  console.error('[bot] unhandled rejection (continuing)', reason instanceof Error ? reason.message : reason);
});

void main().catch((error) => {
  console.error('[bot] fatal', error instanceof Error ? error.message : error);
  process.exit(1);
});
