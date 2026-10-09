import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isAbsolute, join, resolve } from 'node:path';
import { startDevServer, type RunningDevServer } from '@loro-dev/sqlite-riverrun';
import { ContentCipher } from '@lody/e2ee-core';
import {
  assertEpochStreamAppend,
  decodeRecord,
  hashRecord,
  joinRequestSigningBytes,
  sequentialSignatureVerify,
} from '@lody/e2ee-core/ledger';
import {
  Bytes,
  ContentError,
  ValidationError,
  extendLedger,
  verifyLedger,
  type LedgerView,
} from '@lody/e2ee-core/effect';
import { signatureVerifierLayer } from '@lody/e2ee-core/effect/platform';
import { Effect, Result, Layer } from 'effect';
import { SqliteSnapshotPublicationStore } from '@lody/e2ee-core/node-snapshot-publication-store';
import {
  compareSnapshotOffsets,
  CONTENT_SNAPSHOT_ADMISSION_WINDOW_MS,
  createContentSnapshotPublication,
  SNAPSHOT_ADMISSION_DEVICE_HEADER,
} from '@lody/e2ee-core/snapshot-admission';
import { contentAuthorKey, deviceMayWriteDocument } from '@lody/e2ee-core/streams-content';
import { StreamsClient } from '@loro-dev/streams-client';
import { chmodSync, writeFileSync } from 'node:fs';
import { fromHex, randomBytes, toHex } from './bytes';
import { verifyPossession } from './device';
import {
  authorizeCurrentMember,
  authorizeJoinSigner,
  authorizeMembership,
  authorizeStreamRequest,
  isKnownStream,
} from './gateway';
import { credentialExpired, HostMeta } from './host-meta';
import {
  AUTH_HEADER,
  CONTENT_TYPE,
  CONTROL_STREAM,
  DEVICE_HEADER,
  FLOCK_STREAM,
  KEYS_STREAM,
  LORO_STREAM,
  type ComparisonWire,
  type Failpoint,
  type IssuedCredential,
  type JoinRequestWire,
} from './protocol';
import { LabClock, makeLabClock } from '../services/clock';
import { LabHttp } from '../services/http';
import { LabFs } from '../services/fs';
import { LabRun } from '../services/run';
import { makeLiveFs, type LabFsShape } from '../services/fs';
import type { LabFetch } from '../services/http';

export interface DemoHostOptions {
  readonly dataDir: string;
  readonly host?: string;
  readonly port?: number;
  readonly testMode?: boolean;
  readonly wallClock?: () => number;
  readonly fs?: LabFsShape;
  readonly fetch?: LabFetch;
}

export interface RunningDemoHost {
  readonly baseUrl: string;
  readonly riverrunUrl: string;
  readonly dataDir: string;
  readonly riverrunDbPath: string;
  readonly port: number;
  /** Present only when testMode constructed this host. Not an attacker view. */
  readonly harnessToken: string | null;
  setNow(value: number | null): void;
  setFailpoint(name: Failpoint): void;
  close(): Promise<void>;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(text);
}

function cors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,DELETE,OPTIONS');
}

async function readBody(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
}

function bearer(req: IncomingMessage): string | null {
  const header = req.headers[AUTH_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value?.startsWith('Bearer ')) return null;
  return value.slice('Bearer '.length);
}

/** Only these client headers reach Riverrun. Stream lifecycle headers (Stream-Closed,
 * Stream-Seq, TTL/expiry) and the device bearer token are never forwarded. */
function forwardedHeaders(req: IncomingMessage, allowed: readonly string[]): Headers {
  const headers = new Headers();
  for (const name of allowed) {
    const value = req.headers[name];
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  return headers;
}

/** Mailbox screening only; the ledger re-verifies the request on admission. */
async function joinRequestSigned(genesisHex: string, wire: JoinRequestWire): Promise<boolean> {
  try {
    const request = {
      requestId: fromHex(wire.requestId),
      userId: fromHex(wire.userId),
      signingPublicKey: fromHex(wire.signingPublicKey),
      encryptionPublicKey: fromHex(wire.encryptionPublicKey),
      expiresAt: wire.expiresAt,
    };
    const [ok] = await sequentialSignatureVerify.verify([
      {
        pk: request.signingPublicKey,
        msg: joinRequestSigningBytes(fromHex(genesisHex), request),
        sig: fromHex(wire.signature),
      },
    ]);
    return ok === true;
  } catch {
    return false;
  }
}

function pathParts(url: URL): string[] {
  return url.pathname.split('/').filter(Boolean);
}

function unframe(body: Uint8Array): Uint8Array[] {
  const records: Uint8Array[] = [];
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  let start = 0;
  while (body.length - start >= 4) {
    const length = view.getUint32(start, false);
    if (length === 0 || start + 4 + length > body.length) throw new Error('invalid-control-frame');
    records.push(body.subarray(start + 4, start + 4 + length));
    start += 4 + length;
  }
  if (start !== body.length) throw new Error('invalid-control-frame');
  return records;
}

async function createStream(
  riverrunUrl: string,
  bucket: string,
  stream: string,
  fetch: LabFetch
): Promise<void> {
  const client = new StreamsClient({
    url: `${riverrunUrl}/ds/${encodeURIComponent(bucket)}/${encodeURIComponent(stream)}`,
    retry: { maxAttempts: 0 },
    fetch,
  });
  const created = await client.create({ contentType: CONTENT_TYPE });
  if (!created.ok) throw new Error(`create-stream-${stream}`);
}

/** Scoped native acquisition. Resources remain owned until the caller's scope closes. */
export function acquireDemoHost(options: DemoHostOptions) {
  return Effect.gen(function* () {
    if (!isAbsolute(options.dataDir))
      return yield* Effect.fail(new Error('data-dir-must-be-absolute'));
    const disk = yield* LabFs;
    const { fetch: upstreamFetch } = yield* LabHttp;
    // Explicit native Promise bridge: Effect cancellation crosses into SDK fetch.
    const requestSignal = new AsyncLocalStorage<AbortSignal>();
    const httpFetch: LabFetch = (input, init) => {
      const request = new Request(input, init);
      const signal = requestSignal.getStore();
      return upstreamFetch(
        new Request(request, {
          signal: signal ? AbortSignal.any([signal, request.signal]) : request.signal,
        })
      );
    };
    const clock = yield* LabClock;
    yield* Effect.sync(() => disk.mkdir(options.dataDir));
    const riverrunDbPath = join(options.dataDir, 'riverrun.sqlite');
    const meta = yield* Effect.acquireRelease(
      Effect.sync(() => new HostMeta(join(options.dataDir, 'host.sqlite'))),
      (resource) => Effect.sync(() => resource.close())
    );
    const snapshotPath = join(options.dataDir, 'snapshots.sqlite');
    const snapshotStore = disk.exists(snapshotPath)
      ? new SqliteSnapshotPublicationStore(snapshotPath)
      : new SqliteSnapshotPublicationStore(snapshotPath, { create: true });
    const wallClock = clock.nowMs;
    const testMode = options.testMode === true;
    const hostName = options.host ?? '127.0.0.1';
    const harnessToken = testMode ? toHex(randomBytes(32)) : null;
    // Harness state lives in host.sqlite; a non-test host must never honour it.
    const hostNow = () => (testMode ? meta.now(wallClock) : wallClock());
    const hostFailpoint = () => (testMode ? meta.failpoint() : 'none');
    if (harnessToken) {
      const tokenPath = join(options.dataDir, 'harness.token');
      writeFileSync(tokenPath, `${harnessToken}\n`, { encoding: 'utf8' });
      try {
        chmodSync(tokenPath, 0o600);
      } catch {
        /* platform may ignore mode */
      }
    }

    const riverrun: RunningDevServer = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startDevServer({
          host: '127.0.0.1',
          port: 0,
          dbPath: riverrunDbPath,
          protocol: 'http1',
        })
      ),
      (server) => Effect.promise(() => server.close())
    );

    const requestRun = yield* Effect.acquireRelease(
      Effect.sync(() => new LabRun(Layer.empty)),
      (run) => Effect.promise(() => run.close())
    );
    const snapshotWriteLedger = new AsyncLocalStorage<LedgerView>();

    async function runHostLedger<A>(effect: Effect.Effect<A, ValidationError, never>): Promise<A> {
      try {
        return await requestRun.run(effect);
      } catch (error) {
        if (error instanceof ValidationError) throw new Error(error.code, { cause: error });
        throw error;
      }
    }

    /** Re-read control from Riverrun and verify with the native workflow. */
    async function loadLedger(genesisHex: string): Promise<LedgerView> {
      return (await loadControl(genesisHex)).ledger;
    }

    /** The verified ledger plus the stream offset right after its last record. */
    async function loadControl(genesisHex: string): Promise<{ ledger: LedgerView; tail: string }> {
      // Always re-read from Riverrun. A sticky cache would authorize content
      // writes against stale membership after a malicious-server control append.
      const space = meta.space(genesisHex);
      if (!space) throw new Error('unknown-space');
      const records: Uint8Array[] = [space.genesis];
      const client = new StreamsClient({
        url: `${riverrun.baseUrl}/ds/${encodeURIComponent(genesisHex)}/${CONTROL_STREAM}`,
        retry: { maxAttempts: 0 },
      });
      let offset = '-1';
      let upToDate = false;
      for (let page = 0; page < 256 && !upToDate; page++) {
        const response = await client.read({ offset });
        if (!response.ok) throw new Error('control-read-failed');
        const body = response.result.payload.body;
        if (body.byteLength > 0) {
          for (const record of unframe(new Uint8Array(body))) records.push(record);
        }
        offset = response.result.nextOffset;
        upToDate = response.result.upToDate;
      }
      // Authorizing against a prefix would let a stale view approve a forked append.
      if (!upToDate) throw new Error('control-read-incomplete');
      const ledger = await runHostLedger(
        Effect.gen(function* () {
          const anchor = yield* Effect.fromResult(Bytes.genesisHash(fromHex(genesisHex)));
          return yield* verifyLedger({ anchor, records }).pipe(
            Effect.provide(signatureVerifierLayer)
          );
        })
      );
      return { ledger, tail: offset };
    }

    function requireCredential(req: IncomingMessage, now: number): IssuedCredential {
      const token = bearer(req);
      if (!token) throw new Error('unauthorized');
      const credential = meta.credential(token);
      if (!credential) throw new Error('unauthorized');
      if (credentialExpired(now, credential.expiresAt)) throw new Error('freshness-expired');
      const deviceHeader = req.headers[DEVICE_HEADER];
      const device = Array.isArray(deviceHeader) ? deviceHeader[0] : deviceHeader;
      if (device && device !== credential.deviceHex) throw new Error('unauthorized');
      return credential;
    }

    const publication = createContentSnapshotPublication({
      store: snapshotStore,
      cipher: new ContentCipher({
        // Admission needs a current device whose identity matches the header.
        authorize(header) {
          const ledger = snapshotWriteLedger.getStore();
          if (!ledger) throw new ContentError({ code: 'unauthorized' });
          return Result.getOrThrowWith(contentAuthorKey(ledger.inspectState(), header), (e) => e);
        },
      }),
      now: hostNow,
      mayWriteDocument(author) {
        const ledger = snapshotWriteLedger.getStore();
        if (!ledger) return false;
        return deviceMayWriteDocument(ledger.inspectState(), author.device);
      },
    });

    async function proxy(
      req: IncomingMessage,
      res: ServerResponse,
      url: URL,
      preread?: Uint8Array
    ): Promise<void> {
      const dest = `${riverrun.baseUrl}${url.pathname}${url.search}`;
      const body =
        req.method === 'GET' || req.method === 'HEAD'
          ? undefined
          : (preread ?? (await readBody(req)));
      const headers = forwardedHeaders(req, ['content-type', 'stream-expected-offset']);
      const response = await httpFetch(dest, {
        method: req.method,
        headers,
        body: body === undefined ? undefined : Buffer.from(body),
      });
      const outHeaders: Record<string, string> = { 'Access-Control-Allow-Origin': '*' };
      response.headers.forEach((value, name) => {
        if (name === 'transfer-encoding') return;
        outHeaders[name] = value;
      });
      res.writeHead(response.status, outHeaders);
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      res.end(Buffer.from(await response.arrayBuffer()));
    }

    const server = createServer((req, res) => {
      void requestRun
        .run(
          Effect.promise((signal) =>
            requestSignal.run(signal, async () => {
              cors(res);
              const url = new URL(req.url ?? '/', `http://${hostName}`);
              if (req.method === 'OPTIONS') {
                res.writeHead(204);
                res.end();
                return;
              }
              const now = hostNow();
              const parts = pathParts(url);

              try {
                if (req.method === 'GET' && url.pathname === '/healthz') {
                  res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
                  return;
                }
                if (req.method === 'GET' && url.pathname === '/readyz') {
                  json(res, 200, { ok: true });
                  return;
                }
                if (req.method === 'POST' && url.pathname === '/v1/harness/clock') {
                  if (!harnessToken || bearer(req) !== harnessToken) {
                    json(res, 401, { error: 'unauthorized' });
                    return;
                  }
                  const payload = JSON.parse(new TextDecoder().decode(await readBody(req))) as {
                    now?: number | null;
                  };
                  meta.setNow(payload.now ?? null);
                  json(res, 200, { now: meta.now(wallClock) });
                  return;
                }
                if (req.method === 'POST' && url.pathname === '/v1/harness/failpoints') {
                  if (!harnessToken || bearer(req) !== harnessToken) {
                    json(res, 401, { error: 'unauthorized' });
                    return;
                  }
                  const payload = JSON.parse(new TextDecoder().decode(await readBody(req))) as {
                    name?: Failpoint;
                  };
                  meta.setFailpoint(payload.name ?? 'none');
                  json(res, 200, { name: meta.failpoint() });
                  return;
                }

                if (req.method === 'POST' && url.pathname === '/v1/credentials/challenge') {
                  const payload = JSON.parse(new TextDecoder().decode(await readBody(req))) as {
                    account?: string;
                    deviceHex?: string;
                  };
                  if (!payload.account || !payload.deviceHex) {
                    json(res, 400, { error: 'invalid-credential-request' });
                    return;
                  }
                  json(res, 200, {
                    nonce: meta.issueChallenge(payload.account, payload.deviceHex, now),
                  });
                  return;
                }

                if (req.method === 'POST' && url.pathname === '/v1/credentials') {
                  const payload = JSON.parse(new TextDecoder().decode(await readBody(req))) as {
                    account?: string;
                    deviceHex?: string;
                    nonce?: string;
                    signature?: string;
                    genesisHex?: string | null;
                    ttlMs?: number;
                  };
                  if (
                    !payload.account ||
                    !payload.deviceHex ||
                    !payload.nonce ||
                    !payload.signature
                  ) {
                    json(res, 400, { error: 'invalid-credential-request' });
                    return;
                  }
                  const ok =
                    meta.consumeChallenge(payload.nonce, payload.account, payload.deviceHex, now) &&
                    (await verifyPossession(
                      payload.account,
                      fromHex(payload.deviceHex),
                      payload.nonce,
                      fromHex(payload.signature)
                    ));
                  if (!ok) {
                    json(res, 403, { error: 'unauthorized' });
                    return;
                  }
                  const genesisHex = payload.genesisHex ?? null;
                  if (genesisHex) {
                    if (!meta.space(genesisHex)) {
                      json(res, 403, { error: 'unauthorized' });
                      return;
                    }
                    const ledger = await loadLedger(genesisHex);
                    if (!authorizeMembership(ledger.inspectState(), payload.deviceHex)) {
                      json(res, 403, { error: 'unauthorized' });
                      return;
                    }
                  }
                  const credential = meta.issueCredential({
                    account: payload.account,
                    deviceHex: payload.deviceHex,
                    genesisHex,
                    now,
                    ttlMs: payload.ttlMs,
                  });
                  json(res, 200, credential);
                  return;
                }

                if (req.method === 'POST' && url.pathname === '/v1/spaces') {
                  const credential = requireCredential(req, now);
                  const payload = JSON.parse(new TextDecoder().decode(await readBody(req))) as {
                    genesis?: string;
                  };
                  if (!payload.genesis) {
                    json(res, 400, { error: 'missing-genesis' });
                    return;
                  }
                  const genesis = fromHex(payload.genesis);
                  const decoded = decodeRecord(genesis);
                  if (decoded.body.type !== 'genesis') {
                    json(res, 400, { error: 'not-genesis' });
                    return;
                  }
                  if (toHex(decoded.body.fields.signer) !== credential.deviceHex) {
                    json(res, 403, { error: 'unauthorized' });
                    return;
                  }
                  const genesisHex = toHex(await hashRecord(genesis));
                  await runHostLedger(
                    Effect.gen(function* () {
                      const anchor = yield* Effect.fromResult(
                        Bytes.genesisHash(fromHex(genesisHex))
                      );
                      return yield* verifyLedger({ anchor, records: [genesis] }).pipe(
                        Effect.provide(signatureVerifierLayer)
                      );
                    })
                  );
                  const bucket = await httpFetch(
                    `${riverrun.baseUrl}/ds/${encodeURIComponent(genesisHex)}`,
                    {
                      method: 'PUT',
                    }
                  );
                  if (!bucket.ok && bucket.status !== 409) {
                    json(res, 502, { error: 'bucket-create-failed' });
                    return;
                  }
                  for (const stream of [CONTROL_STREAM, KEYS_STREAM, LORO_STREAM, FLOCK_STREAM]) {
                    await createStream(riverrun.baseUrl, genesisHex, stream, httpFetch);
                  }
                  meta.putSpace({ genesisHex, ownerDeviceHex: credential.deviceHex }, genesis);
                  meta.bindCredential(credential.token, genesisHex);
                  json(res, 200, { genesisHex, ownerDeviceHex: credential.deviceHex });
                  return;
                }

                if (
                  req.method === 'GET' &&
                  parts[0] === 'v1' &&
                  parts[1] === 'spaces' &&
                  parts[2]
                ) {
                  const genesisHex = parts[2]!;
                  requireCredential(req, now);
                  const space = meta.space(genesisHex);
                  if (!space) {
                    json(res, 404, { error: 'unknown-space' });
                    return;
                  }
                  if (parts[3] === 'genesis') {
                    json(res, 200, { genesis: toHex(space.genesis) });
                    return;
                  }
                  if (parts[3] === 'joins') {
                    const credential = requireCredential(req, now);
                    const ledger = await loadLedger(genesisHex);
                    if (
                      !authorizeCurrentMember({
                        state: ledger.inspectState(),
                        deviceHex: credential.deviceHex,
                        credentialGenesisHex: credential.genesisHex,
                        requestGenesisHex: genesisHex,
                      })
                    ) {
                      json(res, 403, { error: 'unauthorized' });
                      return;
                    }
                    json(res, 200, { requests: meta.joins(genesisHex) });
                    return;
                  }
                  if (parts[3] === 'notes') {
                    const credential = requireCredential(req, now);
                    const ledger = await loadLedger(genesisHex);
                    if (
                      !authorizeCurrentMember({
                        state: ledger.inspectState(),
                        deviceHex: credential.deviceHex,
                        credentialGenesisHex: credential.genesisHex,
                        requestGenesisHex: genesisHex,
                      })
                    ) {
                      json(res, 403, { error: 'unauthorized' });
                      return;
                    }
                    json(res, 200, { notes: meta.notes(genesisHex) });
                    return;
                  }
                }

                if (
                  req.method === 'POST' &&
                  parts[0] === 'v1' &&
                  parts[1] === 'spaces' &&
                  parts[2] &&
                  parts[3] === 'joins'
                ) {
                  const credential = requireCredential(req, now);
                  const genesisHex = parts[2]!;
                  if (!meta.space(genesisHex)) {
                    json(res, 404, { error: 'unknown-space' });
                    return;
                  }
                  const request = JSON.parse(
                    new TextDecoder().decode(await readBody(req))
                  ) as JoinRequestWire;
                  if (!authorizeJoinSigner(credential.deviceHex, request.signingPublicKey)) {
                    json(res, 403, { error: 'unauthorized' });
                    return;
                  }
                  if (!(await joinRequestSigned(genesisHex, request))) {
                    json(res, 400, { error: 'invalid-join-request' });
                    return;
                  }
                  if (!meta.putJoin(genesisHex, credential.account, request)) {
                    json(res, 409, { error: 'join-request-conflict' });
                    return;
                  }
                  json(res, 200, { ok: true });
                  return;
                }

                if (
                  req.method === 'POST' &&
                  parts[0] === 'v1' &&
                  parts[1] === 'spaces' &&
                  parts[2] &&
                  parts[3] === 'notes'
                ) {
                  const credential = requireCredential(req, now);
                  const genesisHex = parts[2]!;
                  const note = JSON.parse(
                    new TextDecoder().decode(await readBody(req))
                  ) as ComparisonWire;
                  if (
                    !note ||
                    note.noteSigner !== credential.deviceHex ||
                    note.genesis !== genesisHex
                  ) {
                    json(res, 403, { error: 'note-signer-mismatch' });
                    return;
                  }
                  const ledger = await loadLedger(genesisHex);
                  if (
                    !authorizeCurrentMember({
                      state: ledger.inspectState(),
                      deviceHex: credential.deviceHex,
                      credentialGenesisHex: credential.genesisHex,
                      requestGenesisHex: genesisHex,
                    })
                  ) {
                    json(res, 403, { error: 'unauthorized' });
                    return;
                  }
                  meta.putNote(genesisHex, credential.deviceHex, JSON.stringify(note));
                  json(res, 200, { ok: true });
                  return;
                }

                if (parts[0] === 'ds' && parts[1] && parts[2]) {
                  const genesisHex = parts[1];
                  const stream = parts[2];
                  const sub = parts[3];
                  const credential = requireCredential(req, now);
                  if (!isKnownStream(stream) || !meta.space(genesisHex)) {
                    json(res, 404, { error: 'unknown-stream' });
                    return;
                  }
                  const ledger = await loadLedger(genesisHex);
                  const decision = authorizeStreamRequest({
                    state: ledger.inspectState(),
                    deviceHex: credential.deviceHex,
                    credentialGenesisHex: credential.genesisHex,
                    requestGenesisHex: genesisHex,
                    stream,
                    method: req.method ?? '',
                    sub,
                  });
                  if (!decision.ok) {
                    json(res, decision.status, { error: decision.error });
                    return;
                  }
                  if (decision.action === 'keys-cas') {
                    const body = await readBody(req);
                    try {
                      assertEpochStreamAppend(
                        ledger.inspectState(),
                        fromHex(credential.deviceHex),
                        body
                      );
                    } catch {
                      json(res, 400, { error: 'invalid-epoch-envelope' });
                      return;
                    }
                    await proxy(req, res, url, body);
                    return;
                  }
                  if (decision.action === 'read' || decision.action === 'content-cas') {
                    await proxy(req, res, url);
                    return;
                  }

                  if (decision.action === 'control-cas') {
                    const body = await readBody(req);
                    const records = unframe(body);
                    if (records.length !== 1) {
                      json(res, 400, { error: 'single-record-required' });
                      return;
                    }
                    const record = records[0]!;
                    const decoded = decodeRecord(record);
                    if (decoded.body.type !== 'ordinary') {
                      json(res, 400, { error: 'not-ordinary' });
                      return;
                    }
                    if (toHex(decoded.body.fields.signer) !== credential.deviceHex) {
                      json(res, 403, { error: 'unauthorized' });
                      return;
                    }
                    const { ledger: current, tail } = await loadControl(genesisHex);
                    const operation = decoded.body.fields.operation;
                    if (operation.type === 'admitMember' && operation.request.expiresAt !== null) {
                      const digest = await hashRecord(record);
                      const alreadyCommitted = current.hasRecordHash(digest);
                      // Check sits immediately before extend+CAS. The Riverrun await
                      // below is still an async gap, not a cross-stream transaction.
                      if (!alreadyCommitted && now >= operation.request.expiresAt) {
                        json(res, 403, { error: 'join-expired' });
                        return;
                      }
                    }
                    await runHostLedger(
                      extendLedger(current, [record]).pipe(Effect.provide(signatureVerifierLayer))
                    );
                    const dest = `${riverrun.baseUrl}${url.pathname}${url.search}`;
                    // Only the verified head may be extended: never a client-chosen offset.
                    const headers = forwardedHeaders(req, ['content-type']);
                    headers.set('Stream-Expected-Offset', tail);
                    const response = await httpFetch(dest, {
                      method: 'POST',
                      headers,
                      body: Buffer.from(body),
                    });
                    if (response.status === 200 || response.status === 204) {
                      const fail = hostFailpoint();
                      if (fail === 'drop-control-ack') {
                        res.destroy();
                        return;
                      }
                      if (fail === 'hang-control-ack') {
                        disk.writeText(
                          join(options.dataDir, 'control-committed'),
                          `${toHex(await hashRecord(record))}\n`
                        );
                        return;
                      }
                      if (fail === 'kill-after-commit') {
                        disk.writeText(join(options.dataDir, 'killed-after-commit'), '1');
                        process.exit(0);
                      }
                    }
                    const outHeaders: Record<string, string> = {
                      'Access-Control-Allow-Origin': '*',
                    };
                    response.headers.forEach((value, name) => {
                      if (name === 'transfer-encoding') return;
                      outHeaders[name] = value;
                    });
                    res.writeHead(response.status, outHeaders);
                    res.end(Buffer.from(await response.arrayBuffer()));
                    return;
                  }

                  if (decision.action === 'snapshot-put' && parts[4]) {
                    const body = await readBody(req);
                    const offset = decodeURIComponent(parts[4]);
                    const headerDevice =
                      req.headers[SNAPSHOT_ADMISSION_DEVICE_HEADER.toLowerCase()];
                    const claimed =
                      (Array.isArray(headerDevice) ? headerDevice[0] : headerDevice) ??
                      credential.deviceHex;
                    if (claimed !== credential.deviceHex) {
                      json(res, 403, { error: 'snapshot-device-mismatch' });
                      return;
                    }
                    const fresh = await loadLedger(genesisHex);
                    if (!deviceMayWriteDocument(fresh.inspectState(), credential.deviceHex)) {
                      json(res, 403, { error: 'unauthorized' });
                      return;
                    }
                    if (
                      credential.expiresAt - credential.issuedAt >
                      CONTENT_SNAPSHOT_ADMISSION_WINDOW_MS
                    ) {
                      json(res, 403, { error: 'freshness-expired' });
                      return;
                    }
                    // Admission is durable; only admit an offset Riverrun can accept, i.e. a
                    // comparable position within the stream's current tail.
                    const head = await httpFetch(
                      `${riverrun.baseUrl}${url.pathname.replace(/\/snapshot\/[^/]*$/, '')}`,
                      {
                        method: 'HEAD',
                      }
                    );
                    const tail = head.headers.get('Stream-Next-Offset');
                    const order =
                      tail === null ? 'incomparable' : compareSnapshotOffsets(offset, tail);
                    if (!head.ok || order === 'incomparable' || order > 0) {
                      json(res, 400, { error: 'snapshot-offset-out-of-range' });
                      return;
                    }
                    const resource = stream === FLOCK_STREAM ? 'flock' : 'loro';
                    const admitted = await snapshotWriteLedger.run(fresh, () =>
                      publication.admit({
                        streamKey: `${genesisHex}/${stream}`,
                        offset,
                        body,
                        submittingDevice: credential.deviceHex,
                        leaseIssuedAt: credential.issuedAt,
                        leaseExpiresAt: credential.expiresAt,
                        expectedGenesis: genesisHex,
                        expectedResource: resource,
                      })
                    );
                    // An idempotent retry of an older snapshot must not move Riverrun's current back.
                    if (admitted.currentOffset !== offset) {
                      json(res, 409, {
                        error: 'snapshot-superseded',
                        currentOffset: admitted.currentOffset,
                      });
                      return;
                    }
                    const dest = `${riverrun.baseUrl}${url.pathname}${url.search}`;
                    const response = await httpFetch(dest, {
                      method: 'PUT',
                      headers: { 'Content-Type': req.headers['content-type'] ?? CONTENT_TYPE },
                      body: Buffer.from(body),
                    });
                    const outHeaders: Record<string, string> = {
                      'Access-Control-Allow-Origin': '*',
                    };
                    response.headers.forEach((value, name) => {
                      if (name === 'transfer-encoding') return;
                      outHeaders[name] = value;
                    });
                    res.writeHead(response.status, outHeaders);
                    res.end(Buffer.from(await response.arrayBuffer()));
                    return;
                  }

                  json(res, 403, { error: 'method-not-allowed' });
                  return;
                }

                json(res, 404, { error: 'not-found' });
              } catch (error) {
                const message = error instanceof Error ? error.message : 'error';
                const status =
                  message === 'unauthorized' || message === 'freshness-expired'
                    ? 401
                    : message.includes('unauthorized')
                      ? 403
                      : 400;
                json(res, status, { error: message });
              }
            })
          )
        )
        .catch((error: unknown) => {
          if (!res.writableEnded) res.destroy(error instanceof Error ? error : undefined);
        });
    });

    yield* Effect.acquireRelease(
      Effect.promise(
        () =>
          new Promise<void>((resolveListen, rejectListen) => {
            const failed = (error: Error) => rejectListen(error);
            server.once('error', failed);
            server.listen(options.port ?? 0, hostName, () => {
              server.off('error', failed);
              resolveListen();
            });
          })
      ),
      () =>
        Effect.promise(async () => {
          await requestRun.close();
          await new Promise<void>((resolveClose, rejectClose) => {
            // Native callbacks are interrupted before their transports are closed.
            server.close((error) => (error ? rejectClose(error) : resolveClose()));
            server.closeAllConnections();
          });
        })
    );
    const address = server.address() as AddressInfo;
    const baseUrl = `http://${hostName}:${address.port}`;
    disk.writeText(
      join(options.dataDir, 'host.json'),
      `${JSON.stringify(
        testMode
          ? {
              pid: process.pid,
              baseUrl,
              riverrunUrl: riverrun.baseUrl,
              riverrunDbPath,
            }
          : { pid: process.pid, baseUrl },
        null,
        2
      )}\n`
    );

    return {
      baseUrl,
      riverrunUrl: riverrun.baseUrl,
      harnessToken,
      setNow: (value: number | null) => meta.setNow(value),
      setFailpoint: (name: Failpoint) => meta.setFailpoint(name),
      dataDir: options.dataDir,
      riverrunDbPath,
      port: address.port,
    };
  });
}

/** Promise handle owns a persistent scope. It never escapes Effect.scoped. */
export async function startDemoHost(options: DemoHostOptions): Promise<RunningDemoHost> {
  const layer = Layer.mergeAll(
    Layer.succeed(LabFs, options.fs ?? makeLiveFs()),
    Layer.succeed(LabHttp, { fetch: options.fetch ?? globalThis.fetch.bind(globalThis) }),
    Layer.succeed(LabClock, makeLabClock(options.wallClock ?? (() => Date.now())))
  );
  const run = new LabRun(layer);
  try {
    const host = await run.run(acquireDemoHost(options));
    return { ...host, close: () => run.close() };
  } catch (error) {
    await run.close();
    throw error;
  }
}

export function resolveDataDir(input: string): string {
  return resolve(input);
}
