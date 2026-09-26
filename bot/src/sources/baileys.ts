import { DisconnectReason, downloadMediaMessage, type WASocket } from 'baileys';
import { openSocket } from './socket.ts';
import type { IncomingMessage, MessageHandler, MessageSource } from './types.ts';

/**
 * WhatsApp via Baileys.
 *
 * Baileys is an unofficial reimplementation of WhatsApp Web. Using it breaks
 * WhatsApp's terms and the number can be banned without warning or appeal.
 * Use a dedicated SIM that is nobody's personal number, keep the volume
 * human-paced, and treat the session as something you will have to
 * re-establish rather than as infrastructure. docs/p0-tech-design.md §2.2.
 *
 * The auth state on disk IS a credential: anyone who copies it reads every
 * group this number is in.
 */
/** 1s, 2s, 4s … capped. A conflict retried instantly is a reconnect storm. */
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
/** Consecutive `replaced` conflicts before concluding somebody else owns it. */
const MAX_CONFLICTS = 3;

function isReplaced(error: unknown): boolean {
  // Baileys surfaces the stream error's content on the Boom error's message.
  return /replaced|conflict/i.test(String((error as Error | undefined)?.message ?? ''));
}

export class BaileysSource implements MessageSource {
  readonly name = 'baileys';
  private socket: WASocket | null = null;
  private stopped = false;
  private attempts = 0;
  private conflicts = 0;
  private reconnecting = false;

  /**
   * @param includeOwnMessages Process messages sent BY the paired account.
   *
   * Off by default, and that is the right default: in production the bot runs on
   * a dedicated number that never posts documents, so `fromMe` means only the
   * bot's own traffic and processing it would be a loop.
   *
   * It exists because during testing the bot is often paired to the tester's own
   * number, and then every message they can easily produce is `fromMe` and
   * vanishes silently — no log line, no row, nothing to debug. Turn it on with
   * INCLUDE_OWN_MESSAGES=1 while testing; leave it off for a real customer.
   */
  constructor(
    private readonly authDir = './auth_state',
    private readonly includeOwnMessages = false,
  ) {}

  async start(onMessage: MessageHandler): Promise<void> {
    const { socket, saveCreds } = await openSocket(this.authDir);
    this.socket = socket;

    socket.ev.on('creds.update', saveCreds);

    socket.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === 'open') {
        // A connection that actually opened resets the penalty.
        this.attempts = 0;
        this.conflicts = 0;
      }

      if (connection === 'close') {
        const status = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
        const replaced = isReplaced(lastDisconnect?.error);

        if (replaced) {
          this.conflicts += 1;
          if (this.conflicts >= MAX_CONFLICTS) {
            console.error(
              `[baileys] this session was taken over ${this.conflicts} times in a row.\n` +
              '  Something else is using it — another copy of the bot, or WhatsApp Web\n' +
              '  in a browser. Reconnecting again would just continue the fight, so\n' +
              '  stopping. Close the other client and start again.',
            );
            this.stopped = true;
            return;
          }
        }

        // Logged out is terminal: the session is dead and no amount of
        // retrying revives it. Crash-looping here would hide the one failure
        // that actually needs a human.
        if (status === DisconnectReason.loggedOut) {
          console.error('[baileys] logged out — re-pair with a QR code. Not retrying.');
          return;
        }
        if (!this.stopped && !this.reconnecting) {
          this.reconnecting = true;
          const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** this.attempts);
          // Jitter, so two clients that collide do not keep colliding in step.
          const wait = Math.round(delay * (0.5 + Math.random()));
          this.attempts += 1;
          console.warn(`[baileys] connection closed (${status ?? 'unknown'}), reconnecting in ${wait}ms`);
          setTimeout(() => {
            this.reconnecting = false;
            if (!this.stopped) void this.start(onMessage).catch((error) => {
              console.error('[baileys] reconnect failed', error);
            });
          }, wait);
        }
      }
    });

    socket.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const raw of messages) {
        try {
          const parsed = await this.toIncoming(raw);
          if (parsed) await onMessage(parsed);
        } catch (error) {
          // One bad message must never take the listener down.
          console.error('[baileys] message failed', error);
        }
      }
    });
  }

  private async toIncoming(raw: Parameters<typeof downloadMediaMessage>[0]): Promise<IncomingMessage | null> {
    const key = raw.key;
    const remoteJid = key?.remoteJid;
    // Groups only.
    if (!remoteJid?.endsWith('@g.us')) return null;
    // And normally not the paired account's own messages — see the constructor.
    if (key?.fromMe && !this.includeOwnMessages) return null;
    if (!key?.id) return null;

    const content = raw.message;
    if (!content) return null;

    const text =
      content.conversation ??
      content.extendedTextMessage?.text ??
      content.imageMessage?.caption ??
      content.documentMessage?.caption ??
      null;

    const image = content.imageMessage;
    const document = content.documentMessage;
    let media: IncomingMessage['media'] = null;

    if (image || (document && document.mimetype === 'application/pdf')) {
      const bytes = (await downloadMediaMessage(raw, 'buffer', {})) as Buffer;
      media = {
        mimeType: image ? (image.mimetype ?? 'image/jpeg') : 'application/pdf',
        bytes: new Uint8Array(bytes),
        fileName: document?.fileName ?? null,
      };
    }

    if (!text && !media) return null;

    return {
      waMessageId: key.id,
      waGroupId: remoteJid,
      senderWaId: key.participant ?? null,
      senderName: raw.pushName ?? null,
      text,
      sentAt: raw.messageTimestamp
        ? new Date(Number(raw.messageTimestamp) * 1000)
        : new Date(),
      media,
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.socket?.end(undefined);
  }
}
