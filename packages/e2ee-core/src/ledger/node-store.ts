import { SqliteTextStore } from '../node-text-store';
import { copyBytes } from './cbor';
import type { LedgerKeyOutbox } from './delivery';
import { fail } from './error';
import type { LedgerJournal, LedgerStore, LedgerTransaction } from './submit';

const FORMAT = 'lody-e2ee-journal/v0';
const SNAPSHOT_FORMAT = 'lody-e2ee-journal/v1';
const MAX_RECORDS = 16_384;
const MAX_BYTES = 32 * 1024 * 1024;

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

function fromHex(hex: unknown): Uint8Array {
  if (typeof hex !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(hex)) fail('canonical');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.byteLength; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Experimental local journal, not a frozen product format. Signed records stay DAG-CBOR;
 * this wrapper only stores exact bytes plus an opaque cursor. Disk is not authority. */
function checkOffset(offset: unknown): asserts offset is string {
  if (typeof offset !== 'string' || offset.length === 0 || offset.length > 1024) fail('canonical');
}

export function encodeLedgerJournal(journal: LedgerJournal): string {
  if (journal.records.length > MAX_RECORDS) fail('oversize');
  checkOffset(journal.offset);
  const snapshot = journal.snapshot;
  const trust = journal.snapshotTrust;
  const hasSnapshot = snapshot !== undefined || trust !== undefined;
  if (hasSnapshot !== Boolean(snapshot && trust)) fail('canonical');
  if (!hasSnapshot && journal.records.length === 0) fail('oversize');
  const records = journal.records.map((record) => toHex(copyBytes(record)));
  const pending = journal.pending === null ? null : toHex(copyBytes(journal.pending));
  const text = hasSnapshot
    ? JSON.stringify([
        SNAPSHOT_FORMAT,
        toHex(journal.genesis),
        records,
        pending,
        journal.offset,
        toHex(copyBytes(snapshot!)),
        [
          toHex(copyBytes(trust!.endorser)),
          toHex(copyBytes(trust!.head)),
          toHex(copyBytes(trust!.headSignature)),
        ],
      ])
    : JSON.stringify([FORMAT, toHex(journal.genesis), records, pending, journal.offset]);
  if (Buffer.byteLength(text) > MAX_BYTES) fail('oversize');
  return text;
}

export function decodeLedgerJournal(text: string): LedgerJournal {
  if (typeof text !== 'string' || text.length > MAX_BYTES) fail('oversize');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('canonical');
  }
  if (!Array.isArray(parsed)) fail('canonical');
  const format = parsed[0];
  if (format === FORMAT) {
    if (parsed.length !== 5) fail('canonical');
    const [, genesisHex, rows, pendingHex, offset] = parsed as unknown[];
    if (!Array.isArray(rows) || typeof offset !== 'string') fail('canonical');
    const journal: LedgerJournal = {
      genesis: fromHex(genesisHex),
      records: rows.map(fromHex),
      pending: pendingHex === null ? null : fromHex(pendingHex),
      offset,
    };
    if (encodeLedgerJournal(journal) !== text) fail('canonical');
    return journal;
  }
  if (format === SNAPSHOT_FORMAT) {
    if (parsed.length !== 7) fail('canonical');
    const [, genesisHex, rows, pendingHex, offset, snapshotHex, trustRow] = parsed as unknown[];
    if (!Array.isArray(rows) || typeof offset !== 'string' || !Array.isArray(trustRow)) {
      fail('canonical');
    }
    if (trustRow.length !== 3) fail('canonical');
    const genesis = fromHex(genesisHex);
    const journal: LedgerJournal = {
      genesis,
      records: rows.map(fromHex),
      pending: pendingHex === null ? null : fromHex(pendingHex),
      offset,
      snapshot: fromHex(snapshotHex),
      snapshotTrust: {
        genesis: copyBytes(genesis),
        endorser: fromHex(trustRow[0]),
        head: fromHex(trustRow[1]),
        headSignature: fromHex(trustRow[2]),
      },
    };
    if (encodeLedgerJournal(journal) !== text) fail('canonical');
    return journal;
  }
  return fail('unknown-version');
}

export class SqliteLedgerStore implements LedgerStore {
  private readonly database: SqliteTextStore;
  constructor(path: string) {
    this.database = new SqliteTextStore(path, 0x4c454c30, 0);
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

const OUTBOX_FORMAT = 'lody-e2ee-key-outbox/v0';
const MAX_OUTBOX_FRAMES = 4096;
const MAX_OUTBOX_FRAME_BYTES = 1024;

function encodeKeyOutbox(frames: Map<string, Uint8Array>): string {
  if (frames.size > MAX_OUTBOX_FRAMES) fail('oversize');
  const rows = [...frames.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [id, frame] of rows) {
    if (!/^[0-9a-f]{32}$/.test(id)) fail('canonical');
    if (frame.byteLength === 0 || frame.byteLength > MAX_OUTBOX_FRAME_BYTES) fail('oversize');
  }
  const text = JSON.stringify([
    OUTBOX_FORMAT,
    rows.map(([id, frame]) => [id, toHex(copyBytes(frame))]),
  ]);
  if (Buffer.byteLength(text) > MAX_BYTES) fail('oversize');
  return text;
}

function decodeKeyOutbox(text: string): Map<string, Uint8Array> {
  if (typeof text !== 'string' || text.length > MAX_BYTES) fail('oversize');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('canonical');
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) fail('canonical');
  const [format, rows] = parsed as unknown[];
  if (format !== OUTBOX_FORMAT) fail('unknown-version');
  if (!Array.isArray(rows)) fail('canonical');
  if (rows.length > MAX_OUTBOX_FRAMES) fail('oversize');
  const frames = new Map<string, Uint8Array>();
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string') fail('canonical');
    const id = row[0];
    if (!/^[0-9a-f]{32}$/.test(id) || frames.has(id)) fail('canonical');
    const frame = fromHex(row[1]);
    if (frame.byteLength === 0 || frame.byteLength > MAX_OUTBOX_FRAME_BYTES) fail('oversize');
    frames.set(id, frame);
  }
  if (encodeKeyOutbox(frames) !== text) fail('canonical');
  return frames;
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
