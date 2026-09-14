import {
  Cause,
  Context,
  Effect,
  ExecutionStrategy,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Scope,
} from 'effect';
import type { SessionId } from '@lody/shared';
import type { SessionDocStore } from '@/atoms/runtime';

class SendScope extends Context.Tag('lody/SessionSendScope')<SendScope, Scope.CloseableScope>() {}

export const throwIfSendAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new DOMException('Attachment operation aborted', 'AbortError');
};

/** Interruption stops cooperative I/O and joins raw work before releasing its owner. */
function ownedPromise<A>(work: (signal: AbortSignal) => Promise<A>): Effect.Effect<A, unknown> {
  return Effect.async<A, unknown>((resume) => {
    const controller = new AbortController();
    const raw = Promise.resolve().then(() => {
      throwIfSendAborted(controller.signal);
      return work(controller.signal);
    });
    void raw.then(
      (value) => resume(Effect.succeed(value)),
      (error: unknown) => resume(Effect.fail(error))
    );
    return Effect.promise(async () => {
      controller.abort();
      // IPC and some acquisitions cannot be interrupted. Their existing finally
      // blocks must finish before the workspace destroys their dependencies.
      await raw.catch(() => undefined);
    });
  });
}

export type SessionSendResources = ReturnType<typeof createSessionSendResources>;

export function createSessionSendResources(stores: {
  acquire: (sessionId: SessionId) => Promise<SessionDocStore>;
  releaseRef: (sessionId: SessionId) => void;
}) {
  const managed = ManagedRuntime.make(
    Layer.scoped(
      SendScope,
      Effect.acquireRelease(Scope.make(ExecutionStrategy.parallel), (scope) =>
        Scope.close(scope, Exit.void)
      )
    )
  );
  let closing: Promise<void> | undefined;
  let activeOperations = 0;

  const run = async <A>(
    work: (signal: AbortSignal) => Promise<A>,
    signal?: AbortSignal
  ): Promise<A> => {
    throwIfSendAborted(signal);
    if (closing) throw new DOMException('Workspace send resources closed', 'AbortError');
    const fiber = await managed.runPromise(
      Effect.gen(function* () {
        const scope = yield* SendScope;
        return yield* Effect.forkIn(ownedPromise(work), scope);
      })
    );
    const interrupt = () => {
      // The fiber belongs to SendScope; this only requests its cancellation.
      void Effect.runPromise(Fiber.interrupt(fiber));
    };
    signal?.addEventListener('abort', interrupt, { once: true });
    if (signal?.aborted) interrupt();
    try {
      const exit = await Effect.runPromise(Fiber.await(fiber));
      throwIfSendAborted(signal);
      if (Exit.isSuccess(exit)) return exit.value;
      if (Cause.isInterrupted(exit.cause)) {
        throw new DOMException('Attachment operation aborted', 'AbortError');
      }
      throw Cause.squash(exit.cause);
    } finally {
      signal?.removeEventListener('abort', interrupt);
    }
  };

  const runTracked = async <A>(
    work: (signal: AbortSignal) => Promise<A>,
    signal?: AbortSignal,
    options?: { protectExit?: boolean }
  ): Promise<A> => {
    const protectsInput = options?.protectExit !== false;
    if (protectsInput) activeOperations += 1;
    try {
      return await run(work, signal);
    } finally {
      if (protectsInput) activeOperations -= 1;
    }
  };

  return {
    run: runTracked,
    getActiveCount: () => activeOperations,
    withSessionStore: <A>(
      sessionId: SessionId,
      use: (store: SessionDocStore, signal: AbortSignal) => Promise<A> | A,
      signal?: AbortSignal
    ): Promise<A> =>
      runTracked(async (ownedSignal) => {
        const store = await stores.acquire(sessionId);
        try {
          throwIfSendAborted(ownedSignal);
          return await use(store, ownedSignal);
        } finally {
          // Cache alone owns dispose/unload; only return this operation's borrow.
          stores.releaseRef(sessionId);
        }
      }, signal),
    dispose: (): Promise<void> => {
      closing ??= Promise.resolve().then(() => managed.dispose());
      return closing;
    },
  };
}
