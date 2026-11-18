import { createServer } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { CloudStreamsTokenPort } from '@lody/platform';

const offset = (n: number) => String(n).padStart(20, '0');
const frame = (bytes: Uint8Array) => {
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(bytes.length);
  return Buffer.concat([prefix, bytes]);
};

/** Actual loopback HTTP + SQLite Streams fixture, no fetch mock or production endpoint. */
export async function streamsFixture(root: string) {
  const db = new Database(path.join(root, 'riverrun-fixture.sqlite3'));
  db.exec(`CREATE TABLE streams (id TEXT PRIMARY KEY, snapshot BLOB, tail INTEGER NOT NULL, snapshot_offset INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE records (id TEXT NOT NULL, start INTEGER NOT NULL, finish INTEGER NOT NULL, body BLOB NOT NULL);`);
  const requests: Array<{ method: string; stream: string; ttl?: string }> = [];
  const requestPaths: string[] = [];
  let unauthorized = 0;
  let networkAttempts = 0;
  let validToken = 'synthetic-streams-refreshed';
  let tokenDenied = false;
  let tokenRequests = 0;
  let rejectHead = 0;
  let offline = false;
  const offlineRooms = new Set<string>();
  let losePost = false;
  let postLost: (() => void) | undefined;
  let postHeld: ((receipt: { closed: Promise<void> }) => void) | undefined;
  const partialBootstrap = new Set<string>();
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/api/loro-streams/token') {
        tokenRequests++;
        if (tokenDenied || request.headers.authorization !== 'Bearer synthetic-main-session') {
          response.writeHead(403);
          response.end();
          return;
        }
        for await (const _chunk of request) {
          /* Drain the actual request body. */
        }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ token: validToken, expiresIn: 3600, gatewayBaseUrl: url }));
        return;
      }
      if (request.headers.authorization !== `Bearer ${validToken}`) {
        unauthorized++;
        response.writeHead(401);
        response.end();
        return;
      }
      networkAttempts++;
      if (offline) {
        response.writeHead(503);
        response.end();
        return;
      }
      const requestUrl = new URL(request.url ?? '/', 'http://fixture.invalid');
      requestPaths.push(requestUrl.pathname);
      const parts = requestUrl.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (parts.shift() !== 'gateway') {
        response.writeHead(404);
        response.end();
        return;
      }
      const stream = parts[2];
      if (parts[0] !== 'ds' || parts[1] !== 'lody' || !stream) {
        response.writeHead(404);
        response.end();
        return;
      }
      if (offlineRooms.has(stream)) {
        response.writeHead(503);
        response.end();
        return;
      }
      const method = request.method ?? '';
      requests.push({ method, stream, ttl: request.headers['stream-ttl']?.toString() });
      const state = db
        .prepare('SELECT snapshot, tail, snapshot_offset FROM streams WHERE id = ?')
        .get(stream) as
        | { snapshot: Buffer | null; tail: number; snapshot_offset: number }
        | undefined;
      if (method === 'HEAD') {
        response.writeHead(
          rejectHead || (state ? 200 : 404),
          state
            ? {
                'Content-Type': 'application/octet-stream',
                'Stream-Next-Offset': offset(state.tail),
              }
            : {}
        );
        response.end();
        return;
      }
      if (method === 'PUT') {
        const buffers = [];
        for await (const chunk of request) buffers.push(Buffer.from(chunk));
        if (requestUrl.searchParams.has('snapshot') || parts[3] === 'snapshot') {
          if (!state) {
            response.writeHead(404);
            response.end();
            return;
          }
          const at = Number(parts[4] ?? requestUrl.searchParams.get('offset') ?? state.tail);
          if (!Number.isSafeInteger(at) || at < 0 || at > state.tail) {
            response.writeHead(409);
            response.end();
            return;
          }
          db.prepare('UPDATE streams SET snapshot = ?, snapshot_offset = ? WHERE id = ?').run(
            Buffer.concat(buffers),
            at,
            stream
          );
          response.writeHead(200, {
            'Stream-Snapshot-Offset': offset(at),
            'Stream-Next-Offset': offset(state.tail),
          });
          response.end();
          return;
        }
        if (state) {
          response.writeHead(409);
          response.end();
          return;
        }
        const body = Buffer.concat(buffers);
        db.prepare('INSERT INTO streams (id, snapshot, tail) VALUES (?, NULL, ?)').run(
          stream,
          body.length
        );
        if (body.length)
          db.prepare('INSERT INTO records VALUES (?, 0, ?, ?)').run(stream, body.length, body);
        response.writeHead(201, {
          'Content-Type': 'application/octet-stream',
          'Stream-Next-Offset': offset(body.length),
        });
        response.end();
        return;
      }
      if (!state) {
        response.writeHead(404);
        response.end();
        return;
      }
      if (method === 'POST') {
        const buffers = [];
        for await (const chunk of request) buffers.push(Buffer.from(chunk));
        const body = Buffer.concat(buffers);
        if (postHeld) {
          const notify = postHeld;
          postHeld = undefined;
          const closed = new Promise<void>((resolve) => response.once('close', () => resolve()));
          notify({ closed });
          return;
        }
        const tail = state.tail + body.length;
        db.transaction(() => {
          db.prepare('INSERT INTO records VALUES (?, ?, ?, ?)').run(stream, state.tail, tail, body);
          db.prepare('UPDATE streams SET tail = ? WHERE id = ?').run(tail, stream);
        })();
        if (losePost) {
          losePost = false;
          offline = true;
          postLost?.();
          request.socket.destroy();
          return;
        }
        response.writeHead(204, { 'Stream-Next-Offset': offset(tail) });
        response.end();
        return;
      }
      if (
        method === 'GET' &&
        (parts[3] === 'bootstrap' || requestUrl.searchParams.has('bootstrap'))
      ) {
        const rows = db
          .prepare('SELECT body, finish FROM records WHERE id = ? AND start >= ? ORDER BY start')
          .all(stream, state.snapshot ? state.snapshot_offset : 0) as Array<{
          body: Buffer;
          finish: number;
        }>;
        const delivered = partialBootstrap.has(stream) ? rows.slice(0, 1) : rows;
        const boundary = 'SyntheticNativeRemoteFixture';
        const chunks = [state.snapshot ?? Buffer.alloc(0), ...delivered.map((row) => row.body)];
        const body = Buffer.concat([
          ...chunks.flatMap((chunk) => [
            Buffer.from(`--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`),
            chunk,
            Buffer.from('\r\n'),
          ]),
          Buffer.from(`--${boundary}--\r\n`),
        ]);
        const tail = partialBootstrap.has(stream) ? (delivered.at(-1)?.finish ?? 0) : state.tail;
        response.writeHead(200, {
          'Content-Type': `multipart/mixed; boundary=${boundary}`,
          'Stream-Snapshot-Offset': state.snapshot ? offset(state.snapshot_offset) : '-1',
          'Stream-Next-Offset': offset(tail),
          'Stream-Up-To-Date': String(tail === state.tail),
        });
        response.end(body);
        return;
      }
      if (method === 'GET' && parts[3] === 'snapshot') {
        response.writeHead(state.snapshot ? 200 : 404, {
          'Content-Type': 'application/octet-stream',
          'Stream-Snapshot-Offset': state.snapshot ? offset(state.snapshot_offset) : '-1',
          'Stream-Next-Offset': offset(state.tail),
        });
        response.end(state.snapshot ?? undefined);
        return;
      }
      if (method === 'GET') {
        const from = Number(requestUrl.searchParams.get('offset') ?? '-1');
        const rows = db
          .prepare('SELECT body FROM records WHERE id = ? AND start >= ? ORDER BY start')
          .all(stream, from) as Array<{ body: Buffer }>;
        response.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Stream-Next-Offset': offset(state.tail),
          'Stream-Up-To-Date': 'true',
        });
        response.end(Buffer.concat(rows.map((row) => row.body)));
        return;
      }
      response.writeHead(405);
      response.end();
    } catch {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.writeHead(500);
      response.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind loopback');
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    db.close();
  };
  const url = `http://127.0.0.1:${address.port}/gateway`;
  let token = 'synthetic-streams-expired';
  const tokens = {
    createTokenProviderLegacy: () => {
      let tokenClosed = false;
      return {
        getToken: async () => token,
        getGatewayBaseUrl: () => url,
        getShardHostSuffix: () => undefined,
        createAuthCallback: () => async (context?: { previousToken?: string }) => {
          if (tokenClosed) throw new Error('closed');
          if (context?.previousToken === token) token = 'synthetic-streams-refreshed';
          return token;
        },
        close: async () => {
          tokenClosed = true;
        },
        retryCleanup: async () => {},
      };
    },
  } as unknown as CloudStreamsTokenPort;
  return {
    db,
    url,
    close,
    tokenRequests: () => tokenRequests,
    rotateToken: () => {
      validToken = 'synthetic-streams-rotated';
    },
    denyTokens: () => {
      tokenDenied = true;
      validToken = 'synthetic-streams-revoked';
    },
    tokens,
    requests,
    partialBootstrap,
    requestPaths,
    unauthorized: () => unauthorized,
    networkAttempts: () => networkAttempts,
    holdRoom: (id: string, hold: boolean) => {
      if (hold) offlineRooms.add(id);
      else offlineRooms.delete(id);
    },
    offline: (value: boolean) => {
      offline = value;
      if (value) server.closeAllConnections();
    },
    holdNextPost: () =>
      new Promise<{ closed: Promise<void> }>((resolve) => {
        if (postHeld) throw new Error('Only one held request is supported');
        postHeld = resolve;
      }),
    loseNextPostAck: () =>
      new Promise<void>((resolve) => {
        losePost = true;
        postLost = resolve;
      }),
    rejectHead: (status: number) => {
      rejectHead = status;
    },
    seed: (id: string, snapshot?: Uint8Array) => {
      db.prepare('INSERT INTO streams (id, snapshot, tail) VALUES (?, ?, 0)').run(
        id,
        snapshot ? Buffer.from(snapshot) : null
      );
    },
    append: (id: string, bytes: Uint8Array) => {
      const state = db.prepare('SELECT tail FROM streams WHERE id = ?').get(id) as { tail: number };
      const body = frame(bytes);
      const finish = state.tail + body.length;
      db.prepare('INSERT INTO records VALUES (?, ?, ?, ?)').run(id, state.tail, finish, body);
      db.prepare('UPDATE streams SET tail = ? WHERE id = ?').run(finish, id);
    },
  };
}
