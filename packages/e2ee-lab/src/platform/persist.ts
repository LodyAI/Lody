import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Flock } from '@loro-dev/flock-wasm';
import type { LoroDoc } from 'loro-crdt';
import type { RemoteCursor, RemoteCursorStore } from '@loro-dev/streams-crdt/loro';
import {
  MemoryLedgerStore,
  type LedgerJournal,
  type LedgerStore,
  type LedgerTransaction,
} from '@lody/e2ee-core/ledger';
import { fromHex, toHex } from './bytes';

export function loroDocPath(clientDir: string): string {
  return join(clientDir, 'loro.doc.bin');
}

export function loroCursorPath(clientDir: string): string {
  return join(clientDir, 'loro.cursor.json');
}

export function flockDocPath(clientDir: string): string {
  return join(clientDir, 'flock.doc.bin');
}

export function flockCursorPath(clientDir: string): string {
  return join(clientDir, 'flock.cursor.json');
}

export function persistLoroDocument(clientDir: string, doc: LoroDoc): void {
  mkdirSync(clientDir, { recursive: true, mode: 0o700 });
  writeFileSync(loroDocPath(clientDir), doc.export({ mode: 'snapshot' }));
}

export function loadLoroDocumentBytes(clientDir: string): Uint8Array | null {
  const path = loroDocPath(clientDir);
  if (!existsSync(path)) return null;
  return new Uint8Array(readFileSync(path));
}

export function persistFlockDocument(clientDir: string, flock: Flock): void {
  mkdirSync(clientDir, { recursive: true, mode: 0o700 });
  writeFileSync(flockDocPath(clientDir), flock.exportFile());
}

export function loadFlockDocument(clientDir: string, peerId: string): Flock | null {
  const path = flockDocPath(clientDir);
  if (!existsSync(path)) return null;
  return Flock.fromFile(new Uint8Array(readFileSync(path)), peerId);
}

function loadCursorFile(path: string, streamUrl: string): RemoteCursor | null {
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, 'utf8')) as RemoteCursor;
  if (raw.streamUrl !== streamUrl) return null;
  return raw;
}

/** Cursor files are invalid unless the matching document snapshot exists. */
export class FileRemoteCursorStore implements RemoteCursorStore {
  constructor(
    private readonly clientDir: string,
    private readonly kind: 'loro' | 'flock' = 'loro'
  ) {}

  private docPath(): string {
    return this.kind === 'flock' ? flockDocPath(this.clientDir) : loroDocPath(this.clientDir);
  }

  private cursorFile(): string {
    return this.kind === 'flock' ? flockCursorPath(this.clientDir) : loroCursorPath(this.clientDir);
  }

  async load(streamUrl: string): Promise<RemoteCursor | null> {
    if (!existsSync(this.docPath())) return null;
    return loadCursorFile(this.cursorFile(), streamUrl);
  }

  async save(cursor: RemoteCursor): Promise<void> {
    if (!existsSync(this.docPath())) {
      throw new Error('cursor-before-document');
    }
    mkdirSync(this.clientDir, { recursive: true, mode: 0o700 });
    writeFileSync(this.cursorFile(), JSON.stringify(cursor));
  }
}

export interface DemoKv {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const processStores = new Map<string, Map<string, string>>();

function mapKv(store: Map<string, string>): DemoKv {
  return {
    getItem(key) {
      return store.get(key) ?? null;
    },
    setItem(key, value) {
      store.set(key, value);
    },
  };
}

export function accountKv(account: string, explicit?: DemoKv): DemoKv {
  if (explicit) return explicit;
  const storage = (globalThis as { localStorage?: DemoKv }).localStorage;
  if (storage && typeof storage.getItem === 'function') {
    const prefix = `e2ee-demo:${account}:`;
    return {
      getItem(key) {
        return storage.getItem(prefix + key);
      },
      setItem(key, value) {
        storage.setItem(prefix + key, value);
      },
    };
  }
  let inner = processStores.get(account);
  if (!inner) {
    inner = new Map();
    processStores.set(account, inner);
  }
  return mapKv(inner);
}

export function encodeJournal(journal: LedgerJournal): string {
  return JSON.stringify({
    genesis: toHex(journal.genesis),
    records: journal.records.map((record) => toHex(record)),
    pending: journal.pending ? toHex(journal.pending) : null,
    offset: journal.offset,
  });
}

export function decodeJournal(raw: string): LedgerJournal {
  const fields = JSON.parse(raw) as {
    genesis: string;
    records: string[];
    pending: string | null;
    offset: string;
  };
  return {
    genesis: fromHex(fields.genesis),
    records: fields.records.map((row) => fromHex(row)),
    pending: fields.pending ? fromHex(fields.pending) : null,
    offset: fields.offset,
  };
}

export class PersistingLedgerStore implements LedgerStore {
  readonly inner = new MemoryLedgerStore();

  constructor(private readonly kv: DemoKv) {
    const raw = kv.getItem('journal');
    if (raw) this.inner.journal = decodeJournal(raw);
  }

  private persist(journal: LedgerJournal): void {
    this.kv.setItem('journal', encodeJournal(journal));
  }

  async exclusive<T>(work: (transaction: LedgerTransaction) => Promise<T>): Promise<T> {
    return this.inner.exclusive(async (tx) =>
      work({
        load: () => tx.load(),
        save: async (journal) => {
          this.persist(journal);
          await tx.save(journal);
        },
      })
    );
  }
}
