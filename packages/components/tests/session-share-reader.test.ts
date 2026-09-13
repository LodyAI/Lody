import { describe, expect, it, vi } from 'vitest';
import { LoroDoc, LoroList, LoroMap, LoroText } from 'loro-crdt';
import { compressStreamsSnapshot } from '@lody/shared';
import { createSharedChatStreamBuilder } from '../src/components/sharing/session-share-stream-items';
import type { SessionId } from '@lody/shared';
import {
  createSessionShareReader,
  type SessionShareReaderSnapshot,
} from '../src/lib/session-share-reader';

const URL = 'https://api.example.test/api/shares/share/sessions/session/stream';
const secret = 'a'.repeat(64);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function bootstrap(snapshot: Uint8Array) {
  const prefix = new TextEncoder().encode(
    '--share-fixture\r\nContent-Type: application/octet-stream\r\n\r\n'
  );
  const suffix = new TextEncoder().encode('\r\n--share-fixture--\r\n');
  const bytes = new Uint8Array(prefix.length + snapshot.length + suffix.length);
  bytes.set(prefix);
  bytes.set(snapshot, prefix.length);
  bytes.set(suffix, prefix.length + snapshot.length);
  return new Response(bytes, {
    headers: {
      'Content-Type': 'multipart/mixed; boundary=share-fixture',
      'Stream-Snapshot-Offset': '1',
      'Stream-Next-Offset': '1',
      'Stream-Up-To-Date': 'true',
    },
  });
}
function event(update: Uint8Array, offset: string) {
  const framed = new Uint8Array(update.length + 4);
  new DataView(framed.buffer).setUint32(0, update.length, false);
  framed.set(update, 4);
  return new TextEncoder().encode(
    `event: data\ndata: ${Buffer.from(framed).toString('base64')}\n\nevent: control\ndata: ${JSON.stringify({ streamNextOffset: offset, upToDate: true })}\n\n`
  );
}

describe('anonymous session reader with real Loro and Streams transport', () => {
  it('preserves unchanged messages and render rows across a long streaming response', async () => {
    const streamBuilder = createSharedChatStreamBuilder();
    const original = new LoroDoc();
    const history = original.getList('history');
    for (let index = 0; index < 1_000; index++)
      history.push({
        id: `message-${index}`,
        role: 'assistant',
        timestamp: '2026-01-01T00:00:00Z',
        items: [
          {
            type: 'text',
            text: `Synthetic message ${index}: ${'Long historical text. '.repeat(50)}`,
          },
        ],
      });
    const last = history.pushContainer(new LoroMap());
    last.set('id', 'streaming');
    last.set('role', 'assistant');
    last.set('timestamp', '2026-01-01T00:00:00Z');
    const item = last.setContainer('items', new LoroList()).pushContainer(new LoroMap());
    item.set('type', 'text');
    const text = item.setContainer('text', new LoroText());
    text.insert(0, 'Start');
    original.commit();
    const initialBytes = original.export({ mode: 'snapshot' });
    let version = original.version();
    let snapshot!: SessionShareReaderSnapshot;
    let next = deferred<SessionShareReaderSnapshot>();
    const live = deferred<ReadableStreamDefaultController<Uint8Array>>();
    const reader = createSessionShareReader({
      streamUrl: URL,
      secret,
      onChange(value) {
        snapshot = value;
        next.resolve(value);
      },
      fetch: async (input, init) =>
        String(input).endsWith('/bootstrap')
          ? bootstrap(initialBytes)
          : new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  live.resolve(controller);
                  init?.signal?.addEventListener(
                    'abort',
                    () => controller.error(new Error('Closed')),
                    { once: true }
                  );
                },
              }),
              {
                headers: {
                  'Content-Type': 'text/event-stream',
                  'Stream-Sse-Data-Encoding': 'base64',
                },
              }
            ),
    });
    try {
      await reader.start();
      const connection = await live.promise;
      expect(snapshot.history).toHaveLength(1_001);
      const first = snapshot.history[0];
      let rows = streamBuilder.build(snapshot.history, 'session' as SessionId);
      expect(rows.items).toHaveLength(1_001);
      expect(rows.items.every((row) => row.type === 'message')).toBe(true);
      expect(rows.items.at(-1)).toMatchObject({
        type: 'message',
        message: { id: 'streaming', items: [{ type: 'text', text: 'Start' }] },
      });
      const firstRow = rows.items[0];
      const start = performance.now();
      for (let index = 0; index < 100; index++) {
        next = deferred();
        text.insert(text.length, '.');
        original.commit();
        const delta = original.export({ mode: 'update', from: version });
        version = original.version();
        connection.enqueue(event(delta, String(index + 2)));
        await next.promise;
        expect(snapshot.history[0]).toBe(first);
        rows = streamBuilder.build(snapshot.history, 'session' as SessionId);
        expect(rows.items[0]).toBe(firstRow);
        expect(rows.items.at(-1)).toMatchObject({
          type: 'message',
          message: {
            id: 'streaming',
            items: [{ type: 'text', text: 'Start' + '.'.repeat(index + 1) }],
          },
        });
      }
      expect(snapshot.history.at(-1)?.items).toEqual([
        { type: 'text', text: 'Start' + '.'.repeat(100) },
      ]);
      const incrementalMs = performance.now() - start;
      // A diagnostic baseline of the old conversion/render path, with the same
      // transcript and iteration count. No hardware-dependent pass threshold.
      const baselineStart = performance.now();
      for (let index = 0; index < 100; index++) {
        const json = original.toJSON() as { history: SessionShareReaderSnapshot['history'] };
        streamBuilder.build(json.history, 'session' as SessionId);
      }
      console.info(
        'share-reader-incremental',
        JSON.stringify({
          messages: 1_001,
          updates: 100,
          incrementalMs,
          fullConversionBaselineMs: performance.now() - baselineStart,
          bootstrapBytes: initialBytes.byteLength,
        })
      );
      const unchangedHistory = snapshot.history;
      next = deferred();
      original.getMap('session').set('title', 'Metadata update');
      original.commit();
      connection.enqueue(event(original.export({ mode: 'update', from: version }), '102'));
      await next.promise;
      expect(snapshot.history).toBe(unchangedHistory);
    } finally {
      streamBuilder.dispose();
      await reader.close();
      original.free();
    }
  });

  it('recovers from initial HTTP/network failures and retains live status updates', async () => {
    vi.useFakeTimers();
    const original = new LoroDoc();
    original.getList('history').push({
      id: 'first',
      role: 'user',
      timestamp: '2026-01-01T00:00:00Z',
      items: [],
    });
    original.commit();
    const initial = original.export({ mode: 'snapshot' });
    let attempts = 0;
    let latest: SessionShareReaderSnapshot | undefined;
    const connected = deferred<ReadableStreamDefaultController<Uint8Array>>();
    const live = deferred<void>();
    let disconnected = deferred<void>();
    const reader = createSessionShareReader({
      streamUrl: URL,
      secret,
      onChange(value) {
        latest = value;
        if (value.status === 'live' && value.history.length === 1) live.resolve();
        if (value.status === 'paused' && value.history.length === 1) disconnected.resolve();
      },
      fetch: async (input, init) => {
        if (String(input).endsWith('/bootstrap')) {
          attempts++;
          if (attempts === 1) return new Response(null, { status: 503 });
          if (attempts === 2) throw new TypeError('Temporary network failure');
          return bootstrap(initial);
        }
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              connected.resolve(controller);
              init?.signal?.addEventListener('abort', () => controller.error(new Error('Closed')), {
                once: true,
              });
            },
          }),
          {
            headers: {
              'Content-Type': 'text/event-stream',
              'Stream-Sse-Data-Encoding': 'base64',
            },
          }
        );
      },
    });
    try {
      await reader.start();
      expect(latest?.status).toBe('paused');
      await vi.advanceTimersByTimeAsync(999);
      expect(attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toBe(2);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(attempts).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      await live.promise;
      expect(latest?.history.map((entry) => entry.id)).toEqual(['first']);
      disconnected = deferred<void>();
      (await connected.promise).error(new Error('Connection lost'));
      await disconnected.promise;
      expect(latest?.status).toBe('paused');
    } finally {
      await reader.close();
      original.free();
      vi.useRealTimers();
    }
  });

  it.each(['close', 'invalidate'] as const)(
    'cancels pending initial retry on %s',
    async (action) => {
      vi.useFakeTimers();
      const requests: string[] = [];
      const reader = createSessionShareReader({
        streamUrl: URL,
        secret,
        onChange() {},
        fetch: async (input) => {
          requests.push(String(input));
          return new Response(null, { status: 503 });
        },
      });
      try {
        await reader.start();
        await reader[action]();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(requests).toEqual([`${URL}/bootstrap`]);
      } finally {
        await reader.close();
        vi.useRealTimers();
      }
    }
  );

  it('reconnects after a broken stream and catches up from the last delivered offset', async () => {
    vi.useFakeTimers();
    const original = new LoroDoc();
    const history = original.getList('history');
    history.push({ id: 'first', role: 'user', timestamp: '2026-01-01T00:00:00Z', items: [] });
    original.commit();
    const initial = original.export({ mode: 'snapshot' });
    const version = original.version();
    const connected = deferred<ReadableStreamDefaultController<Uint8Array>>();
    const paused = deferred<void>();
    const recovered = deferred<SessionShareReaderSnapshot>();
    const reconnected = deferred<string>();
    let calls = 0;
    let delta: Uint8Array;
    const reader = createSessionShareReader({
      streamUrl: URL,
      secret,
      onChange(value) {
        if (value.status === 'paused') paused.resolve();
        if (value.history.length === 2 && value.status === 'live') recovered.resolve(value);
      },
      fetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith('/bootstrap')) return bootstrap(initial);
        calls++;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              init?.signal?.addEventListener('abort', () => controller.error(new Error('Closed')), {
                once: true,
              });
              if (calls === 1) connected.resolve(controller);
              else {
                reconnected.resolve(url);
                controller.enqueue(event(delta, '2'));
              }
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream', 'Stream-Sse-Data-Encoding': 'base64' } }
        );
      },
    });
    try {
      await reader.start();
      const connection = await connected.promise;
      history.push({
        id: 'offline',
        role: 'assistant',
        timestamp: '2026-01-01T00:00:01Z',
        items: [],
      });
      original.commit();
      delta = original.export({ mode: 'update', from: version });
      connection.error(new Error('Connection lost'));
      await paused.promise;
      await vi.runOnlyPendingTimersAsync();
      expect(await reconnected.promise).toContain('offset=1');
      expect((await recovered.promise).history.map((entry) => entry.id)).toEqual([
        'first',
        'offline',
      ]);
      expect(calls).toBe(2);
    } finally {
      await reader.close();
      original.free();
      vi.useRealTimers();
    }
  });

  it.each([false, true])(
    'loads a snapshot (compressed=%s), applies live updates once, and only issues reads',
    async (compressed) => {
      const original = new LoroDoc();
      const history = original.getList('history');
      history.push({ id: 'first', role: 'user', timestamp: '2026-01-01T00:00:00Z', items: [] });
      original.commit();
      const version = original.version();
      const raw = original.export({ mode: 'snapshot' });
      const snapshot = compressed ? await compressStreamsSnapshot(raw) : raw;
      const initial = deferred<void>();
      const updated = deferred<SessionShareReaderSnapshot>();
      const connection = deferred<{
        controller: ReadableStreamDefaultController<Uint8Array>;
        signal: AbortSignal;
      }>();
      const requests: { url: string; init?: RequestInit }[] = [];
      const reader = createSessionShareReader({
        streamUrl: URL,
        secret,
        onChange(value) {
          if (value.history.length === 1 && value.status === 'live') initial.resolve();
          if (value.history.length === 2) updated.resolve(value);
        },
        fetch: async (input, init) => {
          const url = String(input);
          requests.push({ url, init });
          expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${secret}`);
          expect(init?.credentials).toBe('omit');
          expect(init?.cache).toBe('no-store');
          expect(init?.method ?? 'GET').toBe('GET');
          if (url === `${URL}/bootstrap`) return bootstrap(snapshot);
          expect(url).toContain(`${URL}?`);
          expect(url).toContain('live=sse');
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                const signal = init!.signal!;
                signal.addEventListener('abort', () => controller.error(new Error('Aborted')), {
                  once: true,
                });
                connection.resolve({ controller, signal });
              },
            }),
            {
              headers: {
                'Content-Type': 'text/event-stream',
                'Stream-Sse-Data-Encoding': 'base64',
              },
            }
          );
        },
      });
      try {
        await reader.start();
        await initial.promise;
        const live = await connection.promise;
        history.push({
          id: 'second',
          role: 'assistant',
          timestamp: '2026-01-01T00:00:01Z',
          items: [],
        });
        original.commit();
        const delta = original.export({ mode: 'update', from: version });
        live.controller.enqueue(event(delta, '2'));
        live.controller.enqueue(event(delta, '3'));
        expect((await updated.promise).history.map((entry) => entry.id)).toEqual([
          'first',
          'second',
        ]);
        await reader.close();
        expect(live.signal.aborted).toBe(true);
        expect(requests.map((entry) => entry.url.split('?')[0])).toEqual([`${URL}/bootstrap`, URL]);
      } finally {
        await reader.close();
        original.free();
      }
    }
  );

  it.each([401, 403, 404])('fails closed on status %s without retrying', async (status) => {
    vi.useFakeTimers();
    const statuses: SessionShareReaderSnapshot[] = [];
    const requests: string[] = [];
    const reader = createSessionShareReader({
      streamUrl: URL,
      secret,
      onChange: (snapshot) => statuses.push(snapshot),
      fetch: async (input) => {
        requests.push(String(input));
        return new Response(null, { status });
      },
    });
    try {
      await reader.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(requests).toEqual([`${URL}/bootstrap`]);
      expect(statuses.at(-1)).toEqual({ status: 'unavailable', history: [] });
    } finally {
      await reader.close();
      vi.useRealTimers();
    }
  });
});
