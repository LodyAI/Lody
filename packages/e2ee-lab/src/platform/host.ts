import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isAbsolute, join, resolve } from 'node:path';
import { startDevServer, type RunningDevServer } from '@loro-dev/sqlite-riverrun';
import { ContentCipher, Ledger } from '@lody/e2ee-core';
import { decodeRecord, hashRecord, SigningPointCache } from '@lody/e2ee-core/ledger';
import { SqliteSnapshotPublicationStore } from '@lody/e2ee-core/node-snapshot-publication-store';
import {
  CONTENT_SNAPSHOT_ADMISSION_WINDOW_MS,
  createContentSnapshotPublication,
  SNAPSHOT_ADMISSION_DEVICE_HEADER,
} from '@lody/e2ee-core/snapshot-admission';
import { deviceMayWriteDocument } from '@lody/e2ee-core/streams-content';
import { StreamsClient } from '@loro-dev/streams-client';
import { fromHex, toHex } from './bytes';
import { verifyPossession } from './device';
import { credentialExpired, HostMeta } from './host-meta';
import {
  AUTH_HEADER,
  CONTENT_TYPE,
  CONTROL_STREAM,
  DEVICE_HEADER,
  FLOCK_STREAM,
  KEYS_STREAM,
  LORO_STREAM,
  NOW_HEADER,
  type ComparisonWire,
  type Failpoint,
  type IssuedCredential,
  type JoinRequestWire,
} from './protocol';
import { makeLabClock } from '../services/clock';
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

async function createStream(riverrunUrl: string, bucket: string, stream: string): Promise<void> {
  const client = new StreamsClient({
    url: `${riverrunUrl}/ds/${encodeURIComponent(bucket)}/${encodeURIComponent(stream)}`,
    retry: { maxAttempts: 0 },
  });
  const created = await client.create({ contentType: CONTENT_TYPE });
  if (!created.ok) throw new Error(`create-stream-${stream}`);
}

export async function startDemoHost(options: DemoHostOptions): Promise<RunningDemoHost> {
  if (!isAbsolute(options.dataDir)) throw new Error('data-dir-must-be-absolute');
  const disk = options.fs ?? makeLiveFs();
  const httpFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  disk.mkdir(options.dataDir);
  const riverrunDbPath = join(options.dataDir, 'riverrun.sqlite');
  const meta = new HostMeta(join(options.dataDir, 'host.sqlite'));
  const snapshotPath = join(options.dataDir, 'snapshots.sqlite');
  const snapshotStore = disk.exists(snapshotPath)
    ? new SqliteSnapshotPublicationStore(snapshotPath)
    : new SqliteSnapshotPublicationStore(snapshotPath, { create: true });
  const wallClock = options.wallClock ?? makeLabClock(() => Date.now()).nowMs;
  const testMode = options.testMode === true;
  const hostName = options.host ?? '127.0.0.1';

  const riverrun: RunningDevServer = await startDevServer({
    host: '127.0.0.1',
    port: 0,
    dbPath: riverrunDbPath,
    protocol: 'http1',
  });

  const ledgers = new Map<string, Ledger>();
  // Host-scoped verification cache: no mutable cache state shared across runs.
  const pointCache = new SigningPointCache();

  async function loadLedger(genesisHex: string): Promise<Ledger> {
    const cached = ledgers.get(genesisHex);
    if (cached) return cached;
    const space = meta.space(genesisHex);
    if (!space) throw new Error('unknown-space');
    const genesis = space.genesis;
    const anchor = await hashRecord(genesis);
    let ledger = await Ledger.verify({ anchor, records: [genesis], pointCache });
    const client = new StreamsClient({
      url: `${riverrun.baseUrl}/ds/${encodeURIComponent(genesisHex)}/${CONTROL_STREAM}`,
      retry: { maxAttempts: 0 },
    });
    let offset = '-1';
    for (let page = 0; page < 256; page++) {
      const response = await client.read({ offset });
      if (!response.ok) throw new Error('control-read-failed');
      const body = response.result.payload.body;
      if (body.byteLength > 0) {
        for (const record of unframe(new Uint8Array(body))) {
          ledger = await ledger.extend([record], pointCache);
        }
      }
      offset = response.result.nextOffset;
      if (response.result.upToDate) break;
    }
    ledgers.set(genesisHex, ledger);
    return ledger;
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

  let admitGenesis = '';
  const publication = createContentSnapshotPublication({
    store: snapshotStore,
    cipher: new ContentCipher({
      authorize(header) {
        return header.device;
      },
    }),
    now: () => meta.now(wallClock),
    mayWriteDocument(author) {
      const ledger = ledgers.get(admitGenesis);
      if (!ledger) return false;
      return deviceMayWriteDocument(ledger.state, author.device);
    },
  });

  async function proxy(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const dest = `${riverrun.baseUrl}${url.pathname}${url.search}`;
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || name === 'host' || name === 'connection') continue;
      if (Array.isArray(value)) headers.set(name, value.join(', '));
      else headers.set(name, value);
    }
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
    void (async () => {
      cors(res);
      const url = new URL(req.url ?? '/', `http://${hostName}`);
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
      const nowHeader = req.headers[NOW_HEADER];
      if (testMode && typeof nowHeader === 'string' && /^(0|[1-9][0-9]*)$/.test(nowHeader)) {
        meta.setNow(Number(nowHeader));
      }
      const now = meta.now(wallClock);
      const parts = pathParts(url);

      try {
        if (req.method === 'GET' && url.pathname === '/healthz') {
          res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
          return;
        }
        if (req.method === 'GET' && url.pathname === '/readyz') {
          json(res, 200, {
            ok: true,
            riverrun: riverrun.baseUrl,
            riverrunDbPath,
            dataDir: options.dataDir,
          });
          return;
        }
        if (testMode && req.method === 'POST' && url.pathname === '/v1/clock') {
          const payload = JSON.parse(new TextDecoder().decode(await readBody(req))) as {
            now?: number | null;
          };
          meta.setNow(payload.now ?? null);
          json(res, 200, { now: meta.now(wallClock) });
          return;
        }
        if (testMode && req.method === 'POST' && url.pathname === '/v1/failpoints') {
          const payload = JSON.parse(new TextDecoder().decode(await readBody(req))) as {
            name?: Failpoint;
          };
          meta.setFailpoint(payload.name ?? 'none');
          json(res, 200, { name: meta.failpoint() });
          return;
        }

        if (req.method === 'POST' && url.pathname === '/v1/credentials') {
          const payload = JSON.parse(new TextDecoder().decode(await readBody(req))) as {
            account?: string;
            deviceHex?: string;
            signature?: string;
            genesisHex?: string | null;
            ttlMs?: number;
          };
          if (!payload.account || !payload.deviceHex || !payload.signature) {
            json(res, 400, { error: 'invalid-credential-request' });
            return;
          }
          const ok = await verifyPossession(
            payload.account,
            fromHex(payload.deviceHex),
            fromHex(payload.signature)
          );
          if (!ok) {
            json(res, 403, { error: 'unauthorized' });
            return;
          }
          const credential = meta.issueCredential({
            account: payload.account,
            deviceHex: payload.deviceHex,
            genesisHex: payload.genesisHex ?? null,
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
          const decoded = decodeRecord(genesis, pointCache);
          if (decoded.body.type !== 'genesis') {
            json(res, 400, { error: 'not-genesis' });
            return;
          }
          if (toHex(decoded.body.fields.signer) !== credential.deviceHex) {
            json(res, 403, { error: 'unauthorized' });
            return;
          }
          const genesisHex = toHex(await hashRecord(genesis));
          await Ledger.verify({ anchor: fromHex(genesisHex), records: [genesis], pointCache });
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
            await createStream(riverrun.baseUrl, genesisHex, stream);
          }
          meta.putSpace({ genesisHex, ownerDeviceHex: credential.deviceHex }, genesis);
          meta.bindCredential(credential.token, genesisHex);
          ledgers.set(
            genesisHex,
            await Ledger.verify({ anchor: fromHex(genesisHex), records: [genesis], pointCache })
          );
          json(res, 200, { genesisHex, ownerDeviceHex: credential.deviceHex });
          return;
        }

        if (req.method === 'GET' && parts[0] === 'v1' && parts[1] === 'spaces' && parts[2]) {
          const genesisHex = parts[2]!;
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
            requireCredential(req, now);
            json(res, 200, { requests: meta.joins(genesisHex) });
            return;
          }
          if (parts[3] === 'notes') {
            requireCredential(req, now);
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
          requireCredential(req, now);
          const request = JSON.parse(
            new TextDecoder().decode(await readBody(req))
          ) as JoinRequestWire;
          meta.putJoin(parts[2]!, request);
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
          const note = JSON.parse(new TextDecoder().decode(await readBody(req))) as ComparisonWire;
          if (!note || note.noteSigner !== credential.deviceHex || note.genesis !== genesisHex) {
            json(res, 403, { error: 'note-signer-mismatch' });
            return;
          }
          const ledger = await loadLedger(genesisHex);
          if (!ledger.state.devices.has(credential.deviceHex)) {
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
          const known =
            stream === CONTROL_STREAM ||
            stream === KEYS_STREAM ||
            stream === LORO_STREAM ||
            stream === FLOCK_STREAM;
          if (!known || !meta.space(genesisHex)) {
            json(res, 404, { error: 'unknown-stream' });
            return;
          }
          const credential = requireCredential(req, now);
          if (credential.genesisHex && credential.genesisHex !== genesisHex) {
            json(res, 403, { error: 'unauthorized' });
            return;
          }
          const isRead = req.method === 'GET' || req.method === 'HEAD';
          const isSnapshotGet = isRead && sub === 'snapshot';
          const isBootstrapGet = isRead && sub === 'bootstrap';
          const isStreamRead = isRead && sub === undefined;
          if (isStreamRead || isSnapshotGet || isBootstrapGet) {
            await proxy(req, res, url);
            return;
          }

          if (req.method === 'POST' && parts[3] === 'append-cas' && stream === CONTROL_STREAM) {
            const body = await readBody(req);
            const records = unframe(body);
            if (records.length !== 1) {
              json(res, 400, { error: 'single-record-required' });
              return;
            }
            const record = records[0]!;
            const decoded = decodeRecord(record, pointCache);
            if (decoded.body.type !== 'ordinary') {
              json(res, 400, { error: 'not-ordinary' });
              return;
            }
            if (toHex(decoded.body.fields.signer) !== credential.deviceHex) {
              json(res, 403, { error: 'unauthorized' });
              return;
            }
            const current = await loadLedger(genesisHex);
            const next = await current.extend([record]);
            const dest = `${riverrun.baseUrl}${url.pathname}${url.search}`;
            const headers = new Headers();
            for (const [name, value] of Object.entries(req.headers)) {
              if (value === undefined || name === 'host' || name === 'connection') continue;
              if (Array.isArray(value)) headers.set(name, value.join(', '));
              else headers.set(name, value);
            }
            const response = await httpFetch(dest, {
              method: 'POST',
              headers,
              body: Buffer.from(body),
            });
            if (response.status === 200 || response.status === 204) {
              ledgers.set(genesisHex, next);
              const fail = meta.failpoint();
              if (fail === 'drop-control-ack') {
                res.destroy();
                return;
              }
              if (fail === 'kill-after-commit') {
                disk.writeText(join(options.dataDir, 'killed-after-commit'), '1');
                process.exit(0);
              }
            }
            const outHeaders: Record<string, string> = { 'Access-Control-Allow-Origin': '*' };
            response.headers.forEach((value, name) => {
              if (name === 'transfer-encoding') return;
              outHeaders[name] = value;
            });
            res.writeHead(response.status, outHeaders);
            res.end(Buffer.from(await response.arrayBuffer()));
            return;
          }

          if (req.method === 'POST' && parts[3] === 'append-cas' && stream === KEYS_STREAM) {
            const ledger = await loadLedger(genesisHex);
            const device = ledger.state.devices.get(credential.deviceHex);
            const member = device
              ? ledger.state.members.get(toHex(device.membershipId))
              : undefined;
            if (
              !device ||
              device.kind !== 'personal' ||
              !device.canManage ||
              (member?.role !== 'owner' && member?.role !== 'admin')
            ) {
              json(res, 403, { error: 'unauthorized' });
              return;
            }
            await proxy(req, res, url);
            return;
          }

          if (req.method === 'PUT' && parts[3] === 'snapshot' && parts[4]) {
            const body = await readBody(req);
            const offset = decodeURIComponent(parts[4]);
            const headerDevice = req.headers[SNAPSHOT_ADMISSION_DEVICE_HEADER.toLowerCase()];
            const claimed =
              (Array.isArray(headerDevice) ? headerDevice[0] : headerDevice) ??
              credential.deviceHex;
            if (claimed !== credential.deviceHex) {
              json(res, 403, { error: 'snapshot-device-mismatch' });
              return;
            }
            const ledger = await loadLedger(genesisHex);
            if (!deviceMayWriteDocument(ledger.state, credential.deviceHex)) {
              json(res, 403, { error: 'unauthorized' });
              return;
            }
            if (credential.expiresAt - credential.issuedAt > CONTENT_SNAPSHOT_ADMISSION_WINDOW_MS) {
              json(res, 403, { error: 'freshness-expired' });
              return;
            }
            const resource = stream === FLOCK_STREAM ? 'flock' : 'loro';
            admitGenesis = genesisHex;
            await publication.admit({
              streamKey: `${genesisHex}/${stream}`,
              offset,
              body,
              submittingDevice: credential.deviceHex,
              leaseIssuedAt: credential.issuedAt,
              leaseExpiresAt: credential.expiresAt,
              expectedGenesis: genesisHex,
              expectedResource: resource,
            });
            const dest = `${riverrun.baseUrl}${url.pathname}${url.search}`;
            const response = await httpFetch(dest, {
              method: 'PUT',
              headers: { 'Content-Type': req.headers['content-type'] ?? CONTENT_TYPE },
              body: Buffer.from(body),
            });
            const outHeaders: Record<string, string> = { 'Access-Control-Allow-Origin': '*' };
            response.headers.forEach((value, name) => {
              if (name === 'transfer-encoding') return;
              outHeaders[name] = value;
            });
            res.writeHead(response.status, outHeaders);
            res.end(Buffer.from(await response.arrayBuffer()));
            return;
          }

          if (
            req.method === 'POST' &&
            (sub === undefined || sub === 'append-cas') &&
            (stream === LORO_STREAM || stream === FLOCK_STREAM)
          ) {
            const ledger = await loadLedger(genesisHex);
            if (!deviceMayWriteDocument(ledger.state, credential.deviceHex)) {
              json(res, 403, { error: 'unauthorized' });
              return;
            }
            await proxy(req, res, url);
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
    })();
  });

  await new Promise<void>((resolveListen) => {
    server.listen(options.port ?? 0, hostName, () => resolveListen());
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://${hostName}:${address.port}`;
  disk.writeText(
    join(options.dataDir, 'host.json'),
    `${JSON.stringify({ pid: process.pid, baseUrl, riverrunUrl: riverrun.baseUrl, riverrunDbPath }, null, 2)}\n`
  );

  return {
    baseUrl,
    riverrunUrl: riverrun.baseUrl,
    dataDir: options.dataDir,
    riverrunDbPath,
    port: address.port,
    async close() {
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      });
      await riverrun.close();
      meta.close();
    },
  };
}

export function resolveDataDir(input: string): string {
  return resolve(input);
}
