import { Data, Effect, Result } from 'effect';
import { Bytes } from '@lody/e2ee-core';
import type { LedgerView } from '@lody/e2ee-core';
import type { LabCredential } from './credentials';
import { authorizeLabStream } from './gateway';
import { makeLabOperations } from './operation-scope';
import { readBoundedBody } from './bounded-body';

export class LabStreamReadError extends Data.TaggedError('LabStreamReadError')<{
  readonly status: 400 | 403 | 404 | 413 | 502 | 503;
}> {}
const refuse = (status: LabStreamReadError['status']) => new LabStreamReadError({ status });
const hasControlCharacter = (value: string) =>
  Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
/** Owned buffered transport reply, not ledger/content/snapshot authority. The
 * released SDK and public client verifier still own payload admission/cursors. */
export class LabStreamReply extends Data.TaggedClass('LabStreamReply')<{
  readonly status: number;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly body: Uint8Array;
}> {}
const replyHeaders = [
  'content-type',
  'stream-next-offset',
  'stream-snapshot-offset',
  'stream-up-to-date',
  'stream-closed',
  'stream-cursor',
  'stream-extensions',
];
/** Finite read-only local transport. Host supplies actual stored-bearer identity
 * and an independently selected genuine current view. Request headers/URLs never
 * select upstream origin, identity, current authority or snapshot endorsement.
 * Buffer the bounded full body in the same raw lease; abort AND await it before
 * closing the earlier native transport owner. No legacy global keys stream. */
export function makeLabStreamReader(input: {
  readonly genesis: Bytes.GenesisHash;
  readonly baseUrl: string;
  readonly ledger: (signal: AbortSignal) => Effect.Effect<LedgerView, unknown>;
  readonly maxBytes: number;
  readonly fetch?: typeof fetch;
}) {
  return Effect.gen(function* () {
    const anchor = yield* Effect.fromResult(Bytes.genesisHash(input.genesis.toBytes()));
    const org = Buffer.from(anchor.toBytes()).toString('hex');
    const source = yield* Effect.try({
      try: () => {
        const url = new URL(input.baseUrl);
        if (
          url.protocol !== 'http:' ||
          !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
          url.username ||
          url.password ||
          url.pathname !== '/' ||
          url.search ||
          url.hash
        )
          throw refuse(400);
        return url.origin;
      },
      catch: () => refuse(400),
    });
    const maxBytes = input.maxBytes,
      ledger = input.ledger,
      transport = input.fetch ?? fetch;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024)
      return yield* refuse(400);
    const operations = yield* makeLabOperations();
    const guard = () => {
      if (operations.signal.aborted) throw refuse(503);
    };
    return Object.freeze({
      read: (request: {
        readonly credential: LabCredential;
        readonly method: string;
        readonly stream: string;
        readonly sub?: string;
        readonly snapshotOffset?: string;
        readonly query: string;
      }) =>
        operations.run(
          Effect.gen(function* () {
            const captured = yield* Effect.try({
              try: () => {
                guard();
                if (
                  !['GET', 'HEAD'].includes(request.method) ||
                  !['control', 'loro', 'flock'].includes(request.stream) ||
                  ![undefined, 'bootstrap', 'snapshot'].includes(request.sub)
                )
                  throw refuse(404);
                const snapshotOffset = request.snapshotOffset;
                if (
                  snapshotOffset !== undefined &&
                  (request.sub !== 'snapshot' ||
                    !snapshotOffset.length ||
                    snapshotOffset.length > 256 ||
                    hasControlCharacter(snapshotOffset) ||
                    snapshotOffset === '.' ||
                    snapshotOffset === '..')
                )
                  throw refuse(400);
                const parameters = new URLSearchParams(request.query);
                for (const [key, value] of parameters) {
                  if (
                    !['offset', 'cursor'].includes(key) ||
                    parameters.getAll(key).length !== 1 ||
                    !value.length ||
                    value.length > 256 ||
                    hasControlCharacter(value)
                  )
                    throw refuse(400);
                }
                if ((request.method === 'HEAD' || request.sub !== undefined) && parameters.size)
                  throw refuse(400);
                const device = Result.getOrThrow(
                  Bytes.signingPublicKey(request.credential.device.toBytes())
                );
                const bound =
                  request.credential.genesis === null
                    ? null
                    : Result.getOrThrow(Bytes.genesisHash(request.credential.genesis.toBytes()));
                return {
                  device,
                  bound,
                  method: request.method,
                  stream: request.stream,
                  sub: request.sub,
                  snapshotOffset,
                  query: parameters.toString(),
                };
              },
              catch: (error) => (error instanceof LabStreamReadError ? error : refuse(400)),
            });
            const authorize = () =>
              Effect.gen(function* () {
                yield* Effect.try({ try: guard, catch: () => refuse(503) });
                const view = yield* Effect.uninterruptible(ledger(operations.signal));
                yield* Effect.fromResult(
                  authorizeLabStream({
                    view,
                    authenticatedCredential: { device: captured.device, genesis: captured.bound },
                    requestGenesis: anchor,
                    method: captured.method,
                    stream: captured.stream,
                    sub: captured.sub,
                  })
                );
                yield* Effect.try({ try: guard, catch: () => refuse(503) });
              });
            yield* authorize();
            const url = `${source}/ds/${org}/${captured.stream}${captured.sub ? '/' + captured.sub : ''}${captured.snapshotOffset !== undefined ? '/' + encodeURIComponent(captured.snapshotOffset) : ''}${captured.query ? '?' + captured.query : ''}`;
            const result = yield* Effect.uninterruptible(
              Effect.tryPromise({
                try: async () => {
                  guard();
                  let response = await transport(url, {
                    method: captured.method,
                    redirect: 'manual',
                    signal: operations.signal,
                    headers: { accept: '*/*' },
                  });
                  if (response.status === 307) {
                    let target: URL | undefined;
                    try {
                      if (
                        captured.method !== 'GET' ||
                        captured.sub !== 'snapshot' ||
                        captured.snapshotOffset !== undefined
                      )
                        throw refuse(502);
                      const location = response.headers.get('location');
                      if (!location) throw refuse(502);
                      target = new URL(location, url);
                      const prefix = `/ds/${org}/${captured.stream}/snapshot/`,
                        encoded = target.pathname.slice(prefix.length);
                      const offset = decodeURIComponent(encoded);
                      if (
                        target.origin !== source ||
                        target.username ||
                        target.password ||
                        target.search ||
                        target.hash ||
                        !target.pathname.startsWith(prefix) ||
                        !offset.length ||
                        offset.length > 256 ||
                        hasControlCharacter(offset) ||
                        target.pathname !== prefix + encodeURIComponent(offset)
                      )
                        throw refuse(502);
                    } finally {
                      await response.body?.cancel();
                    }
                    response = await transport(target.href, {
                      method: 'GET',
                      redirect: 'manual',
                      signal: operations.signal,
                      headers: { accept: '*/*' },
                    });
                  }
                  if (
                    response.status < 200 ||
                    response.status > 599 ||
                    (response.status >= 300 && response.status < 400)
                  ) {
                    await response.body?.cancel();
                    throw refuse(502);
                  }
                  const bytes = response.body
                    ? await readBoundedBody(response.body, maxBytes)
                    : new Uint8Array();
                  if (bytes === undefined) throw refuse(413);
                  const headers: Array<readonly [string, string]> = [];
                  for (const name of replyHeaders) {
                    const value = response.headers.get(name);
                    if (value !== null) {
                      if (value.length > 1024) throw refuse(502);
                      headers.push([name, value]);
                    }
                  }
                  return new LabStreamReply({
                    status: response.status,
                    headers,
                    body: bytes,
                  });
                },
                catch: (error) => (error instanceof LabStreamReadError ? error : refuse(502)),
              })
            );
            // A role/kind change while transport settles cannot deliver a late authorized
            // payload. These checks do not turn remote headers into a trusted endpoint.
            yield* authorize();
            return result;
          })
        ),
    });
  });
}
