import { AsyncLocalStorage } from 'node:async_hooks';
import * as path from 'node:path';
import { NodeFileSystem } from '@effect/platform-node-shared';
import {
  Clock,
  Cause,
  Fiber,
  Semaphore,
  Context,
  Data,
  Effect,
  Exit,
  FileSystem,
  Layer,
  ManagedRuntime,
  Option,
  Ref,
  Schedule,
  Deferred,
} from 'effect';
import type { PlatformError } from 'effect/PlatformError';
import { getLodyDataDir } from './installation-profile';
import { NodeProcess, nodeProcessLive, probePid, squashProcessFailure } from './process';

export interface LockOptions {
  /** Bounds cross-process contention only, after the in-process queue (default: 30000). */
  timeout?: number;
  /** Initial retry delay in ms (default: 100). */
  retryDelay?: number;
  /** Maximum retry delay in ms (default: 2000). */
  maxRetryDelay?: number;
  /** Overrides LODY_LOCKS_DIR and the profile's locks directory. */
  locksDir?: string;
}

export class LockTimeout extends Data.TaggedError('LockTimeout')<{
  lockName: string;
  timeout: number;
}> {
  override get message() {
    return `Failed to acquire lock "${this.lockName}" within ${this.timeout}ms`;
  }
}
export class LockReentrant extends Data.TaggedError('LockReentrant')<{ lockName: string }> {
  override get message() {
    return `withFileLock("${this.lockName}") is not reentrant within the same process`;
  }
}
/** One-line cause for messages; the structured cause stays on the error. */
const describeCause = (cause: unknown): string => {
  if (Cause.isCause(cause)) return describeCause(Cause.squash(cause));
  if (cause instanceof Error) return cause.message || cause.name;
  return String(cause);
};
export class LockIoError extends Data.TaggedError('LockIoError')<{
  path: string;
  cause: unknown;
}> {
  override get message() {
    return `File lock I/O failed at "${this.path}": ${describeCause(this.cause)}`;
  }
}
export interface FileLockCleanupLease {
  readonly path: string;
  /** Waits at most five seconds; a pending deletion is joined, never replaced. */
  readonly retryCleanup: Effect.Effect<void, LockReleaseFailed>;
}
/** Bounds how long the releasing holder waits; the service keeps owning slower cleanup. */
export const FILE_LOCK_CLEANUP_MS = 5_000;
/** Another owner replaced the lock file while the body ran, so exclusion was not held. */
export class LockOwnershipLost extends Data.TaggedError('LockOwnershipLost')<{ path: string }> {
  override get message() {
    return `File lock "${this.path}" was replaced by another owner before release`;
  }
}
export class LockReleaseFailed extends Data.TaggedError('LockReleaseFailed')<{
  path: string;
  cause: unknown;
  cleanup?: FileLockCleanupLease;
}> {
  override get message() {
    return `Failed to release file lock "${this.path}": ${describeCause(this.cause)}`;
  }
}
/** Complete failure projection for Legacy callers and failed Layer disposal. */
export class FileLockCleanupFailed extends Data.TaggedError('FileLockCleanupFailed')<{
  cause: unknown;
  fullCause: Cause.Cause<unknown>;
  releases: ReadonlyArray<LockReleaseFailed>;
}> {
  override get message() {
    const primary = describeCause(this.cause);
    const releases = this.releases
      .filter((release) => release !== this.cause)
      .map((release) => release.message);
    return releases.length === 0 ? primary : `${primary}; ${releases.join('; ')}`;
  }
}
export type FileLockError =
  | LockTimeout
  | LockReentrant
  | LockIoError
  | LockReleaseFailed
  | LockOwnershipLost;

/** Stable pid and per-operation directory resolver; tests may inject a fixed directory. */
export class FileLockHost extends Context.Service<
  FileLockHost,
  { locksDir: string | (() => string); pid: number }
>()('lody/FileLockHost') {}
const heldPaths = Context.Reference<ReadonlySet<string>>('lody/FileLockHeldPaths', {
  defaultValue: () => new Set(),
});

export class FileLocks extends Context.Service<
  FileLocks,
  {
    readonly withLock: <A, E, R>(
      name: string,
      body: Effect.Effect<A, E, R>,
      options?: LockOptions
    ) => Effect.Effect<A, E | FileLockError, R>;
    readonly cleanupStale: (
      options?: Pick<LockOptions, 'locksDir'>
    ) => Effect.Effect<void, FileLockError>;
  }
>()('lody/FileLocks') {}

const hasReason = (error: PlatformError, tag: string) => error.reason._tag === tag;
const parseLock = (raw: string): { pid: number; timestamp: number; token?: string } | undefined => {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || !('pid' in value) || !('timestamp' in value))
      return undefined;
    if (
      typeof value.pid !== 'number' ||
      !Number.isInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.timestamp !== 'number' ||
      !Number.isFinite(value.timestamp)
    )
      return undefined;
    return {
      pid: value.pid,
      timestamp: value.timestamp,
      token: 'token' in value && typeof value.token === 'string' ? value.token : undefined,
    };
  } catch {
    return undefined;
  }
};

/** A lease plus a wait with a caller-chosen bound; both join the same raw operation. */
interface OwnedCleanup<A> extends FileLockCleanupLease {
  /** `charged` waits are successors' deadlines; they set and honor `wedged`. */
  readonly join: (
    boundMs: number,
    options?: { readonly charged?: boolean }
  ) => Effect.Effect<A, LockReleaseFailed>;
  /**
   * A successor already waited a full acquisition deadline for this attempt. Later
   * successors only poll it, so one wedged deletion costs the queue one deadline,
   * not one per queued holder. A new raw attempt clears it.
   */
  wedged: boolean;
}
type QueueEntry = {
  waiters: Array<Deferred.Deferred<void>>;
  cleanups: Set<OwnedCleanup<unknown>>;
};

/** One instance owns its queues and unresolved releases. No module-global lock state. */
export const FileLocksLive = Layer.effect(
  FileLocks,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const host = yield* FileLockHost;
    const nodeProcess = yield* NodeProcess;
    const entries = yield* Ref.make(new Map<string, QueueEntry>());
    const ownerClock = yield* Clock.Clock;
    const directory = (options: Pick<LockOptions, 'locksDir'>) =>
      path.resolve(
        options.locksDir?.trim() ||
          (typeof host.locksDir === 'function' ? host.locksDir() : host.locksDir)
      );
    const read = (lockPath: string) =>
      fs
        .readFileString(lockPath)
        .pipe(
          Effect.catch((error) =>
            hasReason(error, 'NotFound')
              ? Effect.succeed(undefined)
              : Effect.fail(new LockIoError({ path: lockPath, cause: error }))
          )
        );
    const remove = (lockPath: string, recursive = false) =>
      fs
        .remove(lockPath, { recursive })
        .pipe(
          Effect.catch((error) =>
            hasReason(error, 'NotFound')
              ? Effect.void
              : Effect.fail(new LockIoError({ path: lockPath, cause: error }))
          )
        );
    const stale = Effect.fnUntraced(function* (raw: string) {
      const info = parseLock(raw);
      if (!info) return true;
      const now = yield* Clock.currentTimeMillis;
      if (now - info.timestamp > 30 * 60 * 1000) return true;
      return (
        (yield* probePid(info.pid).pipe(Effect.provideService(NodeProcess, nodeProcess))) !== 'ours'
      );
    });
    const reclaim = Effect.fnUntraced(function* (lockPath: string) {
      const raw = yield* read(lockPath);
      if (raw === undefined) return true;
      if (!(yield* stale(raw))) return false;
      // Recheck the observed generation before removing a stale file.
      const current = yield* read(lockPath);
      if (current === undefined) return true;
      if (current !== raw) return false;
      yield* remove(lockPath);
      return true;
    });
    const stat = (file: string) =>
      fs
        .stat(file)
        .pipe(
          Effect.catch((error) =>
            hasReason(error, 'NotFound')
              ? Effect.succeed(undefined)
              : Effect.fail(new LockIoError({ path: file, cause: error }))
          )
        );
    const reclaimScratch = Effect.fnUntraced(function* (scratch: string) {
      const info = yield* stat(scratch);
      if (info?.type !== 'Directory') return;
      const owner = path.join(scratch, 'owner');
      const raw = yield* read(owner);
      if (raw !== undefined && parseLock(raw)) {
        // A live candidate may be published or still preparing/waiting to link.
        if (!(yield* stale(raw))) return;
      } else {
        // A crash can precede the first complete write. Do not collect a new
        // directory while its owner is still preparing metadata.
        const ownerInfo = yield* stat(owner);
        if (Option.isNone(info.mtime)) return;
        if (ownerInfo && Option.isNone(ownerInfo.mtime)) return;
        const modified = Math.max(
          info.mtime.value.getTime(),
          ownerInfo && Option.isSome(ownerInfo.mtime) ? ownerInfo.mtime.value.getTime() : -Infinity
        );
        if ((yield* Clock.currentTimeMillis) - modified <= 30 * 60 * 1000) return;
      }
      // Retain a candidate that changed since the ownership/age check.
      if ((yield* read(owner)) !== raw) return;
      yield* remove(scratch, true);
    });
    // A replaced generation is not ours to delete and leaves nothing to retry: the
    // holder learns that exclusion was lost, and successors contend normally.
    const release = Effect.fnUntraced(function* (lockPath: string, token: string) {
      const raw = yield* read(lockPath);
      if (raw === undefined) return 'released' as const;
      const info = parseLock(raw);
      if (info?.pid !== host.pid || info.token !== token) return 'lost' as const;
      yield* remove(lockPath);
      return 'released' as const;
    });

    const makeCleanup = Effect.fnUntraced(function* <A>(
      lockPath: string,
      entry: QueueEntry,
      file: string,
      raw: () => Effect.Effect<A, unknown>
    ) {
      const serial = yield* Semaphore.make(1);
      const running = yield* Ref.make<Fiber.Fiber<A, unknown> | undefined>(undefined);
      const join = (
        boundMs: number,
        options?: { readonly charged?: boolean }
      ): Effect.Effect<A, LockReleaseFailed> =>
        Effect.suspend(() =>
          serial
            .withPermit(
              Effect.gen(function* () {
                const previous = yield* Ref.get(running);
                const previousExit = previous?.pollUnsafe();
                if (previous && (!previousExit || Exit.isSuccess(previousExit))) return previous;
                entry.cleanups.add(cleanup);
                cleanup.wedged = false;
                // Detached from the bounded waiter, explicitly owned by this lease and
                // the service registry. Local interruption cannot stop an OS unlink.
                const fiber = yield* Effect.forkDetach(
                  Effect.uninterruptible(
                    Effect.suspend(raw).pipe(
                      Effect.tap(() =>
                        Ref.update(entries, (map) => {
                          entry.cleanups.delete(cleanup);
                          if (entry.waiters.length === 0 && entry.cleanups.size === 0)
                            map.delete(lockPath);
                          return map;
                        })
                      )
                    )
                  )
                );
                yield* Ref.set(running, fiber);
                return fiber;
              })
            )
            .pipe(
              Effect.uninterruptible,
              Effect.flatMap((fiber) => {
                const charged = options?.charged === true;
                const bound = charged && cleanup.wedged && !fiber.pollUnsafe() ? 0 : boundMs;
                // An exhausted bound observes the current state without a timer.
                if (bound <= 0) {
                  const exit = fiber.pollUnsafe();
                  return exit ?? Effect.fail('cleanup still pending at the deadline');
                }
                return Effect.acquireUseRelease(
                  // A finalizer can already carry an interruption. Give its bounded
                  // waiter a fresh fiber instead of restoring that interruption here.
                  Effect.forkDetach(Fiber.await(fiber).pipe(Effect.flatten, Effect.timeout(bound))),
                  Fiber.join,
                  (waiter) => Fiber.interrupt(waiter).pipe(Effect.asVoid)
                ).pipe(
                  // Only a deletion still pending after a full charged wait is wedged;
                  // a settled failure stays retryable by the next holder.
                  Effect.tapError(() =>
                    Effect.sync(() => {
                      if (charged && !fiber.pollUnsafe()) cleanup.wedged = true;
                    })
                  )
                );
              }),
              Effect.provideService(Clock.Clock, ownerClock),
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.failCause(
                      Cause.fromReasons(cause.reasons.filter(Cause.isInterruptReason))
                    )
                  : Effect.fail(new LockReleaseFailed({ path: file, cause, cleanup }))
              )
            )
        );
      const cleanup: OwnedCleanup<A> = {
        path: file,
        join,
        retryCleanup: Effect.asVoid(join(FILE_LOCK_CLEANUP_MS)),
        wedged: false,
      };
      return cleanup;
    });
    // A successor joins retained cleanup within its own acquisition deadline: a
    // deletion that is merely slow delays the next holder instead of failing it.
    // The wait is charged to the deletion, not to each successor: after one
    // successor has waited its whole deadline, the rest fail fast until a new
    // attempt starts, instead of each waiting a full deadline in FIFO order.
    const recover = (entry: QueueEntry, deadline: number) =>
      Effect.forEach(
        [...entry.cleanups],
        (cleanup) =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) => cleanup.join(Math.max(0, deadline - now), { charged: true }))
          ),
        { discard: true }
      );
    yield* Effect.addFinalizer(() =>
      Ref.get(entries).pipe(
        Effect.flatMap((map) =>
          Effect.forEach(
            [...map.values()].flatMap((entry) => [...entry.cleanups]),
            (cleanup) => cleanup.retryCleanup.pipe(Effect.exit),
            { concurrency: 'unbounded' }
          )
        ),
        Effect.flatMap((results) => {
          const causes = results.flatMap((result) =>
            Exit.isFailure(result) ? [result.cause] : []
          );
          if (causes.length === 0) return Effect.void;
          const fullCause = causes.reduce(Cause.combine);
          return Effect.die(
            new FileLockCleanupFailed({
              cause: fullCause,
              fullCause,
              releases: lockReleases(fullCause),
            })
          );
        })
      )
    );

    const withLock = Effect.fnUntraced(function* <A, E, R>(
      name: string,
      body: Effect.Effect<A, E, R>,
      options: LockOptions = {}
    ): Effect.fn.Return<A, E | FileLockError, R> {
      const dir = directory(options);
      const lockPath = path.join(dir, `${name.replace(/[^a-zA-Z0-9_-]/g, '_')}.lock`);
      const held = yield* heldPaths;
      if (held.has(lockPath)) return yield* Effect.fail(new LockReentrant({ lockName: name }));
      const timeout = options.timeout ?? 30000;
      const retryDelay = options.retryDelay ?? 100;
      const maxRetryDelay = options.maxRetryDelay ?? 2000;
      if (![timeout, retryDelay, maxRetryDelay].every((n) => Number.isFinite(n) && n >= 0)) {
        return yield* Effect.fail(
          new LockIoError({ path: lockPath, cause: 'lock delays must be finite and nonnegative' })
        );
      }
      const checkout = Ref.modify(entries, (map) => {
        const entry: QueueEntry = map.get(lockPath) ?? { waiters: [], cleanups: new Set() };
        const ticket = Deferred.makeUnsafe<void>();
        if (entry.waiters.length === 0) Deferred.doneUnsafe(ticket, Effect.void);
        entry.waiters.push(ticket);
        map.set(lockPath, entry);
        return [{ entry, ticket }, map] as const;
      });
      return yield* Effect.acquireUseRelease(
        checkout,
        ({ entry, ticket }) =>
          Effect.gen(function* () {
            yield* Deferred.await(ticket);
            // One deadline, started at local admission, covers retained cleanup and
            // cross-process contention.
            const admittedAt = yield* Clock.currentTimeMillis;
            // A failed release retains its owner. Retry it before admitting a replacement.
            yield* recover(entry, admittedAt + timeout);
            // The holder waits for its lock file and scratch together within one bound.
            let releaseDeadline: number | undefined;
            const holderBound = Clock.currentTimeMillis.pipe(
              Effect.map((now) =>
                releaseDeadline === undefined
                  ? FILE_LOCK_CLEANUP_MS
                  : Math.max(0, releaseDeadline - now)
              )
            );
            yield* fs
              .makeDirectory(dir, { recursive: true })
              .pipe(Effect.mapError((cause) => new LockIoError({ path: dir, cause })));
            // Publish complete metadata atomically; wx + async write exposes an empty
            // file that another process would wrongly reclaim as malformed/stale.
            const candidate = fs.makeTempDirectory({ directory: dir, prefix: '.lody-lock-' }).pipe(
              Effect.mapError((cause) => new LockIoError({ path: dir, cause })),
              Effect.flatMap((scratch) =>
                makeCleanup(lockPath, entry, scratch, () => remove(scratch, true)).pipe(
                  Effect.map((cleanup) => ({ scratch, cleanup }))
                )
              )
            );
            return yield* Effect.acquireUseRelease(
              candidate,
              ({ scratch }) =>
                Effect.uninterruptibleMask((restore) => {
                  const token = path.join(scratch, 'owner');
                  const acquire = Effect.gen(function* () {
                    const delay = yield* Ref.make(retryDelay);
                    const step = yield* Schedule.toStepWithMetadata(
                      Schedule.forever.pipe(
                        Schedule.modifyDelay(() =>
                          Ref.getAndUpdate(delay, (ms) => Math.min(ms * 1.5, maxRetryDelay))
                        )
                      )
                    );
                    const attempt: Effect.Effect<
                      OwnedCleanup<'released' | 'lost'>,
                      FileLockError
                    > = Effect.gen(function* () {
                      const timestamp = yield* Clock.currentTimeMillis;
                      yield* restore(
                        fs
                          .writeFileString(
                            token,
                            JSON.stringify({ pid: host.pid, timestamp, token })
                          )
                          .pipe(Effect.mapError((cause) => new LockIoError({ path: token, cause })))
                      );
                      // Only publication and registering its release stay masked.
                      const acquired = yield* fs.link(token, lockPath).pipe(
                        Effect.as(true),
                        Effect.catch((error) =>
                          hasReason(error, 'AlreadyExists')
                            ? Effect.succeed(false)
                            : Effect.fail(new LockIoError({ path: lockPath, cause: error }))
                        )
                      );
                      if (acquired)
                        return yield* makeCleanup(lockPath, entry, lockPath, () =>
                          release(lockPath, token)
                        );
                      if (yield* restore(reclaim(lockPath)))
                        return yield* Effect.suspend(() => attempt);
                      if ((yield* Clock.currentTimeMillis) - admittedAt > timeout)
                        return yield* Effect.fail(new LockTimeout({ lockName: name, timeout }));
                      yield* restore(step(undefined)).pipe(Effect.orDie);
                      return yield* Effect.suspend(() => attempt);
                    });
                    return yield* attempt;
                  });
                  return Effect.acquireUseRelease(
                    acquire,
                    () =>
                      restore(Effect.provideService(body, heldPaths, new Set([...held, lockPath]))),
                    // The body's result stands once it ran exclusively. A slow or failed
                    // deletion stays registered: successors and disposal retry it.
                    (cleanup) =>
                      Clock.currentTimeMillis.pipe(
                        Effect.flatMap((now) => {
                          releaseDeadline = now + FILE_LOCK_CLEANUP_MS;
                          return cleanup.join(FILE_LOCK_CLEANUP_MS);
                        }),
                        Effect.catchTag('LockReleaseFailed', () => Effect.succeed('retained')),
                        Effect.flatMap((outcome) =>
                          outcome === 'lost'
                            ? Effect.fail(new LockOwnershipLost({ path: lockPath }))
                            : Effect.void
                        )
                      )
                  );
                }),
              ({ cleanup }) =>
                holderBound.pipe(
                  Effect.flatMap(cleanup.join),
                  Effect.catchTag('LockReleaseFailed', () => Effect.void)
                )
            );
          }),
        ({ entry, ticket }) =>
          Ref.update(entries, (map) => {
            // Remove cancelled tickets without waiting for their predecessor.
            // Handoff reserves ownership synchronously before a newcomer can enqueue.
            const index = entry.waiters.indexOf(ticket);
            entry.waiters.splice(index, 1);
            if (index === 0 && entry.waiters[0]) Deferred.doneUnsafe(entry.waiters[0], Effect.void);
            if (entry.waiters.length === 0 && entry.cleanups.size === 0) map.delete(lockPath);
            return map;
          })
      );
    });
    return FileLocks.of({
      withLock,
      cleanupStale: (options = {}) =>
        Effect.gen(function* () {
          const dir = directory(options);
          yield* fs
            .makeDirectory(dir, { recursive: true })
            .pipe(Effect.mapError((cause) => new LockIoError({ path: dir, cause })));
          const files = yield* fs
            .readDirectory(dir)
            .pipe(Effect.mapError((cause) => new LockIoError({ path: dir, cause })));
          yield* Effect.forEach(
            files.filter((name) => name.endsWith('.lock')),
            (name) => reclaim(path.join(dir, name)),
            { discard: true }
          );
          yield* Effect.forEach(
            files.filter((name) => name.startsWith('.lody-lock-')),
            (name) => reclaimScratch(path.join(dir, name)),
            { discard: true }
          );
        }),
    });
  })
);

/** Application composition; constructing this Layer executes no program. */
export const fileLockLayer = Layer.provide(
  FileLocksLive,
  Layer.mergeAll(
    NodeFileSystem.layer,
    Layer.succeed(NodeProcess, nodeProcessLive),
    Layer.sync(FileLockHost, () => ({
      pid: process.pid,
      locksDir: () => process.env.LODY_LOCKS_DIR?.trim() || path.join(getLodyDataDir(), 'locks'),
    }))
  )
);

export const withFileLock = <A, E, R>(
  name: string,
  body: Effect.Effect<A, E, R>,
  options?: LockOptions
): Effect.Effect<A, E | FileLockError, R | FileLocks> =>
  Effect.flatMap(FileLocks, (locks) => locks.withLock(name, body, options));
export const cleanupStaleLocks = (
  options?: Pick<LockOptions, 'locksDir'>
): Effect.Effect<void, FileLockError, FileLocks> =>
  Effect.flatMap(FileLocks, (locks) => locks.cleanupStale(options));

const lockReleases = <E>(cause: Cause.Cause<E>): LockReleaseFailed[] =>
  cause.reasons.flatMap((reason) => {
    const error = Cause.isFailReason(reason)
      ? reason.error
      : Cause.isDieReason(reason)
        ? reason.defect
        : undefined;
    return error instanceof LockReleaseFailed
      ? [error]
      : error instanceof FileLockCleanupFailed
        ? [...error.releases]
        : [];
  });
/** Pure projection: preserve process leases, every lock cleanup lease and the primary failure. */
export const squashFileLockFailure = <E>(cause: Cause.Cause<E>): unknown => {
  const primary = squashProcessFailure(cause);
  const releases = lockReleases(cause);
  return releases.length === 0 || (releases.length === 1 && primary === releases[0])
    ? primary
    : new FileLockCleanupFailed({ cause: primary, fullCause: cause, releases });
};

// ---- single Promise compatibility door ---------------------------------
// Process-lifetime compatibility owner, retired with the last Promise caller.
const legacyRuntime = ManagedRuntime.make(fileLockLayer);
const legacyHeldPaths = new AsyncLocalStorage<ReadonlySet<string>>();

/**
 * @deprecated Promise callers only. Native workflows compose withFileLock.
 * A cancelled callback is signalled and joined before releasing its lock;
 * callbacks ignoring the signal can delay cancellation, never outlive the lock.
 */
const withLockLegacy = <A>(
  name: string,
  fn: (signal: AbortSignal) => Promise<A>,
  options: LockOptions & { signal?: AbortSignal } = {}
): Promise<A> => {
  const inherited = legacyHeldPaths.getStore() ?? new Set<string>();
  const signal = options.signal ?? new AbortController().signal;
  // The Promise body is not cancellable by Effect. Keep its lease until it
  // actually settles, forwarding caller cancellation directly to that boundary.
  // This wait stays in the body; no finalizer joins unbounded Promise work.
  const body = Effect.flatMap(heldPaths, (held) =>
    Effect.uninterruptible(
      Effect.tryPromise({
        try: () => legacyHeldPaths.run(held, () => fn(signal)),
        catch: (error) => error,
      })
    )
  );
  return fileLocksLegacy.runPromise(
    withFileLock(name, body, options).pipe(Effect.provideService(heldPaths, inherited)),
    { signal: options.signal }
  );
};

/**
 * @deprecated Single process-lifetime execution facade for unmigrated entrypoints.
 * Removed when worktree, download and catalog entrypoints use the daemon runtime.
 */
export const fileLocksLegacy = {
  withLock: withLockLegacy,
  runPromise: <A, E>(
    program: Effect.Effect<A, E, FileLocks>,
    options?: Effect.RunOptions
  ): Promise<A> =>
    legacyRuntime
      .runPromiseExit(
        program.pipe(
          Effect.provideService(heldPaths, legacyHeldPaths.getStore() ?? new Set<string>())
        ),
        options
      )
      .then((exit) => {
        if (Exit.isSuccess(exit)) return exit.value;
        throw squashFileLockFailure(exit.cause);
      }),
};
