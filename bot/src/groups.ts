import { DisconnectReason } from 'baileys';
import { openSocket } from './sources/socket.ts';

/**
 * Lists the WhatsApp groups this number is in, with their ids.
 *
 *   pnpm --filter bot groups
 *
 * The design says the owner links a group by picking it from a list the bot
 * produces, rather than by learning an in-group command — anyone in the group
 * could re-point the bot with a command, and the people posting documents are
 * not the people who installed it (docs §10). That list has to come from
 * somewhere, and hunting for an 18-digit jid by hand is not it.
 *
 * Read-only: it connects, reads the participating groups, prints them and exits.
 * It never sends a message and makes no database call — the linking happens in
 * the web app, under the owner's own session, because that is the only place
 * row-level security can scope the row to them.
 *
 * First run prints a QR code. Scanning it writes BAILEYS_AUTH_DIR, which IS a
 * credential: anyone who copies that directory reads every group this number is
 * in.
 *
 * Two connection failures are expected rather than exceptional, and neither is
 * an error worth stopping for:
 *
 *  - **515, immediately after a successful pairing.** WhatsApp requires the
 *    socket to be re-established once the device is registered; Baileys even
 *    logs "expect to restart the connection". Treating it as fatal made a
 *    successful pairing look like a failure.
 *  - **405 before any QR appears.** The announced client version was rejected.
 *    See sources/socket.ts, which looks the current one up at runtime.
 */

const authDir = process.env.BAILEYS_AUTH_DIR ?? './auth_state';
const MAX_ATTEMPTS = 4;

interface GroupRow {
  id: string;
  name: string;
  participants: number;
}

/** Resolves to the groups, or to 'restart' when WhatsApp wants a reconnect. */
async function attempt(): Promise<GroupRow[] | 'restart'> {
  const { socket, saveCreds } = await openSocket(authDir);
  socket.ev.on('creds.update', saveCreds);

  try {
    return await new Promise<GroupRow[] | 'restart'>((resolve, reject) => {
      socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
          const status = (lastDisconnect?.error as { output?: { statusCode?: number } })
            ?.output?.statusCode;
          if (status === DisconnectReason.restartRequired) {
            resolve('restart');
          } else if (status === DisconnectReason.loggedOut) {
            reject(new Error(`logged out — delete ${authDir} and pair again`));
          } else {
            reject(new Error(`connection closed (${status ?? 'unknown'})`));
          }
          return;
        }

        if (connection !== 'open') return;

        try {
          const groups = await socket.groupFetchAllParticipating();
          resolve(Object.values(groups)
            .map((g) => ({
              id: g.id,
              name: g.subject ?? '(no name)',
              participants: g.participants?.length ?? 0,
            }))
            .sort((a, b) => a.name.localeCompare(b.name)));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  } finally {
    socket.end(undefined);
  }
}

function print(rows: GroupRow[]): void {
  if (rows.length === 0) {
    console.log('\nThis number is not in any groups yet. Add it to one and run this again.\n');
    return;
  }

  const width = Math.max(...rows.map((r) => r.name.length));
  console.log(`\n${rows.length} group${rows.length === 1 ? '' : 's'}:\n`);
  for (const r of rows) {
    console.log(`  ${r.name.padEnd(width)}  ${r.id}  (${r.participants} members)`);
  }
  console.log('\nPaste the accounting group\'s id into Settings in the web app.');
  console.log('Any group not linked there is ignored entirely, and its messages');
  console.log('are never stored.\n');
}

async function main(): Promise<void> {
  for (let i = 1; i <= MAX_ATTEMPTS; i += 1) {
    const result = await attempt();
    if (result !== 'restart') {
      print(result);
      process.exit(0);
    }
    // The credentials were just written by the creds.update handler. Give that
    // write a moment before reconnecting with them.
    console.log('[groups] paired — reconnecting with the saved credentials…');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  throw new Error(`WhatsApp asked for a restart ${MAX_ATTEMPTS} times without settling`);
}

void main().catch((error) => {
  console.error('[groups]', error instanceof Error ? error.message : error);
  process.exit(1);
});
