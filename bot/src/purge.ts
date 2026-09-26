import { createClient } from '@supabase/supabase-js';
import { DOCUMENTS_BUCKET } from './store/supabase-files.ts';

/**
 * Deletes stored originals past their retention date, and expired raw messages.
 *
 *   pnpm --filter bot purge          # delete
 *   pnpm --filter bot purge --dry-run  # say what would go
 *
 * Retention was a promise with no mechanism: `raw_messages.purge_after` existed
 * and nothing called the function that honours it, and document images had no
 * retention at all. These are photographs of other people's payments — names,
 * UPI handles, transaction references — and the business is the data fiduciary
 * for them.
 *
 * This lives in the bot rather than in Postgres because deleting a stored object
 * needs the Storage API, which SQL cannot reach. The database decides WHAT is
 * expired (`v_purgeable_files`); this decides nothing and only carries it out.
 *
 * The structured record deliberately outlives the image. `mark_files_purged`
 * keeps the row and stamps `purged_at`, so the app can say "the original was
 * deleted on 3 March" rather than showing a broken image and letting the owner
 * conclude the system lost their bill.
 *
 * Schedule it daily — launchd, cron, or a systemd timer beside the bot.
 */

interface PurgeableFile {
  id: string;
  owner_id: string;
  storage_path: string;
  thumbnail_path: string | null;
}

const dryRun = process.argv.includes('--dry-run');

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  const db = createClient(url, key, { auth: { persistSession: false } });

  const { data, error } = await db
    .from('v_purgeable_files')
    .select('id, owner_id, storage_path, thumbnail_path');
  if (error) throw new Error(`listing expired files: ${error.message}`);

  const files = (data ?? []) as PurgeableFile[];
  console.log(JSON.stringify({ event: 'purge-start', files: files.length, dryRun }));

  let removed = 0;
  // In batches, so one unreachable object cannot strand the rest.
  for (let i = 0; i < files.length; i += 50) {
    const batch = files.slice(i, i + 50);
    const paths = batch.flatMap((f) =>
      f.thumbnail_path ? [f.storage_path, f.thumbnail_path] : [f.storage_path],
    );

    if (dryRun) {
      for (const p of paths) console.log(JSON.stringify({ event: 'would-delete', path: p }));
      continue;
    }

    const { error: storageError } = await db.storage.from(DOCUMENTS_BUCKET).remove(paths);
    if (storageError) {
      // Marking a file purged whose object still exists would lose track of it
      // forever, so a failed delete leaves the batch for the next run.
      console.error(JSON.stringify({ event: 'purge-failed', error: storageError.message, count: paths.length }));
      continue;
    }

    const { data: marked, error: markError } = await db.rpc('mark_files_purged', {
      p_ids: batch.map((f) => f.id),
    });
    if (markError) throw new Error(`marking purged: ${markError.message}`);
    removed += typeof marked === 'number' ? marked : 0;
  }

  let messages = 0;
  if (!dryRun) {
    const { data: purged, error: rawError } = await db.rpc('purge_expired_raw_messages');
    if (rawError) throw new Error(`purging raw messages: ${rawError.message}`);
    messages = typeof purged === 'number' ? purged : 0;
  }

  console.log(JSON.stringify({ event: 'purge-done', images: removed, rawMessages: messages, dryRun }));
}

void main().catch((error) => {
  console.error('[purge]', error instanceof Error ? error.message : error);
  process.exit(1);
});
