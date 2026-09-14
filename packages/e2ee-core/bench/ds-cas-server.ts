/**
 * Local Durable Streams server that implements atomic POST /append-cas
 * on the official `/ds/{bucket}/{stream}` surface used by StreamsClient 0.7.
 * Ordinary POST to the stream is 405. Not production JWT/CAS.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const DS_CONTROL_CONTENT_TYPE = 'application/octet-stream';

function encodeOffset(n: number): string {
  return n.toString(16).padStart(20, '0');
}

export class DurableCasStore {
  private readonly streams = new Map<string, { frames: Uint8Array[]; tail: number }>();
  private queue: Promise<void> = Promise.resolve();
  exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
  ensure(key: string) {
    if (!this.streams.has(key)) this.streams.set(key, { frames: [], tail: 0 });
    return this.streams.get(key)!;
  }
}

function keyOf(bucket: string, stream: string): string {
  return `${bucket}/${stream}`;
}

export async function listenDurableCas(store = new DurableCasStore()): Promise<{
  server: Server;
  baseUrl: string;
  streamUrl: (bucket: string, stream: string) => string;
}> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const target = new URL(req.url ?? '/', 'http://127.0.0.1');
      const parts = target.pathname.split('/').filter(Boolean);
      if (req.method === 'GET' && target.pathname === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
        return;
      }
      if (parts[0] !== 'ds' || parts.length < 3) {
        res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"not found"}');
        return;
      }
      const bucket = decodeURIComponent(parts[1]!);
      const stream = decodeURIComponent(parts[2]!);
      const key = keyOf(bucket, stream);
      const sub = parts[3];
      if (req.method === 'POST' && sub === undefined) {
        res.writeHead(405).end();
        return;
      }
      if (req.method === 'PUT' && sub === undefined) {
        store.ensure(key);
        res
          .writeHead(201, {
            'Content-Type': DS_CONTROL_CONTENT_TYPE,
            'Stream-Next-Offset': encodeOffset(store.ensure(key).tail),
            'Stream-Extensions': 'append-cas',
            Location: `/ds/${encodeURIComponent(bucket)}/${encodeURIComponent(stream)}`,
          })
          .end();
        return;
      }
      if (req.method === 'HEAD' && sub === undefined) {
        const row = store.ensure(key);
        res
          .writeHead(200, {
            'Content-Type': DS_CONTROL_CONTENT_TYPE,
            'Stream-Next-Offset': encodeOffset(row.tail),
            'Stream-Earliest-Offset': encodeOffset(0),
            'Stream-Extensions': 'append-cas',
          })
          .end();
        return;
      }
      if (req.method === 'POST' && sub === 'append-cas') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = new Uint8Array(Buffer.concat(chunks));
        await store.exclusive(async () => {
          const row = store.ensure(key);
          const expected = String(req.headers['stream-expected-offset'] ?? '');
          const tail = encodeOffset(row.tail);
          const matches =
            expected === tail ||
            (row.tail === 0 && (expected === '-1' || expected === encodeOffset(0)));
          if (!matches) {
            res
              .writeHead(412, {
                'Stream-Expected-Offset': String(expected ?? ''),
                'Stream-Next-Offset': tail,
                'Stream-CAS-Mismatch': 'true',
              })
              .end();
            return;
          }
          if (body.byteLength === 0) {
            res.writeHead(400).end('empty');
            return;
          }
          row.frames.push(body.slice());
          row.tail += 1;
          res.writeHead(204, { 'Stream-Next-Offset': encodeOffset(row.tail) }).end();
        });
        return;
      }
      if (req.method === 'GET' && sub === undefined) {
        const row = store.ensure(key);
        const offset = target.searchParams.get('offset') ?? '-1';
        let start = 0;
        if (offset !== '-1' && offset !== encodeOffset(0)) {
          const parsed = Number.parseInt(offset, 16);
          if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > row.tail) {
            res.writeHead(410).end('gone');
            return;
          }
          start = parsed;
        }
        const page = row.frames.slice(start);
        const body = Buffer.concat(page.map((frame) => Buffer.from(frame)));
        res
          .writeHead(200, {
            'Content-Type': DS_CONTROL_CONTENT_TYPE,
            'Stream-Next-Offset': encodeOffset(row.tail),
            'Stream-Up-To-Date': 'true',
          })
          .end(body);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"not found"}');
    })().catch(() => {
      if (!res.headersSent) res.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    server,
    baseUrl,
    streamUrl: (bucket, stream) =>
      `${baseUrl}/ds/${encodeURIComponent(bucket)}/${encodeURIComponent(stream)}`,
  };
}

function encodeByteOffset(n: number): string {
  return n.toString(10).padStart(20, '0');
}

function parseByteOffset(raw: string, tail: number, earliest: number): number | 'gone' | 'bad' {
  const parsed =
    raw === '-1' || raw === ''
      ? 0
      : /^(0|[1-9]\d*)$/u.test(raw) || /^\d{20}$/u.test(raw)
        ? Number.parseInt(raw, 10)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > tail) return 'bad';
  if (parsed < earliest) return 'gone';
  return parsed;
}

function encodeMultipart(
  boundary: string,
  parts: Array<{ contentType: string; body: Uint8Array }>
): Buffer {
  const crlf = '\r\n';
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}${crlf}Content-Type: ${part.contentType}${crlf}${crlf}`));
    chunks.push(Buffer.from(part.body));
    chunks.push(Buffer.from(crlf));
  }
  chunks.push(Buffer.from(`--${boundary}--${crlf}`));
  return Buffer.concat(chunks);
}

type ContentRow = {
  frames: Array<{ start: number; body: Uint8Array }>;
  tail: number;
  earliest: number;
  snapshot: { offset: string; body: Uint8Array } | null;
};

export interface DurableContentSnapshotPut {
  readonly streamKey: string;
  readonly offset: string;
  readonly body: Uint8Array;
  readonly submittingDevice: string;
  readonly leaseIssuedAt: number;
  readonly leaseExpiresAt: number;
}

export interface DurableContentSnapshotAdmission {
  readonly status: 'accepted' | 'idempotent';
  readonly currentOffset: string;
  readonly currentBody: Uint8Array;
}

export interface DurableContentOptions {
  /**
   * Host publication gate. Without this, snapshot PUT fail-closes.
   * Not production JWT/CAS; the caller supplies authenticated device + lease.
   */
  readonly admitSnapshot?: (
    input: DurableContentSnapshotPut
  ) => Promise<DurableContentSnapshotAdmission>;
}

/**
 * Durable Streams peer for streams-crdt content rooms: ordinary POST append,
 * GET /bootstrap (empty snapshot + retained updates), PUT/GET snapshot, 410
 * when reading before the snapshot offset. Snapshot PUT is fail-closed until
 * `admitSnapshot` is supplied. Not production JWT/CAS.
 */
export async function listenDurableContent(
  store = new DurableCasStore(),
  options: DurableContentOptions = {}
): Promise<{
  server: Server;
  baseUrl: string;
  streamUrl: (bucket: string, stream: string) => string;
}> {
  const rows = new Map<string, ContentRow>();
  const ensure = (key: string): ContentRow => {
    const existing = rows.get(key);
    if (existing) return existing;
    const created: ContentRow = { frames: [], tail: 0, earliest: 0, snapshot: null };
    rows.set(key, created);
    return created;
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const target = new URL(req.url ?? '/', 'http://127.0.0.1');
      const parts = target.pathname.split('/').filter(Boolean);
      if (req.method === 'GET' && target.pathname === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
        return;
      }
      if (parts[0] !== 'ds' || parts.length < 3) {
        res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"not found"}');
        return;
      }
      const bucket = decodeURIComponent(parts[1]!);
      const stream = decodeURIComponent(parts[2]!);
      const key = keyOf(bucket, stream);
      const sub = parts[3];
      const extensions = 'append-cas, snapshot, bootstrap';
      if (req.method === 'PUT' && sub === undefined) {
        ensure(key);
        res
          .writeHead(201, {
            'Content-Type': DS_CONTROL_CONTENT_TYPE,
            'Stream-Next-Offset': encodeByteOffset(ensure(key).tail),
            'Stream-Extensions': extensions,
            Location: `/ds/${encodeURIComponent(bucket)}/${encodeURIComponent(stream)}`,
          })
          .end();
        return;
      }
      if (req.method === 'HEAD' && sub === undefined) {
        const row = ensure(key);
        res
          .writeHead(200, {
            'Content-Type': DS_CONTROL_CONTENT_TYPE,
            'Stream-Next-Offset': encodeByteOffset(row.tail),
            'Stream-Earliest-Offset': encodeByteOffset(row.earliest),
            'Stream-Extensions': extensions,
            ...(row.snapshot ? { 'Stream-Snapshot-Offset': row.snapshot.offset } : {}),
          })
          .end();
        return;
      }
      if (req.method === 'POST' && sub === undefined) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = new Uint8Array(Buffer.concat(chunks));
        await store.exclusive(async () => {
          const row = ensure(key);
          if (body.byteLength === 0) {
            res.writeHead(400).end('empty');
            return;
          }
          row.frames.push({ start: row.tail, body: body.slice() });
          row.tail += body.byteLength;
          res.writeHead(204, { 'Stream-Next-Offset': encodeByteOffset(row.tail) }).end();
        });
        return;
      }
      if (req.method === 'GET' && sub === 'bootstrap') {
        const row = ensure(key);
        const retained = row.frames.filter((frame) => frame.start >= row.earliest);
        const partsOut = [
          { contentType: DS_CONTROL_CONTENT_TYPE, body: row.snapshot?.body ?? new Uint8Array() },
          ...retained.map((frame) => ({ contentType: DS_CONTROL_CONTENT_TYPE, body: frame.body })),
        ];
        const boundary = `c1-bootstrap-${row.tail.toString(16)}`;
        const body = encodeMultipart(boundary, partsOut);
        res
          .writeHead(200, {
            'Content-Type': `multipart/mixed; boundary=${boundary}`,
            'Stream-Snapshot-Offset': row.snapshot?.offset ?? '-1',
            'Stream-Next-Offset': encodeByteOffset(row.tail),
            'Stream-Up-To-Date': 'true',
          })
          .end(body);
        return;
      }
      if (req.method === 'PUT' && sub === 'snapshot' && parts[4]) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = new Uint8Array(Buffer.concat(chunks));
        const offset = decodeURIComponent(parts[4]!);
        if (!options.admitSnapshot) {
          res.writeHead(403).end('snapshot-admission-required');
          return;
        }
        const submittingDevice = String(req.headers['x-lody-snapshot-device'] ?? '');
        const leaseIssuedAt = Number.parseInt(
          String(req.headers['x-lody-lease-issued-at'] ?? ''),
          10
        );
        const leaseExpiresAt = Number.parseInt(
          String(req.headers['x-lody-lease-expires-at'] ?? ''),
          10
        );
        if (
          !submittingDevice ||
          !Number.isSafeInteger(leaseIssuedAt) ||
          !Number.isSafeInteger(leaseExpiresAt)
        ) {
          res.writeHead(401).end('snapshot-admission-missing');
          return;
        }
        try {
          await store.exclusive(async () => {
            const published = await options.admitSnapshot!({
              streamKey: key,
              offset,
              body,
              submittingDevice,
              leaseIssuedAt,
              leaseExpiresAt,
            });
            const row = ensure(key);
            row.snapshot = {
              offset: published.currentOffset,
              body: published.currentBody.slice(),
            };
            if (published.status === 'accepted') {
              const parsed = Number.parseInt(published.currentOffset, 10);
              if (Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= row.tail) {
                row.earliest = parsed;
                row.frames = row.frames.filter((frame) => frame.start >= parsed);
              }
            }
          });
          res.writeHead(204).end();
        } catch (error) {
          const code = error instanceof Error ? error.message : 'snapshot-admission-rejected';
          const conflict =
            code === 'snapshot-identity-conflict' ||
            code === 'snapshot-offset-regression' ||
            code === 'snapshot-offset-incomparable';
          res.writeHead(conflict ? 409 : 403).end(code);
        }
        return;
      }
      if (req.method === 'GET' && sub === 'snapshot') {
        const row = ensure(key);
        if (!row.snapshot) {
          res.writeHead(404).end();
          return;
        }
        if (!parts[4]) {
          res
            .writeHead(307, {
              Location: `/ds/${encodeURIComponent(bucket)}/${encodeURIComponent(stream)}/snapshot/${encodeURIComponent(row.snapshot.offset)}`,
            })
            .end();
          return;
        }
        res
          .writeHead(200, {
            'Content-Type': DS_CONTROL_CONTENT_TYPE,
            'Stream-Snapshot-Offset': row.snapshot.offset,
            'Stream-Next-Offset': encodeByteOffset(row.tail),
            'Stream-Up-To-Date': 'true',
          })
          .end(Buffer.from(row.snapshot.body));
        return;
      }
      if (req.method === 'GET' && sub === undefined) {
        const row = ensure(key);
        const offset = target.searchParams.get('offset') ?? '-1';
        const start = parseByteOffset(offset, row.tail, row.earliest);
        if (start === 'gone') {
          res.writeHead(410).end('gone');
          return;
        }
        if (start === 'bad') {
          res.writeHead(400).end('invalid offset');
          return;
        }
        const page = row.frames.filter((frame) => frame.start >= start);
        const body = Buffer.concat(page.map((frame) => Buffer.from(frame.body)));
        res
          .writeHead(200, {
            'Content-Type': DS_CONTROL_CONTENT_TYPE,
            'Stream-Next-Offset': encodeByteOffset(row.tail),
            'Stream-Up-To-Date': 'true',
          })
          .end(body);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"not found"}');
    })().catch(() => {
      if (!res.headersSent) res.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    server,
    baseUrl,
    streamUrl: (bucket, stream) =>
      `${baseUrl}/ds/${encodeURIComponent(bucket)}/${encodeURIComponent(stream)}`,
  };
}

async function main() {
  const { baseUrl, streamUrl } = await listenDurableCas();
  const url = streamUrl('e2eetest', 'org-control');
  await fetch(url, { method: 'PUT', headers: { 'Content-Type': DS_CONTROL_CONTENT_TYPE } });
  process.stdout.write(`${JSON.stringify({ baseUrl, url }, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
