import { Context, Deferred, Effect, Layer, Option, Semaphore } from 'effect';
import { ClientCustodyError, ClientCustodyWriter } from '../../services/client-custody';
import { WorkspaceScope } from '../../services/workspace';
import { makeAdmissionGate } from '../../internal/lifecycle';
import { scopeRaw, sameScope } from '../indexeddb/client-database';

/** Stable account/workspace routing shared by all browser tabs and workers. */
export interface BrowserClientWriterOptions {
  /** Account routing only, not membership. */
  readonly accountId: string;
  /** Workspace routing only; WorkspaceScope supplies independently pinned genesis. */
  readonly workspaceId: string;
  /** Longest a call waits behind another call of this tab, in milliseconds (default 15 s);
   * `0` never waits and fails conflict at once. */
  readonly queueTimeout?: number;
}
/** One in-tab queue per lock name, shared by every writer of this JavaScript realm. */
const tabQueues = new Map<string, Semaphore.Semaphore>();
const tabQueue = (name: string) => {
  let queue = tabQueues.get(name);
  if (!queue) {
    queue = Semaphore.makeUnsafe(1);
    tabQueues.set(name, queue);
  }
  return queue;
};
class HeldWriter extends Context.Service<
  HeldWriter,
  { readonly owner: object; readonly fiberId: number; readonly active: () => boolean }
>()('ClientCustody/HeldWriter') {}
const fail = (reason: ClientCustodyError['reason']) => new ClientCustodyError({ reason });
/**
 * Origin-wide Web Locks exclusion. Only the holding fiber may reenter; a child fiber of a
 * holder fails conflict at once rather than wait for its parent. Calls of one tab queue in
 * order before taking the lock, so finite local work never collides with itself (a content
 * read beside a key round). The wait is bounded by `queueTimeout` and ends with conflict,
 * on interruption, or when this writer closes; the holder itself is never timed out or
 * stolen from. Another tab still meets the lock with `ifAvailable`: busy fails conflict, no
 * stealing or memory-only fallback. Scope close fences admission and drains actual work
 * before releasing locks.
 */
export const browserClientWriter = (input: BrowserClientWriterOptions) => {
  const options = { ...input };
  return Layer.effect(
    ClientCustodyWriter,
    Effect.gen(function* () {
      const genesis = (yield* WorkspaceScope).genesis,
        scope = { accountId: options.accountId, workspaceId: options.workspaceId, genesis };
      const raw = yield* Effect.try({ try: () => scopeRaw(scope), catch: () => fail('corrupt') });
      if (!globalThis.navigator?.locks) return yield* fail('unavailable');
      const request = navigator.locks.request.bind(navigator.locks);
      const name = JSON.stringify([
        'lody-e2ee/client-writer/v1',
        raw.accountId,
        raw.workspaceId,
        raw.genesis,
      ]);
      const owner = {},
        gate = yield* makeAdmissionGate(() => fail('closed'));
      // Registered after the gate, so it runs first on close: queued calls stop waiting
      // instead of holding the gate's drain open.
      const closing = yield* Deferred.make<void>();
      yield* Effect.addFinalizer(() => Deferred.succeed(closing, undefined));
      const queue = tabQueue(name),
        queueTimeout = options.queueTimeout ?? 15_000;
      const queued = <A, E, R>(work: Effect.Effect<A, E, R>) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const turn =
              queueTimeout > 0
                ? Option.isSome(
                    yield* restore(
                      Effect.raceFirst(
                        queue.take(1).pipe(Effect.timeoutOption(queueTimeout)),
                        Deferred.await(closing).pipe(Effect.andThen(Effect.fail(fail('closed'))))
                      )
                    )
                  )
                : yield* queue.takeIfAvailable(1);
            if (!turn) return yield* fail('conflict');
            return yield* restore(work).pipe(Effect.ensuring(queue.release(1)));
          })
        );
      const acquire = Effect.uninterruptible(
        Effect.tryPromise({
          try: () =>
            new Promise<{ release: () => Promise<void>; held: () => boolean }>(
              (resolve, reject) => {
                let release!: () => void,
                  active = false;
                const finished = request(name, { mode: 'exclusive', ifAvailable: true }, (lock) => {
                  if (!lock) {
                    reject(fail('conflict'));
                    return undefined;
                  }
                  if (gate.isClosed()) {
                    reject(fail('closed'));
                    return undefined;
                  }
                  active = true;
                  const held = new Promise<void>((done) => {
                    release = done;
                  });
                  resolve({
                    held: () => active,
                    release: async () => {
                      active = false;
                      release();
                      await finished;
                    },
                  });
                  return held;
                });
                void finished.catch(() => reject(fail('unavailable')));
              }
            ),
          catch: (cause) => (cause instanceof ClientCustodyError ? cause : fail('unavailable')),
        })
      );
      return ClientCustodyWriter.of({
        scope: Object.freeze(scope),
        run: <A, E, R>(work: Effect.Effect<A, E, R>): Effect.Effect<A, E | ClientCustodyError, R> =>
          gate.run(
            Effect.gen(function* () {
              const held = yield* Effect.serviceOption(HeldWriter),
                fiberId = yield* Effect.fiberId;
              if (Option.isSome(held) && held.value.owner === owner && held.value.active()) {
                if (held.value.fiberId === fiberId) return yield* work;
                // A child of the holder would queue behind the parent awaiting it.
                return yield* fail('conflict');
              }
              return yield* queued(
                Effect.acquireUseRelease(
                  acquire,
                  (lease) =>
                    work.pipe(
                      Effect.provideService(HeldWriter, { owner, fiberId, active: lease.held })
                    ),
                  (lease) => Effect.promise(lease.release)
                )
              );
            })
          ),
      });
    })
  );
};
export const checkWriterScope = (
  writer: ClientCustodyWriter['Service'],
  scope: Parameters<typeof scopeRaw>[0]
) => {
  if (!sameScope(scopeRaw(writer.scope), scopeRaw(scope))) throw fail('corrupt');
};
