import { Cause, Deferred, Effect, Exit, Fiber, Scope } from 'effect';
import { LoroStreamsTokenError, type LoroStreamsTokenProvider } from '@lody/shared';

type Share = {
  readonly provider: LoroStreamsTokenProvider;
  readonly scope: Scope.Closeable;
  leases: number;
};

const closedError = () =>
  new LoroStreamsTokenError({ reason: 'closed', message: 'Loro Streams token provider closed' });

/**
 * One Streams token kernel per workspace in this process. Durable sync, presence
 * and Machine RPC borrow it, so they share its cache, refresh lease and rejected
 * token handling instead of each fetching on a cold start or reconnect.
 *
 * Each borrower gets its own view: closing a view fences and interrupts only that
 * view's reads. The last view's close closes the kernel; a failed kernel close
 * keeps its owner in the reported Cause, and that view's `retryCleanup` finishes
 * the close. Sharing must not hold a failure longer than separate kernels did:
 * every read first drives the kernel's shared, bounded cleanup when a release
 * failed, and a joining view clears a terminal 401/403 once.
 */
export function makeStreamsTokenShares(
  make: (workspaceId: string) => Effect.Effect<LoroStreamsTokenProvider, never, Scope.Scope>,
  options?: {
    /** A cleanup report of already-ended raw work, observed before it is retired. */
    readonly onCleanupReported?: (cause: Cause.Cause<unknown>) => void;
  }
) {
  const shares = new Map<string, Share>();

  /**
   * Next-use recovery of a release-failed kernel. The kernel shares one cleanup
   * flight among concurrent callers. Its first run reports raw work that already
   * ended with a failed release and retires it; only when no unsettled raw work
   * remains is one immediate rerun allowed. Unsettled work keeps the full Cause and
   * owner for the next read.
   */
  const recover = (share: Share) =>
    Effect.gen(function* () {
      if ((yield* share.provider.health).state !== 'release-failed') return undefined;
      const first = yield* Effect.exit(share.provider.retryCleanup);
      if (Exit.isSuccess(first)) return undefined;
      if ((yield* share.provider.health).pendingRawWork) return yield* first;
      options?.onCleanupReported?.(first.cause);
      return yield* share.provider.retryCleanup;
    });

  const view = Effect.fnUntraced(function* (workspaceId: string, share: Share, joined: boolean) {
    const reads = yield* Scope.make();
    let closed = false;
    let receipt: Deferred.Deferred<void> | undefined;
    let closeFailed = false;
    let leaseReleased = false;
    let finalClosePending = false;
    // A borrower joining a kernel that holds a terminal 401/403 (for example a
    // reattach after workspace access was restored) gets one fresh admission on its
    // first read, as a per-consumer kernel did. The borrower's own retry policy
    // bounds how often that happens; existing borrowers stay fenced until then.
    let admission: Effect.Effect<void> = joined
      ? Effect.flatMap(share.provider.health, (health) =>
          health.terminalAuthStatus === undefined
            ? Effect.void
            : share.provider.invalidate('manual')
        )
      : Effect.void;
    const getToken: LoroStreamsTokenProvider['getToken'] = (context) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.suspend(() => {
          if (closed) return Effect.fail(closedError());
          const admit = admission;
          admission = Effect.void;
          return recover(share).pipe(
            Effect.andThen(admit),
            Effect.andThen(
              Effect.forkIn(Effect.interruptible(share.provider.getToken(context)), reads)
            ),
            Effect.flatMap((read) =>
              restore(Fiber.join(read)).pipe(Effect.onInterrupt(() => Fiber.interrupt(read)))
            )
          );
        })
      );
    // Resumable: the lease is released exactly once, and only the last view closes
    // the kernel and the share Scope. A rerun after `retryCleanup` repeats only the
    // unfinished kernel close.
    const finish = Effect.gen(function* () {
      yield* Scope.close(reads, Exit.void);
      if (!leaseReleased) {
        leaseReleased = true;
        share.leases--;
        if (share.leases > 0) return;
        if (shares.get(workspaceId) === share) shares.delete(workspaceId);
        finalClosePending = true;
      }
      if (!finalClosePending) return;
      // The kernel finalizer in this Scope is its own memoized close.
      yield* share.provider.close;
      yield* Scope.close(share.scope, Exit.void);
      finalClosePending = false;
    });
    const close = Effect.uninterruptible(
      Effect.gen(function* () {
        if (receipt) return yield* Deferred.await(receipt);
        const done = Deferred.makeUnsafe<void>();
        receipt = done;
        closed = true;
        const exit = yield* Effect.exit(finish);
        closeFailed = Exit.isFailure(exit);
        yield* Deferred.done(done, exit);
        return yield* exit;
      })
    );
    const retryCleanup = Effect.uninterruptible(
      Effect.gen(function* () {
        // Only a failed release needs the kernel's cleanup; on a healthy shared
        // kernel it would interrupt other borrowers' reads. The failure being
        // reported here already reached the close or read that hit it.
        yield* recover(share);
        if (!closeFailed) return;
        // The kernel is recovered: finish this view's close and replace its receipt.
        receipt = undefined;
        yield* close;
      })
    );
    const borrowed: LoroStreamsTokenProvider = {
      getToken,
      createAuthCallback: () => {
        let lastToken: string | undefined;
        return (context) =>
          getToken(
            context?.reason === 'unauthorized'
              ? { ...context, previousToken: context.previousToken ?? lastToken }
              : context
          ).pipe(
            Effect.tap((token) =>
              Effect.sync(() => {
                lastToken = token;
              })
            )
          );
      },
      health: share.provider.health,
      invalidate: share.provider.invalidate,
      getGatewayBaseUrl: share.provider.getGatewayBaseUrl,
      getShardHostSuffix: share.provider.getShardHostSuffix,
      close,
      retryCleanup,
    };
    return borrowed;
  });

  /** Borrows the workspace kernel, creating it on first use. The caller owns the view. */
  const borrow = (workspaceId: string) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const existing = shares.get(workspaceId);
        if (existing) {
          existing.leases++;
          return yield* view(workspaceId, existing, true);
        }
        const scope = yield* Scope.make();
        const provider = yield* Scope.provide(make(workspaceId), scope);
        const raced = shares.get(workspaceId);
        if (raced) {
          // Another borrower created it while this kernel was built; this one never ran.
          yield* provider.close.pipe(Effect.andThen(Scope.close(scope, Exit.void)), Effect.orDie);
          raced.leases++;
          return yield* view(workspaceId, raced, true);
        }
        const share: Share = { provider, scope, leases: 1 };
        shares.set(workspaceId, share);
        return yield* view(workspaceId, share, false);
      })
    );

  return {
    borrow,
    /** Native consumers: the view closes with the consumer's Scope. */
    acquire: (workspaceId: string) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const borrowed = yield* borrow(workspaceId);
          yield* Effect.addFinalizer(() => borrowed.close);
          return borrowed;
        })
      ),
  };
}
