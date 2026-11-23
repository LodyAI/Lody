import { Data, Effect, Semaphore } from 'effect';
import { Bytes } from '@lody/e2ee-core';
import { type LedgerView } from '@lody/e2ee-core';
import { contentPermissions, requireLedgerContinuation } from '@lody/e2ee-core/protocol';
import {
  admitStreamsSnapshot,
  admitStreamsSnapshotEffect,
  authenticateStreamsSnapshotEffect,
  admitStreamsUpdateBatch,
  admitStreamsUpdateBatchEffect,
} from '@lody/e2ee-core/host';
import {
  snapshotPublicationDigest,
  type makeSqliteSnapshotPublication,
} from '@lody/e2ee-core/adapters/node-sqlite';
import type { LabCredential } from './credentials';
import { makeLabOperations } from './operation-scope';
import { makeLabSdkOwner } from './sdk-owner';
import { LabStreamReply } from './stream-read';
import { readBoundedBody } from './bounded-body';
export class LabContentGatewayError extends Data.TaggedError('LabContentGatewayError')<{
  readonly status: 400 | 403 | 409 | 413 | 502;
}> {}
const MAX_BODY = 16 * 1024 * 1024;
const equal = (left: Uint8Array, right: Uint8Array) => Buffer.compare(left, right) === 0;
type Request = {
  readonly credential: LabCredential;
  readonly requestGenesis: Bytes.GenesisHash;
  readonly body: Uint8Array;
};
/** One host owner for this fixed resource/model. The same owner serializes all
 * native writes; snapshot originals are durable before PUT. No cross-store atomicity. */
export const makeLabContentGateway = Effect.fnUntraced(function* (input: {
  readonly genesis: Bytes.GenesisHash;
  readonly resource: string;
  readonly model: 'loro' | 'flock';
  readonly baseUrl: string;
  readonly ledger: () => Effect.Effect<LedgerView, unknown>;
  readonly fetch?: typeof fetch;
  /** Trusted native-store observation: exact actual record boundary at or before
   * its current head. The opaque token must never be ordered by this gateway. */
  readonly snapshotBoundary?: (offset: string) => Effect.Effect<boolean, unknown>;
  readonly snapshotStore?: Effect.Success<ReturnType<typeof makeSqliteSnapshotPublication>>;
  /** Existing credential clock, captured once; required with snapshotStore. Not strict B. */
  readonly now?: () => number;
}) {
  const anchor = yield* Effect.fromResult(Bytes.genesisHash(input.genesis.toBytes()));
  const resource = input.resource,
    model = input.model,
    ledger = input.ledger,
    transport = input.fetch ?? fetch,
    store = input.snapshotStore,
    snapshotBoundary = input.snapshotBoundary,
    now = input.now;
  if (store && (typeof now !== 'function' || typeof snapshotBoundary !== 'function'))
    return yield* new LabContentGatewayError({ status: 400 });
  const url = yield* Effect.try({
    try: () => {
      const origin = new URL(input.baseUrl);
      if (
        origin.protocol !== 'http:' ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) ||
        origin.username ||
        origin.password ||
        origin.pathname !== '/' ||
        origin.search ||
        origin.hash ||
        !resource ||
        !['loro', 'flock'].includes(model)
      )
        throw new Error('configuration');
      return `${origin.origin}/ds/${Buffer.from(anchor.toBytes()).toString('hex')}/${model}`;
    },
    catch: () => new LabContentGatewayError({ status: 400 }),
  });
  const native = yield* makeLabSdkOwner(() => ({ close: async () => undefined }));
  const operations = yield* makeLabOperations(),
    serial = yield* Semaphore.make(1);
  let observed: LedgerView | undefined;
  const current = Effect.fnUntraced(function* () {
    const view = yield* ledger();
    yield* Effect.fromResult(requireLedgerContinuation(view, view));
    if (!view.genesis.equals(anchor)) return yield* new LabContentGatewayError({ status: 403 });
    if (observed) yield* Effect.fromResult(requireLedgerContinuation(observed, view));
    observed = view;
    return view;
  });
  const capture = (request: Request) =>
    Effect.gen(function* () {
      const principal = yield* Effect.fromResult(
        Bytes.signingPublicKey(request.credential.device.toBytes())
      );
      const requested = yield* Effect.fromResult(
        Bytes.genesisHash(request.requestGenesis.toBytes())
      );
      if (!requested.equals(anchor) || !request.credential.genesis?.equals(anchor))
        return yield* new LabContentGatewayError({ status: 403 });
      if (!(request.body instanceof Uint8Array) || request.body.length > MAX_BODY)
        return yield* new LabContentGatewayError({ status: 413 });
      return {
        principal,
        body: new Uint8Array(request.body),
        issuedAt: request.credential.issuedAt,
        expiresAt: request.credential.expiresAt,
      };
    });
  const invoke = (target: string, method: 'HEAD' | 'GET' | 'PUT' | 'POST', body?: Uint8Array) =>
    native.invoke(async () => {
      const reply = await transport(target, {
        method,
        headers: { 'content-type': 'application/octet-stream' },
        body: body ? Buffer.from(body) : undefined,
        redirect: 'manual',
        signal: AbortSignal.any([native.signal, operations.signal]),
      });
      const bytes = reply.body
        ? await readBoundedBody(reply.body, method === 'GET' ? MAX_BODY : 64 * 1024)
        : new Uint8Array();
      if (bytes === undefined) throw new LabContentGatewayError({ status: 502 });
      return new LabStreamReply({
        status: reply.status,
        body: bytes,
        headers: [
          'content-type',
          'stream-next-offset',
          'stream-snapshot-offset',
          'stream-closed',
          'location',
        ].flatMap((name) => {
          const value = reply.headers.get(name);
          return value === null ? [] : [[name, value] as const];
        }),
      });
    });
  const header = (reply: LabStreamReply, name: string) =>
    reply.headers.find(([key]) => key === name)?.[1];
  const latest = Effect.fnUntraced(function* () {
    let reply = yield* invoke(`${url}/snapshot`, 'GET');
    if (reply.status === 404) return null;
    if (reply.status === 307) {
      const target = yield* Effect.try({
        try: () => {
          const location = header(reply, 'location');
          if (!location) throw new Error('missing snapshot redirect');
          const redirected = new URL(location, `${url}/snapshot`),
            origin = new URL(url);
          const prefix = `${origin.pathname}/snapshot/`;
          if (
            redirected.origin !== origin.origin ||
            redirected.username ||
            redirected.password ||
            redirected.search ||
            redirected.hash ||
            !redirected.pathname.startsWith(prefix)
          )
            throw new Error('snapshot redirect context');
          const encoded = redirected.pathname.slice(prefix.length),
            offset = decodeURIComponent(encoded);
          if (!offset || offset.length > 509 || encoded !== encodeURIComponent(offset))
            throw new Error('snapshot redirect position');
          return redirected.href;
        },
        catch: () => new LabContentGatewayError({ status: 502 }),
      });
      reply = yield* invoke(target, 'GET');
    }
    const offset = header(reply, 'stream-snapshot-offset');
    if (reply.status !== 200 || !offset) return yield* new LabContentGatewayError({ status: 502 });
    return { offset, body: reply.body };
  });
  const receipt = Effect.fnUntraced(function* () {
    if (!store) return yield* new LabContentGatewayError({ status: 502 });
    const accepted = yield* store.current();
    return new LabStreamReply({
      status: 204,
      body: new Uint8Array(),
      headers: accepted ? [['stream-snapshot-offset', accepted.offset]] : [],
    });
  });
  const write = (request: Request & { readonly method: 'PUT' | 'POST' }) =>
    operations.run(
      serial.withPermit(
        Effect.gen(function* () {
          const { principal, body } = yield* capture(request),
            method = request.method;
          if (!['PUT', 'POST'].includes(method) || (method === 'PUT' && body.length))
            return yield* new LabContentGatewayError({ status: 403 });
          const authorize = Effect.fnUntraced(function* (nativeSignature: boolean) {
            const view = yield* current(),
              permission = yield* Effect.fromResult(contentPermissions(view, principal));
            if (!permission.mayWriteDocument)
              return yield* new LabContentGatewayError({ status: 403 });
            if (method === 'POST') {
              const admission = { genesis: anchor, resource, model, view, device: principal, body };
              if (nativeSignature) yield* admitStreamsUpdateBatchEffect(admission);
              else yield* Effect.fromResult(admitStreamsUpdateBatch(admission));
            }
            return undefined;
          });
          yield* authorize(true);
          yield* authorize(false);
          return yield* invoke(url, method, method === 'POST' ? body : undefined);
        })
      )
    );
  const snapshot = (request: Request & { readonly continuationOffset: string }) =>
    operations.run(
      serial.withPermit(
        Effect.gen(function* () {
          if (!store || !now || !snapshotBoundary)
            return yield* new LabContentGatewayError({ status: 502 });
          const { principal, body, issuedAt, expiresAt } = yield* capture(request),
            offset = request.continuationOffset,
            signer = Buffer.from(principal.toBytes()).toString('hex');
          const credentialsValid = (
            lease: { readonly issuedAt: number; readonly expiresAt: number } = {
              issuedAt,
              expiresAt,
            }
          ) =>
            Effect.suspend(() => {
              const time = now();
              return Number.isSafeInteger(time) &&
                Number.isSafeInteger(lease.issuedAt) &&
                Number.isSafeInteger(lease.expiresAt) &&
                lease.issuedAt <= time &&
                time < lease.expiresAt
                ? Effect.void
                : Effect.fail(new LabContentGatewayError({ status: 403 }));
            });
          const admission = (view: LedgerView) => ({
            genesis: anchor,
            resource,
            model,
            view,
            device: principal,
            body,
            continuationOffset: offset,
          });
          let row = yield* store.lookup(offset);
          if (row && (row.signer !== signer || row.digest !== snapshotPublicationDigest(body)))
            return yield* new LabContentGatewayError({ status: 409 });
          const view = yield* current();
          // Receipt bytes do not authenticate a retry; the original signer and exact
          // historical signature/context still have to match this authenticated device.
          yield* authenticateStreamsSnapshotEffect(admission(view));
          if (!(yield* snapshotBoundary(offset)))
            return yield* new LabContentGatewayError({ status: 409 });
          if (row?.phase === 'Accepted') return yield* receipt();
          const remote = yield* latest();
          if (remote?.offset === offset) {
            if (!equal(remote.body, body))
              return yield* new LabContentGatewayError({ status: 409 });
            if (!row) {
              // Importing an unrecorded native snapshot is a new admission, not an old
              // receipt. Require current permission and the original credential cutoff.
              yield* credentialsValid();
              yield* admitStreamsSnapshotEffect(admission(yield* current()));
              const fresh = yield* current();
              yield* credentialsValid();
              yield* Effect.fromResult(admitStreamsSnapshot(admission(fresh)));
              row = yield* store.reserve({ offset, signer, body, issuedAt, expiresAt });
            }
            yield* store.accept(row);
            return yield* receipt();
          }
          yield* credentialsValid();
          if (row) yield* credentialsValid(row);
          yield* admitStreamsSnapshotEffect(admission(yield* current()));
          const tail = yield* invoke(url, 'HEAD');
          if (tail.status !== 200 || !(yield* snapshotBoundary(offset)))
            return yield* new LabContentGatewayError({ status: 409 });
          if (!row) row = yield* store.reserve({ offset, signer, body, issuedAt, expiresAt });
          // HEAD and fixed native verification awaited: recheck the genuine current
          // epoch/writer and original credential window immediately before dispatch.
          const fresh = yield* current();
          yield* credentialsValid();
          yield* credentialsValid(row);
          yield* Effect.fromResult(admitStreamsSnapshot(admission(fresh)));
          if (row.body === null) return yield* new LabContentGatewayError({ status: 409 });
          const reply = yield* invoke(
            `${url}/snapshot/${encodeURIComponent(offset)}`,
            'PUT',
            row.body
          );
          if (reply.status < 200 || reply.status >= 300) return reply;
          if (!(yield* snapshotBoundary(row.offset)))
            return yield* new LabContentGatewayError({ status: 409 });
          const stored = yield* latest();
          if (!stored || stored.offset !== row.offset || !equal(stored.body, row.body))
            return yield* new LabContentGatewayError({ status: 502 });
          yield* store.accept(row);
          return yield* receipt();
        })
      )
    );
  const resumeSnapshot = (request: Omit<Request, 'body'>) =>
    operations.run(
      serial.withPermit(
        Effect.gen(function* () {
          if (!store || !snapshotBoundary)
            return yield* new LabContentGatewayError({ status: 502 });
          const { principal } = yield* capture({ ...request, body: new Uint8Array() });
          const row = yield* store.pending();
          if (!row) return yield* receipt();
          if (row.signer !== Buffer.from(principal.toBytes()).toString('hex'))
            return yield* new LabContentGatewayError({ status: 403 });
          yield* authenticateStreamsSnapshotEffect({
            genesis: anchor,
            resource,
            model,
            view: yield* current(),
            device: principal,
            body: row.body,
            continuationOffset: row.offset,
          });
          if (!(yield* snapshotBoundary(row.offset)))
            return yield* new LabContentGatewayError({ status: 409 });
          const stored = yield* latest();
          if (!stored || stored.offset !== row.offset || !equal(stored.body, row.body))
            return yield* new LabContentGatewayError({ status: 502 });
          yield* store.accept(row);
          return yield* receipt();
        })
      )
    );
  return Object.freeze({ write, snapshot, resumeSnapshot });
});
