import { Flock } from '@loro-dev/flock-wasm';
import type { LoroDoc } from 'loro-crdt';
import type { RemoteCursor, RemoteCursorStore } from '@loro-dev/streams-crdt/loro';
import {
  MemoryLedgerStore,
  type LedgerJournal,
  type LedgerStore,
  type LedgerTransaction,
} from '@lody/e2ee-core/ledger';
import { join } from 'node:path';
import { fromHex, toHex } from './bytes';
import { makeLiveFs, type LabFsShape } from '../services/fs';

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

function fsOf(fs?: LabFsShape): LabFsShape {
  return fs ?? makeLiveFs();
}

export function persistLoroDocument(clientDir: string, doc: LoroDoc, fs?: LabFsShape): void {
  const disk = fsOf(fs);
  disk.mkdir(clientDir);
  disk.writeBytes(loroDocPath(clientDir), doc.export({ mode: 'snapshot' }));
}

export function loadLoroDocumentBytes(clientDir: string, fs?: LabFsShape): Uint8Array | null {
  const disk = fsOf(fs);
  const path = loroDocPath(clientDir);
  if (!disk.exists(path)) return null;
  return new Uint8Array(disk.readBytes(path));
}

export function persistFlockDocument(clientDir: string, flock: Flock, fs?: LabFsShape): void {
  const disk = fsOf(fs);
  disk.mkdir(clientDir);
  disk.writeBytes(flockDocPath(clientDir), flock.exportFile());
}

export function loadFlockDocument(
  clientDir: string,
  peerId: string,
  fs?: LabFsShape
): Flock | null {
  const disk = fsOf(fs);
  const path = flockDocPath(clientDir);
  if (!disk.exists(path)) return null;
  return Flock.fromFile(new Uint8Array(disk.readBytes(path)), peerId);
}

function loadCursorFile(path: string, streamUrl: string, disk: LabFsShape): RemoteCursor | null {
  if (!disk.exists(path)) return null;
  const raw = JSON.parse(disk.readText(path)) as RemoteCursor;
  if (raw.streamUrl !== streamUrl) return null;
  return raw;
}

/** Cursor files are invalid unless the matching document snapshot exists. */
export class FileRemoteCursorStore implements RemoteCursorStore {
  private readonly disk: LabFsShape;

  constructor(
    private readonly clientDir: string,
    private readonly kind: 'loro' | 'flock' = 'loro',
    fs?: LabFsShape
  ) {
    this.disk = fsOf(fs);
  }

  private docPath(): string {
    return this.kind === 'flock' ? flockDocPath(this.clientDir) : loroDocPath(this.clientDir);
  }

  private cursorFile(): string {
    return this.kind === 'flock' ? flockCursorPath(this.clientDir) : loroCursorPath(this.clientDir);
  }

  async load(streamUrl: string): Promise<RemoteCursor | null> {
    if (!this.disk.exists(this.docPath())) return null;
    return loadCursorFile(this.cursorFile(), streamUrl, this.disk);
  }

  async save(cursor: RemoteCursor): Promise<void> {
    if (!this.disk.exists(this.docPath())) {
      throw new Error('cursor-before-document');
    }
    this.disk.mkdir(this.clientDir);
    this.disk.writeText(this.cursorFile(), JSON.stringify(cursor));
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
