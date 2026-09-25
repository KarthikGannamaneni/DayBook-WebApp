import type { IncomingMessage, MessageHandler, MessageSource } from './types.ts';

/**
 * A source that replays messages from an array, so the pipeline can be driven
 * end to end against a real database with no WhatsApp pairing and no ban risk.
 * This is what `pnpm --filter bot smoke` uses.
 */
export class FakeSource implements MessageSource {
  readonly name = 'fake';
  constructor(private readonly messages: IncomingMessage[]) {}

  async start(onMessage: MessageHandler): Promise<void> {
    for (const message of this.messages) await onMessage(message);
  }

  async stop(): Promise<void> {}
}
