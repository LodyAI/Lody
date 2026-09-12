import { StreamsClient } from '@loro-dev/streams-client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ControlLogClient,
  decodeRecord,
  encodeRecord,
  toHex,
  WebCryptoControl,
  type ControlPolicy,
} from '../src';
import { MAX_READ_BYTES, MAX_READ_RECORDS } from '../src/client';
import {
  CONTROL_STREAM_CONTENT_TYPE,
  frameControlRecord,
  StreamsControlStream,
  StreamsHistoryRemote,
  createBoundedStreamsFetch,
} from '../src/streams';
import { MAX_WIRE_BYTES } from '../src/wire';
import { MemoryStore, deferred, HttpLedger, concat, readResponse } from './control-fixtures';

const url = 'https://streams.example.test/v1/buckets/synthetic/streams/org-control';
const genesis = 'a1'.repeat(32);
const crypto = new WebCryptoControl();
let key: CryptoKey;
let publicKey: string;
const policy: ControlPolicy<number> = {
  transition(state, event) {
    if (
      event.actor !== 'A' ||
      event.memberInstance !== 'A1' ||
      event.device !== 'a' ||
      event.kind !== 'test'
    )
      throw new Error('not-authorized');
    return { state: state + 1, signers: [{ id: 'a', publicKey }] };
  },
};
beforeAll(async () => {
  const pair = await globalThis.crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  key = pair.privateKey;
  publicKey = toHex(
    new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', pair.publicKey))
  );
});
function signed(previous = genesis, id = 1) {
  return crypto.sign(
    {
      genesis,
      previous,
      operationId: id.toString(16).padStart(32, '0'),
      actor: 'A',
      memberInstance: 'A1',
      device: 'a',
      kind: 'test',
      payload: '',
    },
    [{ id: 'a', key }]
  );
}
function adapter(fetch: typeof globalThis.fetch) {
  // The real SDK performs request construction, response parsing and error mapping.
  // Only its HTTP peer is synthetic; no external service or production keys are used.
  return new StreamsControlStream(new StreamsClient({ url, fetch, retry: { maxAttempts: 0 } }));
}
function log(store: MemoryStore, stream: StreamsControlStream) {
  return new ControlLogClient({ genesis, state: 0 }, policy, store, stream);
}

function history(fetch: typeof globalThis.fetch) {
  return new StreamsHistoryRemote(new StreamsClient({ url, fetch, retry: { maxAttempts: 0 } }));
}

describe('bounded SDK fetch', () => {
  afterEach(() => vi.useRealTimers());
  function bounded(
    fetch: typeof globalThis.fetch,
    maxResponseBytes: number,
    expiresAt = Date.now() + 10000,
    revoked = new AbortController()
  ) {
    return createBoundedStreamsFetch({
      fetch,
      maxResponseBytes,
      requestTimeoutMs: 1000,
      now: () => Date.now(),
      authorize: () => ({ expiresAt, signal: revoked.signal, assertValid: () => {} }),
    });
  }

  it('passes an exact-limit signed record through the SDK and persists only verified data', async () => {
    vi.useFakeTimers();
    const backend = new HttpLedger();
    const wire = await signed();
    const frame = frameControlRecord(wire);
    backend.append(frame);
    const store = new MemoryStore();
    expect((await log(store, adapter(bounded(backend.fetch, frame.length))).read()).state).toBe(1);
    expect(store.journal?.pages.flatMap((page) => page.records)).toEqual([wire]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([undefined, '1'])(
    'rejects an oversized chunk despite declared length %s, without saving a cursor',
    async (declared) => {
      const cancelled = deferred();
      const frame = frameControlRecord(await signed());
      const fetch: typeof globalThis.fetch = async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(frame);
            },
            cancel() {
              cancelled.resolve();
            },
          }),
          {
            headers: {
              'Content-Type': CONTROL_STREAM_CONTENT_TYPE,
              'Stream-Next-Offset': 'tail',
              'Stream-Up-To-Date': 'true',
              ...(declared === undefined ? {} : { 'Content-Length': declared }),
            },
          }
        );
      const store = new MemoryStore();
      await expect(log(store, adapter(bounded(fetch, frame.length - 1))).read()).rejects.toThrow();
      await cancelled.promise;
      expect(store.journal).toBeNull();
    }
  );

  it('bounds a stalled header fetch and cancels its late response', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const entered = deferred();
    const response = deferred<Response>();
    const cancelled = deferred();
    let requestSignal: AbortSignal | undefined;
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      requestSignal = init?.signal ?? undefined;
      entered.resolve();
      return response.promise; // Deliberately ignores abort to exercise the local race.
    };
    const result = new StreamsClient({
      url,
      fetch: bounded(fetch, 1024, 1100),
      retry: { maxAttempts: 0 },
    }).read();
    await entered.promise;
    await vi.advanceTimersByTimeAsync(100);
    expect((await result).ok).toBe(false);
    expect(requestSignal?.aborted).toBe(true);
    response.resolve(
      new Response(
        new ReadableStream({
          cancel() {
            cancelled.resolve();
          },
        })
      )
    );
    await cancelled.promise;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['deadline', 'revocation', 'caller'] as const)(
    'errors an incomplete body on %s instead of returning truncated success',
    async (reason) => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);
      const waiting = deferred();
      const cancelled = deferred();
      const revoked = new AbortController();
      const caller = new AbortController();
      const fetch: typeof globalThis.fetch = async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
            },
            pull() {
              waiting.resolve();
            },
            cancel() {
              cancelled.resolve();
            },
          })
        );
      const response = await bounded(fetch, 1024, 1100, revoked)(url, { signal: caller.signal });
      const received = response.arrayBuffer();
      const rejected = expect(received).rejects.toThrow();
      await waiting.promise;
      if (reason === 'deadline') await vi.advanceTimersByTimeAsync(100);
      else if (reason === 'revocation') revoked.abort();
      else caller.abort();
      await rejected;
      await cancelled.promise;
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it('checks the original deadline after a delayed SDK credential lookup, before dispatch', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const entered = deferred();
    const credential = deferred<string>();
    const requests: Request[] = [];
    const client = new StreamsClient({
      url,
      retry: { maxAttempts: 0 },
      auth: async () => {
        entered.resolve();
        return credential.promise;
      },
      fetch: bounded(
        async (input, init) => {
          requests.push(new Request(input, init));
          return readResponse(new Uint8Array(), '-1');
        },
        1024,
        1100
      ),
    });
    const result = client.read();
    await entered.promise;
    vi.setSystemTime(1100);
    credential.resolve('synthetic-device-token');
    expect((await result).ok).toBe(false);
    expect(requests).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains exact pending bytes when expiry hides a committed write, then reconciles without reappending', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const backend = new HttpLedger();
    const committed = deferred();
    const withheld = deferred<Response>();
    const wire = await signed();
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const response = await backend.fetch(request);
      if (request.method === 'POST') {
        committed.resolve();
        return withheld.promise;
      }
      return response;
    };
    const store = new MemoryStore();
    const submission = log(store, adapter(bounded(fetch, 4096, 1100))).submit(wire);
    const rejected = expect(submission).rejects.toThrow();
    await committed.promise;
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(store.journal?.pending).toBe(wire);
    expect(backend.frames).toHaveLength(1);
    // A separately authorized new session may read the exact already committed record.
    expect((await log(store, adapter(bounded(backend.fetch, 4096, 2100))).resume()).status).toBe(
      'committed'
    );
    expect(store.journal?.pending).toBeNull();
    expect(backend.frames).toHaveLength(1);
    withheld.resolve(new Response(null, { status: 204 }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('requests manual redirects and rejects a redirect without consuming or forwarding credentials', async () => {
    let redirect: RequestRedirect | undefined;
    const requests: string[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      redirect = init?.redirect;
      requests.push(new Request(input, init).url);
      return new Response(null, {
        status: 307,
        headers: { Location: 'https://other.example.test/' },
      });
    };
    await expect(
      bounded(fetch, 1024)(url, { headers: { Authorization: 'Bearer synthetic' } })
    ).rejects.toThrow('stream-redirect-rejected');
    expect(redirect).toBe('manual');
    expect(requests).toEqual([url]);
  });
});

describe('history ciphertext through the real Streams SDK', () => {
  const id = '01'.repeat(16);
  const ciphertext = new Uint8Array([8, 7, 6, 5]); // Opaque transport fixture, not a crypto proof.

  it('retries exact ciphertext idempotently and rejects replacement without appending it', async () => {
    const backend = new HttpLedger();
    await history(backend.fetch).put(id, ciphertext);
    await history(backend.fetch).put(id, ciphertext);
    expect(await history(backend.fetch).read(id)).toEqual(ciphertext);
    expect(backend.frames).toHaveLength(1);
    const expected = new Uint8Array([0, 0, 0, 20, ...new Uint8Array(16).fill(1), 8, 7, 6, 5]);
    expect(backend.frames[0]!.body).toEqual(expected);
    await expect(history(backend.fetch).put(id, new Uint8Array([9]))).rejects.toThrow(
      'history-frame-conflict'
    );
    expect(backend.frames).toHaveLength(1);
    expect(await history(backend.fetch).read('02'.repeat(16))).toBeNull();
  });

  it.each(['lost-response', 'false-ack', 'unsupported'] as const)(
    'separates %s from read-back evidence',
    async (mode) => {
      const backend = new HttpLedger();
      backend.mode = mode;
      const remote = history(backend.fetch);
      if (mode === 'false-ack') await remote.put(id, ciphertext);
      else await expect(remote.put(id, ciphertext)).rejects.toThrow();
      expect(await remote.read(id)).toEqual(mode === 'lost-response' ? ciphertext : null);
      backend.mode = 'ok';
      await history(backend.fetch).put(id, ciphertext);
      expect(await remote.read(id)).toEqual(ciphertext);
      expect(backend.frames).toHaveLength(1);
    }
  );

  it('reassembles split frames but fails on a later conflicting duplicate or truncated tail', async () => {
    const backend = new HttpLedger();
    await history(backend.fetch).put(id, ciphertext);
    const frame = backend.frames[0]!.body;
    backend.frames = [];
    backend.pageSize = 1;
    backend.append(frame.slice(0, 2));
    backend.append(frame.slice(2, 21));
    backend.append(frame.slice(21));
    expect(await history(backend.fetch).read(id)).toEqual(ciphertext);
    const different = frame.slice();
    different[different.length - 1] = 99;
    backend.append(different);
    await expect(history(backend.fetch).read(id)).rejects.toThrow('history-frame-conflict');
    backend.frames.pop();
    backend.append(frame.slice(0, 2));
    await expect(history(backend.fetch).read(id)).rejects.toThrow('incomplete-history-frame');
  });

  it('never writes after incomplete reads, wrong content type or oversized frames', async () => {
    const oversized = new Uint8Array([0, 0, 16, 155]); // 4251 > 16 + 4234
    for (const sample of [
      { body: new Uint8Array(), tail: '-1', current: false, type: CONTROL_STREAM_CONTENT_TYPE },
      { body: oversized, tail: 'end', current: true, type: CONTROL_STREAM_CONTENT_TYPE },
      { body: new Uint8Array(), tail: 'end', current: true, type: 'application/json' },
    ]) {
      const remote = history(async (input, init) => {
        expect(new Request(input, init).method).toBe('GET');
        return readResponse(sample.body, sample.tail, sample.current, sample.type);
      });
      await expect(remote.put(id, ciphertext)).rejects.toThrow();
    }
  });

  it('preserves both publications across a CAS race', async () => {
    const backend = new HttpLedger();
    const entered = deferred();
    const release = deferred();
    const first = history(async (input, init) => {
      if (new Request(input, init).method === 'POST') {
        entered.resolve();
        await release.promise;
      }
      return backend.fetch(input, init);
    });
    const pending = first.put(id, ciphertext);
    const rejected = expect(pending).rejects.toThrow('history-cas-conflict');
    await entered.promise;
    const secondId = '02'.repeat(16);
    await history(backend.fetch).put(secondId, new Uint8Array([9]));
    release.resolve();
    await rejected;
    expect(backend.frames).toHaveLength(1);
    await first.put(id, ciphertext);
    expect(await first.read(id)).toEqual(ciphertext);
    expect(await first.read(secondId)).toEqual(new Uint8Array([9]));
    expect(backend.frames).toHaveLength(2);
  });
});

describe('real Streams SDK adapter with a deterministic HTTP peer', () => {
  it('CAS-appends exact frames, catches up a multi-record page, and survives restart', async () => {
    const backend = new HttpLedger();
    const writer = log(new MemoryStore(), adapter(backend.fetch));
    const first = await signed();
    const one = await writer.submit(first);
    expect(one.status).toBe('committed');
    const second = await signed(one.snapshot.head, 2);
    expect(await writer.submit(second)).toMatchObject({
      status: 'committed',
      snapshot: { state: 2 },
    });
    expect(backend.frames.map((p) => p.body)).toEqual([
      frameControlRecord(first),
      frameControlRecord(second),
    ]);
    const store = new MemoryStore();
    expect(await log(store, adapter(backend.fetch)).read()).toMatchObject({ length: 2, state: 2 });
    expect(store.journal).toEqual({
      genesis,
      pending: null,
      pages: [{ records: [first, second], nextOffset: backend.tail }],
    });
    expect(await log(store, adapter(backend.fetch)).read()).toMatchObject({ length: 2, state: 2 });
  });

  it('joins split frames across HTTP pages without inventing an interior cursor', async () => {
    const first = await signed();
    const second = await signed(await crypto.hashRecord(first), 2);
    const a = frameControlRecord(first),
      b = frameControlRecord(second);
    const chunks = [a.slice(0, 2), concat([a.slice(2), b.slice(0, 9)]), b.slice(9)];
    const cursors = ['-1', 'split/a:+', 'split/b:+', 'complete/c:+'];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      expect(request.method).toBe('GET');
      const i = cursors.indexOf(new URL(request.url).searchParams.get('offset')!);
      if (i === 3) return readResponse(new Uint8Array(), cursors[3]!);
      expect(i).toBeGreaterThanOrEqual(0);
      return readResponse(chunks[i]!, cursors[i + 1]!, i === 2);
    };
    const store = new MemoryStore();
    expect(await log(store, adapter(fetch)).read()).toMatchObject({ state: 2 });
    expect(store.journal?.pages).toEqual([{ records: [first, second], nextOffset: cursors[3] }]);
    expect(await log(store, adapter(fetch)).read()).toMatchObject({ state: 2 });
  });

  it('preserves the preceding page when a later page contains a valid prefix and bad signature', async () => {
    const backend = new HttpLedger();
    const first = await signed();
    backend.append(frameControlRecord(first));
    const store = new MemoryStore();
    expect(await log(store, adapter(backend.fetch)).read()).toMatchObject({ state: 1 });
    const checkpoint = structuredClone(store.journal);
    const second = await signed(await crypto.hashRecord(first), 2);
    const third = decodeRecord(await signed(await crypto.hashRecord(second), 3));
    const bad = encodeRecord({ ...third, event: { ...third.event, payload: '00' } });
    backend.append(frameControlRecord(second));
    backend.append(frameControlRecord(bad));
    for (let retry = 0; retry < 2; retry++) {
      await expect(log(store, adapter(backend.fetch)).read()).rejects.toThrow('bad-signature');
      expect(store.journal).toEqual(checkpoint);
    }
  });

  it.each(['before', 'after'] as const)(
    'recovers a whole page when save fails %s its atomic write',
    async (failure) => {
      const first = await signed(),
        second = await signed(await crypto.hashRecord(first), 2);
      const backend = new HttpLedger();
      backend.append(frameControlRecord(first));
      backend.append(frameControlRecord(second));
      const store = new MemoryStore();
      store.failSave = failure;
      await expect(log(store, adapter(backend.fetch)).read()).rejects.toThrow('disk-failure');
      expect(store.journal?.pages.flatMap((p) => p.records) ?? []).toEqual(
        failure === 'after' ? [first, second] : []
      );
      expect(await log(store, adapter(backend.fetch)).read()).toMatchObject({ state: 2 });
      expect(store.journal?.pages).toHaveLength(1);
    }
  );

  it.each([409, 412] as const)(
    'maps SDK CAS mismatch %s without changing bytes or falling back to append',
    async (status) => {
      const backend = new HttpLedger(),
        stream = adapter(backend.fetch);
      backend.mismatchStatus = status;
      const wire = await signed();
      const empty = await stream.readAfter('-1');
      expect(await stream.appendCas(empty.nextOffset, wire)).toBe('accepted');
      expect(await stream.appendCas(empty.nextOffset, wire)).toBe('conflict');
      expect(backend.frames).toHaveLength(1);
      expect(await log(new MemoryStore(), stream).read()).toMatchObject({ state: 1 });
    }
  );

  it.each(['lost-response', 'false-ack', 'unsupported'] as const)(
    'reconciles %s through verified read-back',
    async (mode) => {
      const backend = new HttpLedger();
      backend.mode = mode;
      const store = new MemoryStore(),
        stream = adapter(backend.fetch),
        wire = await signed();
      const result = await log(store, stream).submit(wire);
      expect(result.status).toBe(mode === 'lost-response' ? 'committed' : 'unknown');
      expect(store.journal?.pending).toBe(mode === 'lost-response' ? null : wire);
      backend.mode = 'ok';
      if (result.status === 'unknown')
        expect((await log(store, stream).resume()).status).toBe('committed');
      expect(backend.frames.map((p) => p.body)).toEqual([frameControlRecord(wire)]);
    }
  );

  it('does not submit or clear pending after an incomplete catch-up followed by HTTP 410', async () => {
    const first = await signed(),
      second = await signed(await crypto.hashRecord(first), 2);
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      expect(request.method).toBe('GET');
      return new URL(request.url).searchParams.get('offset') === '-1'
        ? readResponse(frameControlRecord(first), 'partial-tail', false)
        : new Response('history-gone', { status: 410 });
    };
    const store = new MemoryStore();
    store.journal = { genesis, pages: [], pending: second };
    await expect(log(store, adapter(fetch)).resume()).rejects.toThrow('stream-read-gone');
    expect(store.journal).toEqual({
      genesis,
      pending: second,
      pages: [{ records: [first], nextOffset: 'partial-tail' }],
    });
  });

  it('rejects malformed, truncated, wrong-type and oversized payloads without persisting a cursor', async () => {
    const wire = await signed(),
      frame = frameControlRecord(wire);
    const oversizedHeader = new Uint8Array(4);
    new DataView(oversizedHeader.buffer).setUint32(0, MAX_WIRE_BYTES + 1, false);
    const cases = [
      { body: new Uint8Array(4), error: 'invalid-control-frame-size' },
      { body: oversizedHeader, error: 'invalid-control-frame-size' },
      { body: frame.slice(0, -1), error: 'incomplete-control-frame' },
      { body: frame.slice(0, 2), error: 'incomplete-control-frame' },
      { body: frame, contentType: 'application/json', error: 'wrong-control-content-type' },
      { body: new Uint8Array(MAX_READ_BYTES + 1), error: 'read-too-large' },
      {
        body: concat(Array.from({ length: MAX_READ_RECORDS + 1 }, () => frame)),
        error: 'read-too-large',
      },
    ];
    for (const sample of cases) {
      const store = new MemoryStore();
      const stream = adapter(async () =>
        readResponse(sample.body, 'bad-tail', true, sample.contentType)
      );
      await expect(log(store, stream).read()).rejects.toThrow(sample.error);
      expect(store.journal).toBeNull();
    }
  });

  it('rejects nonprogressing reads instead of looping or reporting a current head', async () => {
    for (const body of [new Uint8Array(), frameControlRecord(await signed()).slice(0, 2)]) {
      const store = new MemoryStore();
      const stream = adapter(async () => readResponse(body, '-1', false));
      await expect(log(store, stream).read()).rejects.toThrow(
        body.length ? 'invalid-offset' : 'incomplete-read'
      );
      expect(store.journal).toBeNull();
    }
  });
});
