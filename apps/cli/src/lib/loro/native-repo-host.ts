import { Cause, Context, Deferred, Effect, Layer, Ref } from 'effect';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectEngine } from '@loro-dev/loro-repo-client/node';
import type { RepoClient } from '@loro-dev/loro-repo-client';
import { makeApplicationRuntime } from '@lody/shared/node/application-runtime';
import {
  ProcessReleaseFailed,
  spawnProcess,
  squashProcessFailure,
} from '@lody/shared/node/process';
import { platformLayer, type PlatformFacadeOptions } from '@/platform/process-options';
import { getCliNodeExecutable } from '../managed-daemon-release';

export class NativeRepoHost extends Context.Service<
  NativeRepoHost,
  {
    readonly client: RepoClient;
  }
>()('lody/native-repo/Host') {}

export type NativeRepoHostOptions = {
  readonly dataDir: string;
  readonly entry?: string;
  readonly executable?: string;
};

/** One application-owned child, one native writer, and no generic renderer transport. */
export function nativeRepoHostLayer(options: NativeRepoHostOptions) {
  return Layer.effect(
    NativeRepoHost,
    Effect.gen(function* () {
      const entry =
        options.entry ?? join(dirname(fileURLToPath(import.meta.url)), 'native-repo-host.js');
      if (!existsSync(entry))
        return yield* Effect.fail(new Error('Native Repo host bundle is missing'));
      const start = Effect.fnUntraced(function* () {
        const ready = yield* Deferred.make<void, Error>();
        let detach = () => {};
        yield* Effect.addFinalizer(() => Effect.sync(() => detach()));
        const child = yield* spawnProcess({
          command: options.executable ?? getCliNodeExecutable(),
          args: [entry, options.dataDir],
          processGroup: true,
          options: {
            // No credentials, workspace tokens or user-authored environment enter
            // the native host. Electron's Node mode must survive packaging.
            env: Object.fromEntries(
              ['PATH', 'SystemRoot', 'TMPDIR', 'TMP', 'TEMP', 'ELECTRON_RUN_AS_NODE'].flatMap(
                (key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])
              )
            ),
            windowsHide: true,
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          },
          onSpawned(handle: ChildProcess) {
            const message = (value: unknown) => {
              if (
                value &&
                typeof value === 'object' &&
                'type' in value &&
                value.type === 'ready' &&
                'version' in value &&
                value.version === '0.1.0'
              ) {
                Deferred.doneUnsafe(ready, Effect.void);
              }
            };
            const failed = () =>
              Deferred.doneUnsafe(
                ready,
                Effect.fail(new Error('Native Repo host exited before readiness'))
              );
            handle.on('message', message);
            handle.once('exit', failed);
            handle.once('error', failed);
            detach = () => {
              handle.off('message', message);
              handle.off('exit', failed);
              handle.off('error', failed);
            };
          },
        });
        yield* child.started;
        yield* Deferred.await(ready).pipe(Effect.timeout('15 seconds'));
        return child;
      });
      const started = yield* Deferred.make<void, unknown>();
      const unresolved = yield* Ref.make<Cause.Cause<unknown> | null>(null);
      yield* Effect.addFinalizer(() =>
        Ref.get(unresolved).pipe(
          Effect.flatMap((cause) => (cause ? Effect.failCause(cause) : Effect.void)),
          Effect.orDie
        )
      );
      let client: RepoClient | undefined;
      const generation = Effect.scoped(
        Effect.gen(function* () {
          const child = yield* start();
          yield* Deferred.succeed(started, undefined);
          yield* child.exited;
        })
      ).pipe(
        Effect.onExit((exit) => {
          // Runs even when forkScoped is interrupted during application shutdown;
          // code after Effect.exit would itself be interrupted before retaining it.
          if (
            exit._tag === 'Failure' &&
            exit.cause.reasons.some(
              (reason) => Cause.isDieReason(reason) && reason.defect instanceof ProcessReleaseFailed
            )
          )
            return Ref.set(unresolved, exit.cause);
          return Effect.void;
        })
      );
      yield* Effect.gen(function* () {
        const initial = yield* generation.pipe(Effect.exit);
        if (initial._tag === 'Failure') {
          if (
            initial.cause.reasons.some(
              (reason) => Cause.isDieReason(reason) && reason.defect instanceof ProcessReleaseFailed
            )
          )
            yield* Ref.set(unresolved, initial.cause);
          yield* Deferred.failCause(started, initial.cause);
          return;
        }
        // Each attempt owns a child Scope. A failed readiness attempt is actually
        // terminated before another can open the same engine directory.
        for (let attempt = 0; attempt < 3; attempt++) {
          yield* Effect.sleep('250 millis');
          const next = yield* generation.pipe(Effect.exit);
          if (next._tag === 'Failure') {
            if (
              next.cause.reasons.some(
                (reason) =>
                  Cause.isDieReason(reason) && reason.defect instanceof ProcessReleaseFailed
              )
            ) {
              yield* Ref.set(unresolved, next.cause);
              if (client) yield* Effect.promise(() => client!.close());
              return;
            }
            yield* Effect.logWarning('Native Repo host restart attempt failed');
          }
        }
        yield* Effect.logWarning('Native Repo host restart budget exhausted; restart required');
        if (client) yield* Effect.promise(() => client!.close());
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(started).pipe(Effect.timeout('15 seconds'));
      client = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            connectEngine(options.dataDir, {
              // Reuse the published client's transport recovery for both a live
              // endpoint flap and a replacement host. Sent requests are not replayed.
              autoReconnect: { timeoutMs: 60_000 },
            }),
          catch: (cause) => cause,
        }),
        (client) => Effect.promise(() => client.close())
      );
      return NativeRepoHost.of({ client });
    })
  );
}

/**
 * @deprecated Promise composition boundary for the existing daemon manager.
 * The native process lifetime lives in Scope, not in request cancellation.
 * Removal: daemon workspace composition consumes NativeRepoHost natively.
 */
export class NativeRepoHostLegacy {
  private owner;
  private acquisition: Promise<RepoClient> | null = null;
  private closed = false;
  constructor(
    private readonly options: NativeRepoHostOptions,
    private readonly platform: PlatformFacadeOptions = {}
  ) {
    this.owner = this.makeOwner();
  }
  private makeOwner() {
    return makeApplicationRuntime(
      nativeRepoHostLayer(this.options).pipe(Layer.provide(platformLayer(this.platform))),
      {
        project: squashProcessFailure,
        recover: (cause) => {
          const leases = cause.reasons.flatMap((reason) =>
            Cause.isDieReason(reason) && reason.defect instanceof ProcessReleaseFailed
              ? [reason.defect]
              : []
          );
          return leases.length
            ? Effect.forEach(leases, (lease) => lease.retryTermination(), { discard: true })
            : Effect.failCause(cause);
        },
      }
    );
  }
  client(): Promise<RepoClient> {
    if (this.closed) return Promise.reject(new Error('Native Repo host is closed'));
    if (this.acquisition) return this.acquisition;
    const owner = this.owner;
    this.acquisition = owner.runtime
      .runPromise(Effect.map(NativeRepoHost, (host) => host.client))
      .catch(async (error) => {
        // A failed Layer is memoized. Only replace it after the original Scope
        // has confirmed release, so a transient spawn/lock failure can recover
        // on the next request without admitting a second native writer.
        try {
          await owner.closeLegacy();
          if (!this.closed) this.owner = this.makeOwner();
        } catch (release) {
          throw new AggregateError([error, release], 'Native Repo acquisition and release failed');
        } finally {
          this.acquisition = null;
        }
        throw error;
      });
    return this.acquisition;
  }
  close(): Promise<void> {
    this.closed = true;
    return this.owner.closeLegacy();
  }
}
