import { DisconnectReason } from 'baileys';
import { openSocket } from './sources/socket.ts';

/**
 * Lists the WhatsApp groups this number is in, with their ids.
 *
 *   pnpm --filter bot groups
 *
 * The design says the owner links a group by picking it from a list the bot
 * produces, rather than by learning an in-group command — anyone in the group
 * could re-point the bot with a command, and the people posting bills are not
 * the people who installed it (docs §10). That list has to come from somewhere,
 * and hunting for an 18-digit jid by hand is not it.
 *
 * Read-only: it connects, reads the participating groups, prints them and
 * exits. It never sends a message, and it makes no database call — the linking
 * itself happens in the web app, under the owner's own session, because that is
 * the only place row-level security can scope the row to them.
 *
 * First run prints a QR code. Scanning it writes BAILEYS_AUTH_DIR, which IS a
 * credential: anyone who copies that directory reads every group this number is
 * in.
 *
 * A 405 on connect means the announced WhatsApp Web version was rejected; see
 * sources/socket.ts.
 */

const authDir = process.env.BAILEYS_AUTH_DIR ?? './auth_state';

async function main(): Promise<void> {
  const { socket, saveCreds } = await openSocket(authDir);
  socket.ev.on('creds.update', saveCreds);

  await new Promise<void>((resolve, reject) => {
    socket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'close') {
        const status = (lastDisconnect?.error as { output?: { statusCode?: number } })
          ?.output?.statusCode;
        reject(status === DisconnectReason.loggedOut
          ? new Error('logged out — delete the auth directory and pair again')
          : new Error(`connection closed (${status ?? 'unknown'})`));
        return;
      }

      if (connection !== 'open') return;

      try {
        const groups = await socket.groupFetchAllParticipating();
        const rows = Object.values(groups)
          .map((g) => ({
            id: g.id,
            name: g.subject ?? '(no name)',
            participants: g.participants?.length ?? 0,
          }))
          .sort((a, b) => a.name.localeCompare(b.name));

        if (rows.length === 0) {
          console.log('This number is not in any groups yet. Add it to one and run this again.');
        } else {
          console.log(`\n${rows.length} group${rows.length === 1 ? '' : 's'}:\n`);
          const width = Math.max(...rows.map((r) => r.name.length));
          for (const r of rows) {
            console.log(`  ${r.name.padEnd(width)}  ${r.id}  (${r.participants} members)`);
          }
          console.log('\nPaste the id of the accounting group into Settings in the web app.');
          console.log('Any group not linked there is ignored entirely, and its messages');
          console.log('are never stored.\n');
        }
        resolve();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });

  socket.end(undefined);
  process.exit(0);
}

void main().catch((error) => {
  console.error('[groups]', error instanceof Error ? error.message : error);
  process.exit(1);
});
