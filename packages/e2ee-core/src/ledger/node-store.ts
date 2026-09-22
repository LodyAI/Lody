import { Either } from 'effect';
import * as journalCodec from '../pure/journal-codec';
import * as outboxCodec from '../pure/key-outbox-codec';
import { SqliteTextStore } from '../node-text-store';
import { copyBytes } from './cbor';
import type { LedgerKeyOutbox } from './delivery';
import { fail } from './error';
import type { LedgerJournal, LedgerStore, LedgerTransaction } from './submit';

export { createNodeSignatureVerifyExecutor } from './node-sig-pool';

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** Temporary throwing adapter; persisted encoding is owned by pure/. */
export function encodeLedgerJournal(journal: LedgerJournal): string {
  const result = journalCodec.encodeLedgerJournal(journal);
  if (Either.isLeft(result)) fail(result.left.code, result.left.position);
  return result.right;
}

export function decodeLedgerJournal(text: string): LedgerJournal {
  const result = journalCodec.decodeLedgerJournal(text);
  if (Either.isLeft(result)) fail(result.left.code, result.left.position);
  return result.right;
}

export class SqliteLedgerStore implements LedgerStore {
  private readonly database: SqliteTextStore;
  constructor(path: string, options?: { createFile: boolean; initializeSchema: boolean }) {
    this.database = new SqliteTextStore(path, 0x4c454c30, 0, options);
  }
  exclusive<T>(work: (transaction: LedgerTransaction) => Promise<T>): Promise<T> {
    return this.database.exclusive((tx) =>
      work({
        load: async () => {
          const text = await tx.load();
          return text === null ? null : decodeLedgerJournal(text);
        },
        save: async (journal) => tx.save(encodeLedgerJournal(journal)),
      })
    );
  }
}

function encodeKeyOutbox(frames: Map<string, Uint8Array>): string {
  const result = outboxCodec.encodeKeyOutbox(frames);
  if (Either.isLeft(result)) fail(result.left.code, result.left.position);
  return result.right;
}

function decodeKeyOutbox(text: string): Map<string, Uint8Array> {
  const result = outboxCodec.decodeKeyOutbox(text);
  if (Either.isLeft(result)) fail(result.left.code, result.left.position);
  return result.right;
}

/** Experimental exact-byte key outbox. Disk is not authority; retry never re-encrypts. */
export class SqliteLedgerKeyOutbox implements LedgerKeyOutbox {
  private readonly database: SqliteTextStore;
  constructor(path: string) {
    this.database = new SqliteTextStore(path, 0x4c454b30, 0);
  }
  exclusive<T>(
    work: (tx: {
      load(id: string): Promise<Uint8Array | null>;
      save(id: string, frame: Uint8Array): Promise<void>;
    }) => Promise<T>
  ): Promise<T> {
    return this.database.exclusive(async (tx) => {
      const text = await tx.load();
      const frames = text === null ? new Map<string, Uint8Array>() : decodeKeyOutbox(text);
      return work({
        load: async (id) => {
          if (!/^[0-9a-f]{32}$/.test(id)) fail('canonical');
          const saved = frames.get(id);
          return saved === undefined ? null : copyBytes(saved);
        },
        save: async (id, frame) => {
          if (!/^[0-9a-f]{32}$/.test(id)) fail('canonical');
          const bytes = copyBytes(frame);
          const existing = frames.get(id);
          if (existing && toHex(existing) !== toHex(bytes)) fail('replay');
          frames.set(id, bytes);
          await tx.save(encodeKeyOutbox(frames));
        },
      });
    });
  }
}
