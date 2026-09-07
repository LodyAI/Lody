import { z } from 'zod';
import type { PiStream } from '../agent-connection';

const envelope = z.object({ type: z.string() }).passthrough();
const response = z.object({
  type: z.literal('response'),
  id: z.string(),
  command: z.string(),
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});
const MAX_RECORD_CHARACTERS = 16 * 1024 * 1024;

/** Only LF delimits records; Unicode line separators belong to JSON strings. */
export class PiTransport {
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly pending = new Map<
    string,
    {
      command: string;
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  private sequence = 0;
  private failure?: Error;
  private events: Promise<void> = Promise.resolve();

  constructor(
    stream: PiStream,
    private readonly onEvent: (event: Record<string, unknown>) => Promise<void>,
    private readonly onFailure: (error: Error) => void
  ) {
    this.writer = stream.writable.getWriter();
    void this.read(stream.readable).catch((error: unknown) => this.fail(error));
  }

  async send(value: Record<string, unknown>): Promise<void> {
    if (this.failure) throw this.failure;
    try {
      await this.writer.write(new TextEncoder().encode(JSON.stringify(value) + '\n'));
    } catch (error) {
      this.fail(error);
      throw this.failure;
    }
  }

  request(command: string, fields: Record<string, unknown> = {}): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    const id = String(++this.sequence);
    const result = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { command, resolve, reject });
    });
    void this.send({ ...fields, id, type: command }).catch((error: unknown) => this.fail(error));
    return result;
  }

  async drain(): Promise<void> {
    await this.events;
    if (this.failure) throw this.failure;
  }

  private fail(error: unknown): void {
    if (this.failure) return;
    this.failure = error instanceof Error ? error : new Error('Pi RPC connection closed');
    for (const request of this.pending.values()) request.reject(this.failure);
    this.pending.clear();
    this.onFailure(this.failure);
  }

  private async read(readable: ReadableStream<Uint8Array>): Promise<void> {
    const reader = readable.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf('\n')) !== -1) {
          if (end > MAX_RECORD_CHARACTERS) throw new Error('Pi RPC record exceeds the size limit');
          const line = buffer.slice(0, end).replace(/\r$/, '');
          buffer = buffer.slice(end + 1);
          if (!line) continue;
          const event = envelope.parse(JSON.parse(line));
          if (event.type === 'response') {
            const reply = response.parse(event);
            const pending = this.pending.get(reply.id);
            if (!pending) continue;
            if (reply.command !== pending.command)
              throw new Error('Pi RPC response command mismatch');
            this.pending.delete(reply.id);
            if (reply.success) pending.resolve(reply.data);
            else pending.reject(new Error(reply.error ?? `Pi ${reply.command} failed`));
          } else {
            // Replies remain readable while a notification is being applied to history.
            this.events = this.events.then(() => this.onEvent(event));
            void this.events.catch((error: unknown) => this.fail(error));
          }
        }
        if (buffer.length > MAX_RECORD_CHARACTERS)
          throw new Error('Pi RPC record exceeds the size limit');
      }
      buffer += decoder.decode();
      // Reject pending requests before waiting on events: an event may itself await a reply.
      throw new Error(
        buffer.trim() ? 'Pi RPC disconnected with an incomplete record' : 'Pi RPC connection closed'
      );
    } finally {
      reader.releaseLock();
    }
  }
}
