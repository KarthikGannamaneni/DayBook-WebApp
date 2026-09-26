import {
  Browsers, fetchLatestBaileysVersion, makeWASocket, useMultiFileAuthState,
  type WASocket,
} from 'baileys';
import qrcode from 'qrcode-terminal';

/**
 * Opens a WhatsApp Web socket, shared by the listener and the group lister.
 *
 * Two things here exist because of a real failure, not for tidiness.
 *
 * **The version is fetched at runtime.** Baileys ships a hardcoded WhatsApp Web
 * version and announces it during the handshake. When that number goes stale
 * WhatsApp rejects the connection outright — a 405 during registration, before
 * any QR code appears, which reads like a network fault or a blocked number and
 * is neither. `fetchLatestBaileysVersion()` asks what the current version is, so
 * the failure stops being a function of how long ago the package was published.
 * It falls back to the built-in default if the lookup fails, because being
 * offline should not be fatal.
 *
 * **The QR code is rendered here.** `printQRInTerminal` is deprecated and is a
 * no-op in newer builds, so relying on it means pairing silently never prompts.
 */
export async function openSocket(authDir: string): Promise<{
  socket: WASocket;
  saveCreds: () => Promise<void>;
}> {
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  let version: [number, number, number] | undefined;
  try {
    const latest = await fetchLatestBaileysVersion();
    version = latest.version;
    if (!latest.isLatest) {
      console.warn('[wa] using WhatsApp Web version', version.join('.'), '(not marked latest)');
    }
  } catch (error) {
    console.warn('[wa] could not look up the current WhatsApp Web version, using the built-in default:',
      error instanceof Error ? error.message : error);
  }

  const socket = makeWASocket({
    auth: state,
    browser: Browsers.ubuntu('Chrome'),
    version,
  });

  socket.ev.on('connection.update', ({ qr }) => {
    if (!qr) return;
    console.log('\nScan this from WhatsApp → Settings → Linked devices → Link a device.\n');
    qrcode.generate(qr, { small: true });
    console.log('\nThe code refreshes every 20 seconds until you scan it.\n');
  });

  return { socket, saveCreds };
}
