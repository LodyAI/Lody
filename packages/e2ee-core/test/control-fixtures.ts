import { expect } from 'vitest';
import { CONTROL_STREAM_CONTENT_TYPE } from '../src/streams';
export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    result.set(p, offset);
    offset += p.length;
  }
  return result;
}
export function readResponse(
  body: Uint8Array,
  tail: string,
  upToDate = true,
  contentType = CONTROL_STREAM_CONTENT_TYPE
) {
  return new Response(new Uint8Array(body).buffer, {
    headers: {
      'Content-Type': contentType,
      'Stream-Next-Offset': tail,
      'Stream-Up-To-Date': String(upToDate),
    },
  });
}
export class HttpLedger {
  frames: { body: Uint8Array; nextOffset: string }[] = [];
  pageSize = 2;
  mismatchStatus: 409 | 412 = 412;
  mode: 'ok' | 'lost-response' | 'false-ack' | 'unsupported' = 'ok';
  get tail() {
    return this.frames.at(-1)?.nextOffset ?? 'empty:/+';
  }
  append(body: Uint8Array) {
    this.frames.push({ body: body.slice(), nextOffset: `opaque:${this.frames.length + 1}/+` });
  }
  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const target = new URL(request.url);
    if (request.method === 'POST') {
      // Any ordinary append (including a fallback) is a test failure.
      expect(target.pathname).toBe('/v1/buckets/synthetic/streams/org-control/append-cas');
      expect(request.headers.get('Content-Type')).toBe(CONTROL_STREAM_CONTENT_TYPE);
      expect(request.headers.get('Producer-Id')).toBeNull();
      if (this.mode === 'unsupported') return new Response('unsupported', { status: 501 });
      const expected = request.headers.get('Stream-Expected-Offset');
      if (expected !== this.tail)
        return new Response(null, {
          status: this.mismatchStatus,
          headers: {
            'Stream-Expected-Offset': expected!,
            'Stream-Next-Offset': this.tail,
            'Stream-CAS-Mismatch': 'true',
          },
        });
      if (this.mode !== 'false-ack') this.append(new Uint8Array(await request.arrayBuffer()));
      if (this.mode === 'lost-response') throw new Error('connection-lost-after-commit');
      return new Response(null, { status: 204, headers: { 'Stream-Next-Offset': this.tail } });
    }
    expect(request.method).toBe('GET');
    const offset = target.searchParams.get('offset');
    const index =
      offset === '-1' || offset === 'empty:/+'
        ? -1
        : this.frames.findIndex((p) => p.nextOffset === offset);
    if (index === -1 && offset !== '-1' && offset !== 'empty:/+')
      return new Response('gone', { status: 410 });
    const page = this.frames.slice(index + 1, index + 1 + this.pageSize);
    return readResponse(
      concat(page.map((p) => p.body)),
      page.at(-1)?.nextOffset ?? this.tail,
      index + 1 + page.length === this.frames.length
    );
  };
}
import type {
  ControlJournal,
  ControlStore,
  ControlStream,
  JournalTransaction,
  ControlReadPage,
} from '../src';

function fail(message: string): never {
  throw new Error(message);
}

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export class MemoryStore implements ControlStore {
  journal: ControlJournal | null = null;
  failSave: 'before' | 'after' | null = null;
  private queue: Promise<void> = Promise.resolve();
  async exclusive<T>(work: (tx: JournalTransaction) => Promise<T>): Promise<T> {
    const previous = this.queue;
    const release = deferred();
    this.queue = release.promise;
    await previous;
    try {
      return await work({
        load: async () => structuredClone(this.journal),
        save: async (journal) => {
          const failure = this.failSave;
          this.failSave = null;
          if (failure === 'before') fail('disk-failure');
          this.journal = structuredClone(journal);
          if (failure === 'after') fail('disk-failure');
        },
      });
    } finally {
      release.resolve();
    }
  }
}

export class MemoryStream implements ControlStream {
  readonly initialOffset = 'opaque-start';
  rows: { wire: string; nextOffset: string }[] = [];
  pageSize = 1;
  onAppend?: (offset: string, wire: string) => Promise<'accepted' | 'conflict' | 'unsupported'>;
  onRead?: (offset: string) => Promise<ControlReadPage>;
  get pages() {
    return this.rows.map(({ wire, nextOffset }) => ({ records: [wire], nextOffset }));
  }
  get tail(): string {
    return this.rows.at(-1)?.nextOffset ?? this.initialOffset;
  }
  append(offset: string, wire: string): 'accepted' | 'conflict' {
    if (offset !== this.tail) return 'conflict';
    this.rows.push({ wire, nextOffset: `cursor-${this.rows.length + 1}` });
    return 'accepted';
  }
  async appendCas(offset: string, wire: string) {
    return this.onAppend ? this.onAppend(offset, wire) : this.append(offset, wire);
  }
  async readAfter(offset: string) {
    if (this.onRead) return this.onRead(offset);
    const index =
      offset === this.initialOffset ? -1 : this.rows.findIndex((r) => r.nextOffset === offset);
    if (index === -1 && offset !== this.initialOffset) fail('missing-prefix');
    const page = this.rows.slice(index + 1, index + 1 + this.pageSize);
    return {
      records: page.map(({ wire }) => wire),
      nextOffset: page.at(-1)?.nextOffset ?? offset,
      upToDate: index + 1 + page.length === this.rows.length,
    };
  }
}
