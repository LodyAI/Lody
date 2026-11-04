import { mkdirSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { startDevServer } from '@loro-dev/sqlite-riverrun';
import { Context, Data, Effect, Exit, Scope } from 'effect';
import { Bytes } from '@lody/e2ee-core';
import type { LedgerCheckpoint } from '@lody/e2ee-core';
import { makeSqliteKeyMailbox, MailboxError } from '@lody/e2ee-core/adapters/node-sqlite';
import { makeSqliteSnapshotPublication } from '@lody/e2ee-core/adapters/node-sqlite';
import { makeLabWorkspaceRegistry } from './workspace-registry';
import { makeLabWorkspaceCreation } from './workspace-creation';
import { makeLabCredentials } from './credentials';
import { makeLabControlGateway } from './control-gateway';
import { makeLabStreamReader } from './stream-read';
import { makeLabContentGateway } from './content-gateway';
import { makeLabJoinMailbox } from './join-mailbox';
import { makeLabHttpHost } from './host';
import { makeLabEpochStaging } from './epoch-staging';
import { makeLabRiverrunSnapshotBoundary } from './snapshot-boundary';

export class LabHostSessionError extends Data.TaggedError('LabHostSessionError')<{
  readonly code: 'configuration';
}> {}
/** Native local server port. Instrumentation may wrap actual close/settlement;
 * it does not provide ledger acceptance, credentials or a second host kernel. */
export const LabHostNativeServer = Context.Reference<typeof startDevServer>(
  'Lab/HostNativeServer',
  {
    defaultValue: () => startDevServer,
  }
);

/** One synthetic local host owner: real Riverrun, durable metadata and HTTP.
 * Reopen requires a separately retained minimum; SQLite never chooses its own
 * freshness qualification. No signer, private key or production protector enters
 * this composition. Every earlier owner outlives its HTTP/native borrowers. */
export const makeLabHostSession = Effect.fn('Lab.makeHostSession')(function* (input: {
  readonly directory: string;
  readonly mode: 'create' | 'open';
  readonly genesisRecord: Uint8Array;
  readonly minimum?: LedgerCheckpoint;
  readonly now: () => number;
  readonly resources: { readonly loro: string; readonly flock: string };
  /** Reuse the previous public loopback port when client files retain stream URLs. */
  readonly port?: number;
  /** Explicit native instrumentation/transport; never an authority callback. */
  readonly fetch?: typeof fetch;
  readonly budget: { readonly maxRecords: number; readonly maxBytes: number };
}) {
  const directory = input.directory,
    mode = input.mode,
    now = input.now,
    transport = input.fetch,
    port = input.port,
    resources = { loro: input.resources.loro, flock: input.resources.flock },
    budget = { ...input.budget },
    genesisRecord = new Uint8Array(input.genesisRecord);
  const minimum = input.minimum
    ? {
        head: yield* Effect.fromResult(Bytes.recordHash(input.minimum.head.toBytes())),
        length: input.minimum.length,
      }
    : undefined;
  if (
    !isAbsolute(directory) ||
    (mode !== 'create' && mode !== 'open') ||
    (mode === 'open' && !minimum) ||
    (port !== undefined && (!Number.isSafeInteger(port) || port < 0 || port > 65535)) ||
    !/^[!-~]{1,1024}$/.test(resources.loro) ||
    !/^[!-~]{1,1024}$/.test(resources.flock)
  )
    return yield* new LabHostSessionError({ code: 'configuration' });
  yield* Effect.try({
    try: () => {
      if (mode === 'create') mkdirSync(directory, { mode: 0o700 });
      else if (!statSync(join(directory, 'riverrun.sqlite')).isFile())
        throw new LabHostSessionError({ code: 'configuration' });
    },
    catch: () => new LabHostSessionError({ code: 'configuration' }),
  });
  const scope = yield* Scope.make();
  const close = yield* Effect.cached(Scope.close(scope, Exit.void));
  yield* Effect.addFinalizer(() => close);
  return yield* Scope.provide(
    Effect.gen(function* () {
      const startNative = yield* LabHostNativeServer;
      // Acquired first, released last, after every gateway and HTTP callback.
      const native = yield* Effect.acquireRelease(
        Effect.uninterruptible(
          Effect.tryPromise({
            try: () =>
              startNative({
                host: '127.0.0.1',
                port: 0,
                protocol: 'http1',
                dbPath: join(directory, 'riverrun.sqlite'),
              }),
            catch: (cause) => cause,
          })
        ),
        (server) => Effect.promise(() => server.close())
      );
      const registry = yield* makeLabWorkspaceRegistry({
        path: join(directory, 'registry.sqlite'),
        mode,
      });
      const creation = yield* makeLabWorkspaceCreation({
        path: join(directory, 'creation.sqlite'),
        mode,
        genesisRecord,
        minimum,
        baseUrl: native.baseUrl,
        registry,
        budget,
        fetch: transport,
      });
      // A real CAS can commit before its host checkpoint/ACK. Reconcile the actual
      // remote signed history even when the old floor already matches the minimum.
      if (mode === 'open') yield* creation.refresh();
      const ledger = () => creation.refresh().pipe(Effect.map((current) => current.view));
      const credentials = yield* makeLabCredentials({
        path: join(directory, 'credentials.sqlite'),
        mode,
        now,
        ledger: (anchor) =>
          anchor.equals(creation.genesis)
            ? ledger()
            : Effect.fail(new LabHostSessionError({ code: 'configuration' })),
      });
      const mailbox = yield* makeSqliteKeyMailbox({
        path: join(directory, 'mailbox.sqlite'),
        mode,
        genesis: creation.genesis,
        ledger: () => ledger().pipe(Effect.mapError(() => new MailboxError({ code: 'corrupt' }))),
      });
      const joins = yield* makeLabJoinMailbox({
        path: join(directory, 'joins.sqlite'),
        mode,
        genesis: creation.genesis,
        ledger,
      });
      const staging = yield* makeLabEpochStaging({
        path: join(directory, 'epoch-staging.sqlite'),
        mode,
      });
      const stores = {
        loro: yield* makeSqliteSnapshotPublication({
          path: join(directory, 'loro-snapshots.sqlite'),
          mode,
          genesis: creation.genesis,
          resource: resources.loro,
          model: 'loro',
        }),
        flock: yield* makeSqliteSnapshotPublication({
          path: join(directory, 'flock-snapshots.sqlite'),
          mode,
          genesis: creation.genesis,
          resource: resources.flock,
          model: 'flock',
        }),
      };
      const contents = {
        loro: yield* makeLabContentGateway({
          genesis: creation.genesis,
          resource: resources.loro,
          model: 'loro',
          baseUrl: native.baseUrl,
          ledger,
          snapshotStore: stores.loro,
          snapshotBoundary: yield* makeLabRiverrunSnapshotBoundary({
            baseUrl: native.baseUrl,
            genesis: creation.genesis,
            model: 'loro',
          }),
          now,
          fetch: transport,
        }),
        flock: yield* makeLabContentGateway({
          genesis: creation.genesis,
          resource: resources.flock,
          model: 'flock',
          baseUrl: native.baseUrl,
          ledger,
          snapshotStore: stores.flock,
          snapshotBoundary: yield* makeLabRiverrunSnapshotBoundary({
            baseUrl: native.baseUrl,
            genesis: creation.genesis,
            model: 'flock',
          }),
          now,
          fetch: transport,
        }),
      };
      const control = yield* makeLabControlGateway({
        genesis: creation.genesis,
        stream: creation.stream,
        checkpoint: () =>
          ledger().pipe(Effect.map((view) => ({ head: view.head, length: view.length }))),
        afterAppend: () => creation.refresh().pipe(Effect.asVoid),
        now,
        budget,
      });
      const reader = yield* makeLabStreamReader({
        genesis: creation.genesis,
        baseUrl: native.baseUrl,
        ledger,
        maxBytes: 16 * 1024 * 1024,
        fetch: transport,
      });
      const host = yield* makeLabHttpHost({
        port,
        credentials,
        workspaces: registry,
        creation,
        staging: (anchor) =>
          anchor.equals(creation.genesis) ? { port: staging, ledger } : undefined,
        control: (anchor) => (anchor.equals(creation.genesis) ? control : undefined),
        streams: (anchor) => (anchor.equals(creation.genesis) ? reader : undefined),
        contents: (anchor, model) =>
          anchor.equals(creation.genesis) ? contents[model] : undefined,
        mailbox: (anchor) => (anchor.equals(creation.genesis) ? mailbox : undefined),
        joins: (anchor) => (anchor.equals(creation.genesis) ? joins : undefined),
      });
      return Object.freeze({
        baseUrl: host.baseUrl,
        nativeBaseUrl: native.baseUrl,
        genesis: creation.genesis,
        creation,
        registry,
        credentials,
        mailbox,
        joins,
        snapshots: stores,
        staging,
        current: creation.refresh,
        checkpoint: () =>
          ledger().pipe(Effect.map((view) => ({ head: view.head, length: view.length }))),
        /** GET-only confirmation under a real stored fresh bearer, never a new PUT
         * or an identity selected from the pending row. */
        resumeSnapshot: (model: 'loro' | 'flock', token: string) =>
          Effect.gen(function* () {
            const credential = yield* credentials.authenticate(token);
            return yield* contents[model].resumeSnapshot({
              credential,
              requestGenesis: creation.genesis,
            });
          }),
        close: () => close,
      });
    }),
    scope
  ).pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? close : Effect.void)));
});
