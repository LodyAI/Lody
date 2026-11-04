import { Context, Effect, Layer, Option } from 'effect';
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
}
class HeldWriter extends Context.Service<
  HeldWriter,
  { readonly owner: object; readonly fiberId: number; readonly active: () => boolean }
>()('ClientCustody/HeldWriter') {}
const fail = (reason: ClientCustodyError['reason']) => new ClientCustodyError({ reason });
/** Origin-wide Web Locks exclusion. Only the holding fiber may reenter; child fibers acquire their own lease. Busy fails conflict; no stealing, timeout or memory-only fallback. Scope close fences admission and drains actual work before releasing locks. */
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
              if (
                Option.isSome(held) &&
                held.value.owner === owner &&
                held.value.fiberId === fiberId &&
                held.value.active()
              )
                return yield* work;
              return yield* Effect.acquireUseRelease(
                acquire,
                (lease) =>
                  work.pipe(
                    Effect.provideService(HeldWriter, { owner, fiberId, active: lease.held })
                  ),
                (lease) => Effect.promise(lease.release)
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
