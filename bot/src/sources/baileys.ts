import {
  Browsers, DisconnectReason, downloadMediaMessage,
  makeWASocket, useMultiFileAuthState, type WASocket,
} from 'baileys';
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
export class BaileysSource implements MessageSource {
  readonly name = 'baileys';
  private socket: WASocket | null = null;
  private stopped = false;

  constructor(private readonly authDir = './auth_state') {}

  async start(onMessage: MessageHandler): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const socket = makeWASocket({ auth: state, browser: Browsers.ubuntu('Chrome'), printQRInTerminal: true });
    this.socket = socket;

    socket.ev.on('creds.update', saveCreds);

    socket.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === 'close') {
        const status = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;

        // Logged out is terminal: the session is dead and no amount of
        // retrying revives it. Crash-looping here would hide the one failure
        // that actually needs a human.
        if (status === DisconnectReason.loggedOut) {
          console.error('[baileys] logged out — re-pair with a QR code. Not retrying.');
          return;
        }
        if (!this.stopped) {
          console.warn('[baileys] connection closed, reconnecting');
          void this.start(onMessage);
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
    // Groups only, and never the bot's own messages.
    if (!remoteJid?.endsWith('@g.us') || key?.fromMe) return null;
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
