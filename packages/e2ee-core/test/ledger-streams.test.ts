import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamsClient } from '@loro-dev/streams-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControlFreshnessLease } from '@lody/e2ee-core';
import {
  LedgerClient,
  MAX_LEDGER_READ_PAGE_RECORDS,
  MAX_RECORD_BYTES,
  MemoryLedgerStore,
} from '@lody/e2ee-core/ledger';
import {
  CONTROL_STREAM_CONTENT_TYPE,
  createBoundedStreamsFetch,
  frameLedgerRecord,
  StreamsLedgerStream,
} from '@lody/e2ee-core/streams';
import { listenDurableCas } from '../bench/ds-cas-server';
import { buildChain } from '../bench/chain';
import { admitDeviceOp, append, ed25519, signGenesis } from './ledger-fixtures';

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const url = 'https://streams.example.test/v1/buckets/synthetic/streams/org-control';

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function readResponse(body: Uint8Array, tail: string, upToDate = true) {
  return new Response(new Uint8Array(body).buffer, {
    headers: {
      'Content-Type': CONTROL_STREAM_CONTENT_TYPE,
      'Stream-Next-Offset': tail,
      'Stream-Up-To-Date': String(upToDate),
    },
  });
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Controlled Streams HTTP peer. Ordinary /append is a test failure. */
class HttpPeer {
  frames: { body: Uint8Array; nextOffset: string }[] = [];
  pageSize = 2;
  mode: 'ok' | 'lost-response' | 'false-ack' | 'unsupported' = 'ok';
  posts: string[] = [];
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
      this.posts.push(target.pathname);
      expect(target.pathname).toBe('/v1/buckets/synthetic/streams/org-control/append-cas');
      expect(request.headers.get('Content-Type')).toBe(CONTROL_STREAM_CONTENT_TYPE);
      if (this.mode === 'unsupported') return new Response('unsupported', { status: 501 });
      const expected = request.headers.get('Stream-Expected-Offset');
      if (expected !== this.tail) {
        return new Response(null, {
          status: 412,
          headers: {
            'Stream-Expected-Offset': expected!,
            'Stream-Next-Offset': this.tail,
            'Stream-CAS-Mismatch': 'true',
          },
        });
      }
      if (this.mode !== 'false-ack') this.append(new Uint8Array(await request.arrayBuffer()));
      if (this.mode === 'lost-response') throw new Error('connection-lost-after-commit');
      return new Response(null, { status: 204, headers: { 'Stream-Next-Offset': this.tail } });
    }
    expect(request.method).toBe('GET');
    const offset = target.searchParams.get('offset');
    const index =
      offset === '-1' || offset === 'empty:/+'
        ? -1
        : this.frames.findIndex((page) => page.nextOffset === offset);
    if (index === -1 && offset !== '-1' && offset !== 'empty:/+') {
      return new Response('gone', { status: 410 });
    }
    const page = this.frames.slice(index + 1, index + 1 + this.pageSize);
    return readResponse(
      concat(page.map((row) => row.body)),
      page.at(-1)?.nextOffset ?? this.tail,
      index + 1 + page.length === this.frames.length
    );
  };
}

function stream(fetch: typeof globalThis.fetch) {
  return new StreamsLedgerStream(new StreamsClient({ url, fetch, retry: { maxAttempts: 0 } }));
}

/** Real TCP HTTP peer. CAS is serialized; ordinary /append is 405. */
class TcpCasPeer {
  frames: { body: Uint8Array; nextOffset: string }[] = [];
  posts: string[] = [];
  pageSize = 64;
  mode: 'ok' | 'lost-response' | 'false-ack' = 'ok';
  private queue: Promise<void> = Promise.resolve();
  get tail() {
    return this.frames.at(-1)?.nextOffset ?? 'empty:/+';
  }
  exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
  append(body: Uint8Array) {
    this.frames.push({ body: body.slice(), nextOffset: `opaque:${this.frames.length + 1}/+` });
  }
}

async function listenTcp(peer: TcpCasPeer): Promise<{ server: Server; url: string }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const target = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (
        req.method === 'POST' &&
        target.pathname.endsWith('/append') &&
        !target.pathname.endsWith('/append-cas')
      ) {
        res.writeHead(405).end();
        return;
      }
      if (req.method === 'HEAD') {
        res
          .writeHead(200, {
            'Content-Type': CONTROL_STREAM_CONTENT_TYPE,
            'Stream-Next-Offset': peer.tail,
            'Stream-Extensions': 'append-cas',
          })
          .end();
        return;
      }
      if (req.method === 'POST' && target.pathname.endsWith('/append-cas')) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = new Uint8Array(Buffer.concat(chunks));
        await peer.exclusive(async () => {
          peer.posts.push(target.pathname);
          const expected = req.headers['stream-expected-offset'];
          if (expected !== peer.tail) {
            res
              .writeHead(412, {
                'Stream-Expected-Offset': String(expected ?? ''),
                'Stream-Next-Offset': peer.tail,
                'Stream-CAS-Mismatch': 'true',
              })
              .end();
            return;
          }
          if (peer.mode !== 'false-ack') peer.append(body);
          if (peer.mode === 'lost-response') {
            req.socket.destroy();
            return;
          }
          res.writeHead(204, { 'Stream-Next-Offset': peer.tail }).end();
        });
        return;
      }
      if (req.method === 'GET') {
        const offset = target.searchParams.get('offset') ?? '-1';
        const index =
          offset === '-1' || offset === 'empty:/+'
            ? -1
            : peer.frames.findIndex((page) => page.nextOffset === offset);
        if (index === -1 && offset !== '-1' && offset !== 'empty:/+') {
          res.writeHead(410).end('gone');
          return;
        }
        const page = peer.frames.slice(index + 1, index + 1 + peer.pageSize);
        const body = concat(page.map((row) => row.body));
        res
          .writeHead(200, {
            'Content-Type': CONTROL_STREAM_CONTENT_TYPE,
            'Stream-Next-Offset': page.at(-1)?.nextOffset ?? peer.tail,
            'Stream-Up-To-Date': String(index + 1 + page.length >= peer.frames.length),
          })
          .end(Buffer.from(body));
        return;
      }
      res.writeHead(404).end();
    })().catch(() => {
      if (!res.headersSent) res.destroy();
    });
  });
  server.on('clientError', (error, socket) => {
    void error;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${address.port}/v1/buckets/synthetic/streams/org-control`,
  };
}

describe('L7 Streams CAS peer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('commits through the real SDK and reads back exact DAG-CBOR bytes', async () => {
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const phone = await ed25519();
    const record = (
      await append(
        created.ledger,
        owner,
        await admitDeviceOp(created.anchor, created.membershipId, phone, 'personal')
      )
    ).record;
    const backend = new HttpPeer();
    const client = await LedgerClient.open(
      created.record,
      new MemoryLedgerStore(),
      stream(backend.fetch)
    );
    expect((await client.submit(record)).status).toBe('committed');
    expect(backend.frames).toHaveLength(1);
    expect(backend.posts.every((path) => path.endsWith('/append-cas'))).toBe(true);
    const view = await LedgerClient.open(
      created.record,
      new MemoryLedgerStore(),
      stream(backend.fetch)
    ).then((other) => other.read());
    expect(view.length).toBe(2);
    expect(view.head).toEqual((await client.read()).head);
  });

  it('pages through opaque offsets without ordinary append', async () => {
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const records = [created.record];
    let ledger = created.ledger;
    for (let i = 0; i < 3; i++) {
      const next = await append(
        ledger,
        owner,
        await admitDeviceOp(created.anchor, created.membershipId, await ed25519(), 'personal')
      );
      records.push(next.record);
      ledger = next.ledger;
    }
    const backend = new HttpPeer();
    backend.pageSize = 1;
    const leader = await LedgerClient.open(
      created.record,
      new MemoryLedgerStore(),
      stream(backend.fetch)
    );
    for (const record of records.slice(1)) {
      expect((await leader.submit(record)).status).toBe('committed');
    }
    expect(backend.frames.map((frame) => frame.nextOffset)).toEqual([
      'opaque:1/+',
      'opaque:2/+',
      'opaque:3/+',
    ]);
    const followerStore = new MemoryLedgerStore();
    const follower = await LedgerClient.open(created.record, followerStore, stream(backend.fetch));
    const view = await follower.read();
    expect(view.length).toBe(4);
    expect(view.head).toEqual((await leader.read()).head);
    expect(followerStore.journal?.offset).toBe('opaque:3/+');
    expect(backend.posts.some((path) => path.endsWith('/append'))).toBe(false);
  });

  it('joins split frames, maps CAS conflict, 410, and 501 without ordinary append', async () => {
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const firstStep = await append(
      created.ledger,
      owner,
      await admitDeviceOp(created.anchor, created.membershipId, await ed25519(), 'personal')
    );
    const secondStep = await append(
      firstStep.ledger,
      owner,
      await admitDeviceOp(created.anchor, created.membershipId, await ed25519(), 'personal')
    );
    const first = firstStep.record;
    const second = secondStep.record;
    const a = frameLedgerRecord(first);
    const b = frameLedgerRecord(second);
    const chunks = [a.slice(0, 3), concat([a.slice(3), b.slice(0, 5)]), b.slice(5)];
    const cursors = ['-1', 'split/a:+', 'split/b:+', 'complete/c:+'];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      expect(request.method).toBe('GET');
      expect(request.headers.get('Producer-Id')).toBeNull();
      const i = cursors.indexOf(new URL(request.url).searchParams.get('offset')!);
      if (i === 3) return readResponse(new Uint8Array(), cursors[3]!);
      expect(i).toBeGreaterThanOrEqual(0);
      return readResponse(chunks[i]!, cursors[i + 1]!, i === 2);
    };
    const store = new MemoryLedgerStore();
    const view = await new LedgerClient(
      created.record,
      created.anchor,
      store,
      stream(fetch)
    ).read();
    expect(view.length).toBe(3);
    expect(store.journal?.offset).toBe(cursors[3]);
    expect(store.journal?.records).toHaveLength(3);

    const backend = new HttpPeer();
    backend.append(frameLedgerRecord(first));
    const sdk = stream(backend.fetch);
    expect(await sdk.appendCas('-1', second)).toBe('conflict');
    expect(backend.frames).toHaveLength(1);

    const gone: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      expect(request.method).toBe('GET');
      return new Response('gone', { status: 410 });
    };
    await expect(stream(gone).readAfter('-1')).rejects.toThrow(/gone|stream-read/);

    backend.mode = 'unsupported';
    expect(await sdk.appendCas(backend.tail, second)).toBe('unsupported');
    expect(backend.posts.every((path) => path.endsWith('/append-cas'))).toBe(true);
  });

  it('does not persist a later bad page after a verified prefix', async () => {
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const firstStep = await append(
      created.ledger,
      owner,
      await admitDeviceOp(created.anchor, created.membershipId, await ed25519(), 'personal')
    );
    const goodStep = await append(
      firstStep.ledger,
      owner,
      await admitDeviceOp(created.anchor, created.membershipId, await ed25519(), 'personal')
    );
    const first = firstStep.record;
    const good = goodStep.record;
    const bad = new Uint8Array(good);
    const last = bad.byteLength - 1;
    bad[last] = (bad[last] ?? 0) ^ 0xff;
    const backend = new HttpPeer();
    backend.pageSize = 1;
    backend.append(frameLedgerRecord(first));
    const store = new MemoryLedgerStore();
    const client = new LedgerClient(created.record, created.anchor, store, stream(backend.fetch));
    expect((await client.read()).length).toBe(2);
    const checkpoint = store.journal;
    backend.pageSize = 2;
    backend.append(frameLedgerRecord(good));
    backend.append(frameLedgerRecord(bad));
    await expect(client.read()).rejects.toBeTruthy();
    expect(store.journal?.records).toHaveLength(checkpoint?.records.length ?? 0);
    expect(store.journal?.offset).toBe(checkpoint?.offset);
  });

  it('treats an SDK lost ACK as committed after read-back of the exact frame', async () => {
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const record = (
      await append(
        created.ledger,
        owner,
        await admitDeviceOp(created.anchor, created.membershipId, await ed25519(), 'personal')
      )
    ).record;
    const backend = new HttpPeer();
    backend.mode = 'lost-response';
    const store = new MemoryLedgerStore();
    const client = await LedgerClient.open(created.record, store, stream(backend.fetch));
    expect((await client.submit(record)).status).toBe('committed');
    expect(backend.frames).toHaveLength(1);
    expect(store.journal?.pending).toBeNull();
  });

  it('keeps exact pending bytes after a false ACK and resumes the same frame', async () => {
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const record = (
      await append(
        created.ledger,
        owner,
        await admitDeviceOp(created.anchor, created.membershipId, await ed25519(), 'personal')
      )
    ).record;
    const backend = new HttpPeer();
    backend.mode = 'false-ack';
    const store = new MemoryLedgerStore();
    const client = await LedgerClient.open(created.record, store, stream(backend.fetch));
    const first = await client.submit(record);
    expect(first.status).toBe('unknown');
    expect(backend.frames).toHaveLength(0);
    expect(store.journal?.pending).toEqual(record);
    const saved = new Uint8Array(store.journal!.pending!);
    record.fill(0);
    backend.mode = 'ok';
    const resumed = await client.resume();
    expect(resumed.status).toBe('committed');
    expect(backend.frames).toHaveLength(1);
    expect(store.journal?.pending).toBeNull();
    expect(backend.frames[0]!.body.subarray(4)).toEqual(saved);
  });

  it('lets only one of two SDK clients win a same-parent CAS race', async () => {
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const first = (
      await append(
        created.ledger,
        owner,
        await admitDeviceOp(created.anchor, created.membershipId, await ed25519(), 'personal')
      )
    ).record;
    const second = (
      await append(
        created.ledger,
        owner,
        await admitDeviceOp(created.anchor, created.membershipId, await ed25519(), 'personal')
      )
    ).record;
    const backend = new HttpPeer();
    const leader = await LedgerClient.open(
      created.record,
      new MemoryLedgerStore(),
      stream(backend.fetch)
    );
    const follower = await LedgerClient.open(
      created.record,
      new MemoryLedgerStore(),
      stream(backend.fetch)
    );
    expect((await leader.submit(first)).status).toBe('committed');
    expect((await follower.submit(second)).status).toBe('conflict');
    const view = await follower.read();
    expect(view.length).toBe(2);
    expect(view.head).toEqual((await leader.read()).head);
    expect(backend.posts.every((path) => path.endsWith('/append-cas'))).toBe(true);
  });

  it('syncs 1025 signed records from one StreamsClient HTTP page', async () => {
    const count = MAX_LEDGER_READ_PAGE_RECORDS + 1;
    const built = await buildChain(count + 1);
    const peer = new HttpPeer();
    peer.pageSize = count;
    for (const record of built.records.slice(1)) peer.append(frameLedgerRecord(record));
    const client = await LedgerClient.open(
      built.records[0]!,
      new MemoryLedgerStore(),
      stream(peer.fetch)
    );
    const view = await client.read();
    expect(view.length).toBe(count + 1);
    expect(view.head).toEqual(built.ledger.head);
  }, 120_000);

  function tcpSdk(streamUrl: string) {
    return new StreamsLedgerStream(
      new StreamsClient({
        url: streamUrl,
        fetch: globalThis.fetch.bind(globalThis),
        retry: { maxAttempts: 0 },
      })
    );
  }

  it('races two SDK clients through a real TCP HTTP CAS peer', async () => {
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const first = (
      await append(
        created.ledger,
        owner,
        await admitDeviceOp(created.anchor, created.membershipId, await ed25519(), 'personal')
      )
    ).record;
    const second = (
      await append(
        created.ledger,
        owner,
        await admitDeviceOp(created.anchor, created.membershipId, await ed25519(), 'personal')
      )
    ).record;
    const peer = new TcpCasPeer();
    const { server, url: streamUrl } = await listenTcp(peer);
    try {
      const leader = await LedgerClient.open(
        created.record,
        new MemoryLedgerStore(),
        tcpSdk(streamUrl)
      );
      const follower = await LedgerClient.open(
        created.record,
        new MemoryLedgerStore(),
        tcpSdk(streamUrl)
      );
      const [a, b] = await Promise.all([leader.submit(first), follower.submit(second)]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual(['committed', 'conflict']);
      const winner = a.status === 'committed' ? leader : follower;
      const loser = a.status === 'committed' ? follower : leader;
      const view = await loser.read();
      expect(view.length).toBe(2);
      expect(view.head).toEqual((await winner.read()).head);
      expect(peer.frames).toHaveLength(1);
      expect(peer.posts.every((path) => path.endsWith('/append-cas'))).toBe(true);
      expect(
        peer.posts.some((path) => path.endsWith('/append') && !path.endsWith('/append-cas'))
      ).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('races two SDK clients through official /ds append-cas on a local Durable Streams server', async () => {
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const first = (
      await append(
        created.ledger,
        owner,
        await admitDeviceOp(created.anchor, created.membershipId, await ed25519(), 'personal')
      )
    ).record;
    const second = (
      await append(
        created.ledger,
        owner,
        await admitDeviceOp(created.anchor, created.membershipId, await ed25519(), 'personal')
      )
    ).record;
    const { server, streamUrl } = await listenDurableCas();
    const casUrl = streamUrl('e2eetest', 'org-control');
    try {
      const put = await fetch(casUrl, {
        method: 'PUT',
        headers: { 'Content-Type': CONTROL_STREAM_CONTENT_TYPE },
      });
      expect(put.status).toBe(201);
      const head = await fetch(casUrl, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(head.headers.get('Stream-Extensions')).toContain('append-cas');
      const leader = await LedgerClient.open(
        created.record,
        new MemoryLedgerStore(),
        tcpSdk(casUrl)
      );
      const follower = await LedgerClient.open(
        created.record,
        new MemoryLedgerStore(),
        tcpSdk(casUrl)
      );
      const [a, b] = await Promise.all([leader.submit(first), follower.submit(second)]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual(['committed', 'conflict']);
      const winner = a.status === 'committed' ? leader : follower;
      const loser = a.status === 'committed' ? follower : leader;
      const view = await loser.read();
      expect(view.length).toBe(2);
      expect(view.head).toEqual((await winner.read()).head);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('treats a TCP lost ACK as committed after reading the exact committed frame', async () => {
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const record = (
      await append(
        created.ledger,
        owner,
        await admitDeviceOp(created.anchor, created.membershipId, await ed25519(), 'personal')
      )
    ).record;
    const peer = new TcpCasPeer();
    peer.mode = 'lost-response';
    const { server, url: streamUrl } = await listenTcp(peer);
    try {
      const store = new MemoryLedgerStore();
      const client = await LedgerClient.open(created.record, store, tcpSdk(streamUrl));
      expect((await client.submit(record)).status).toBe('committed');
      expect(peer.frames).toHaveLength(1);
      expect(store.journal?.pending).toBeNull();
      expect(peer.posts.every((path) => path.endsWith('/append-cas'))).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('keeps exact pending bytes after a TCP false ACK and resumes the same frame', async () => {
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const record = (
      await append(
        created.ledger,
        owner,
        await admitDeviceOp(created.anchor, created.membershipId, await ed25519(), 'personal')
      )
    ).record;
    const peer = new TcpCasPeer();
    peer.mode = 'false-ack';
    const { server, url: streamUrl } = await listenTcp(peer);
    try {
      const store = new MemoryLedgerStore();
      const client = await LedgerClient.open(created.record, store, tcpSdk(streamUrl));
      const first = await client.submit(record);
      expect(first.status).toBe('unknown');
      expect(peer.frames).toHaveLength(0);
      expect(store.journal?.pending).toEqual(record);
      const saved = new Uint8Array(store.journal!.pending!);
      record.fill(0);
      peer.mode = 'ok';
      const resumed = await client.resume();
      expect(resumed.status).toBe('committed');
      expect(peer.frames).toHaveLength(1);
      expect(peer.frames[0]!.body.subarray(4)).toEqual(saved);
      expect(store.journal?.pending).toBeNull();
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('pages opaque TCP offsets through the real SDK without ordinary append', async () => {
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const records = [created.record];
    let ledger = created.ledger;
    for (let i = 0; i < 3; i++) {
      const next = await append(
        ledger,
        owner,
        await admitDeviceOp(created.anchor, created.membershipId, await ed25519(), 'personal')
      );
      records.push(next.record);
      ledger = next.ledger;
    }
    const peer = new TcpCasPeer();
    peer.pageSize = 1;
    const { server, url: streamUrl } = await listenTcp(peer);
    try {
      const leader = await LedgerClient.open(
        created.record,
        new MemoryLedgerStore(),
        tcpSdk(streamUrl)
      );
      for (const record of records.slice(1)) {
        expect((await leader.submit(record)).status).toBe('committed');
      }
      expect(peer.frames.map((frame) => frame.nextOffset)).toEqual([
        'opaque:1/+',
        'opaque:2/+',
        'opaque:3/+',
      ]);
      const followerStore = new MemoryLedgerStore();
      const follower = await LedgerClient.open(created.record, followerStore, tcpSdk(streamUrl));
      const view = await follower.read();
      expect(view.length).toBe(4);
      expect(view.head).toEqual((await leader.read()).head);
      expect(followerStore.journal?.offset).toBe('opaque:3/+');
      expect(
        peer.posts.some((path) => path.endsWith('/append') && !path.endsWith('/append-cas'))
      ).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('pins an injected-clock freshness lease to the observed Streams checkpoint', async () => {
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const record = (
      await append(
        created.ledger,
        owner,
        await admitDeviceOp(created.anchor, created.membershipId, await ed25519(), 'personal')
      )
    ).record;
    const backend = new HttpPeer();
    const client = await LedgerClient.open(
      created.record,
      new MemoryLedgerStore(),
      stream(backend.fetch)
    );
    expect((await client.submit(record)).status).toBe('committed');
    const view = await client.read();
    const genesis = hex(created.anchor);
    const head = hex(view.head);
    let now = 1_000;
    const observation = {
      genesis,
      head,
      length: view.length,
      observedAt: 1_000,
      expiresAt: 1_000 + 15 * 60 * 1000,
    };
    const lease = new ControlFreshnessLease(genesis, observation, () => now);
    lease.assert({ head, length: view.length });
    now = 900_000;
    lease.assert({ head, length: view.length });
    const restarted = new ControlFreshnessLease(genesis, observation, () => now);
    restarted.assert({ head, length: view.length });
    now = observation.expiresAt;
    expect(() => lease.assert({ head, length: view.length })).toThrow('freshness-expired');
    expect(() => restarted.assert({ head, length: view.length })).toThrow('freshness-expired');
    const revoked = new ControlFreshnessLease(genesis, observation, () => 1_000);
    revoked.invalidate();
    expect(() => revoked.assert({ head, length: view.length })).toThrow('freshness-invalidated');
  });

  it('rejects an oversize frame and a deadline on the bounded SDK fetch', async () => {
    const huge = new Uint8Array(8);
    new DataView(huge.buffer).setUint32(0, MAX_RECORD_BYTES + 1, false);
    const oversize: typeof globalThis.fetch = async (input, init) => {
      expect(new Request(input, init).method).toBe('GET');
      return readResponse(huge, 'opaque:1/+');
    };
    await expect(stream(oversize).readAfter('-1')).rejects.toThrow('invalid-control-frame-size');

    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const waiting = deferred();
    const hung: typeof globalThis.fetch = async (_input, init) => {
      waiting.resolve();
      const signal = init?.signal;
      await new Promise<never>((_, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
      return new Response();
    };
    const bounded = createBoundedStreamsFetch({
      fetch: hung,
      maxResponseBytes: 1024,
      requestTimeoutMs: 100,
      now: () => Date.now(),
      authorize: () => ({
        expiresAt: 1100,
        signal: new AbortController().signal,
        assertValid: () => {},
      }),
    });
    const pending = stream(bounded).readAfter('-1');
    await waiting.promise;
    const rejected = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
  });
});
