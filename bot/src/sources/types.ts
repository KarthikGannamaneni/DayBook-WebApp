/**
 * The seam between WhatsApp and everything else.
 *
 * P0 runs on Baileys, which is an unofficial reimplementation of WhatsApp Web
 * and violates WhatsApp's terms — the number can be banned without warning.
 * This interface exists so the transport can be replaced without touching the
 * pipeline. See docs/p0-tech-design.md §2.2 for why the official Groups API
 * cannot be used yet, and what swapping to it would actually cost.
 */

export interface IncomingMedia {
  mimeType: string;
  bytes: Uint8Array;
  fileName: string | null;
}

export interface IncomingMessage {
  waMessageId: string;
  waGroupId: string;
  senderWaId: string | null;
  senderName: string | null;
  text: string | null;
  sentAt: Date;
  media: IncomingMedia | null;
}

export type MessageHandler = (message: IncomingMessage) => Promise<void>;

export interface MessageSource {
  readonly name: string;
  start(onMessage: MessageHandler): Promise<void>;
  stop(): Promise<void>;
}
