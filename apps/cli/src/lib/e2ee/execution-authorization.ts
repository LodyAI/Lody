import { Cause, Clock, Effect, Fiber, Result } from 'effect';
import { z } from 'zod';
import { Bytes, contentPermissions } from '@lody/e2ee-core/protocol';
import type { CloudE2eePort } from '@lody/platform';
import type { makeCliE2eeRuntime } from './runtime';

export type ExecutionAuthorization =
  | { readonly _tag: 'Authorized' }
  | {
      readonly _tag: 'Denied';
      readonly reason: 'invalid-request' | 'not-authorized' | 'unavailable' | 'closed';
    };
const denied = (reason: Extract<ExecutionAuthorization, { _tag: 'Denied' }>['reason']) =>
  ({ _tag: 'Denied', reason }) as const;
const requesterSchema = z.string().regex(/^[0-9a-f]{64}$/);
const ttl = 15 * 60_000;
type Stamp = { wall: number; monotonic: bigint };

/** One workspace/device-identity lifetime. This gate grants admission only for the
 * immediate new execution; callers must authenticate the frame and claim its journal
 * separately. Never persist or forward its result as an authorization certificate. */
export const makeCliE2eeExecutionAuthorization = Effect.fn('CliE2eeExecutionAuthorization.make')(
  function* (options: {
    workspaceId: string;
    credential: string;
    cloud: Pick<CloudE2eePort, 'getHistory'>;
    runtime: Pick<
      Effect.Success<ReturnType<typeof makeCliE2eeRuntime>>,
      'status' | 'ingest' | 'executionLedger'
    >;
  }) {
    const scope = yield* Effect.scope;
    const clock = yield* Clock.Clock;
    const self = (yield* options.runtime.status()).devicePublicKey;
    const stamp = Effect.gen(function* () {
      return { wall: yield* clock.currentTimeMillis, monotonic: yield* clock.monotonicTimeNanos };
    });
    const fresh = (start: Stamp, now: Stamp) =>
      now.wall >= start.wall &&
      now.wall - start.wall < ttl &&
      now.monotonic >= start.monotonic &&
      now.monotonic - start.monotonic < BigInt(ttl) * 1_000_000n;
    const grants = new Map<string, Stamp>();
    let flight: Fiber.Fiber<Stamp | undefined> | undefined;
    let closed = false;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        closed = true;
        grants.clear();
      })
    );

    const refresh = Effect.gen(function* () {
      const started = yield* stamp;
      let status = yield* options.runtime.status();
      const initial = status;
      let cursor: string | undefined;
      let checkpoint: Parameters<CloudE2eePort['getHistory']>[0]['checkpoint'];
      do {
        const page = yield* Effect.tryPromise({
          try: () =>
            options.cloud.getHistory({
              workspaceId: options.workspaceId,
              credential: options.credential,
              ...(cursor
                ? { cursor, checkpoint }
                : status.position
                  ? { after: status.position }
                  : {}),
            }),
          catch: () => 'unavailable' as const,
        });
        // One authenticated endpoint for all pages, never a requester-supplied proof.
        checkpoint ??= { ...page.checkpoint };
        if (
          checkpoint.length < initial.length ||
          (checkpoint.length === initial.length && checkpoint.headHash !== initial.headHash)
        )
          return undefined;
        if (
          checkpoint.length !== page.checkpoint.length ||
          checkpoint.headHash !== page.checkpoint.headHash
        )
          return undefined;
        status = yield* options.runtime.ingest(page);
        if (!fresh(started, yield* stamp)) return undefined;
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return started;
    }).pipe(
      Effect.timeout(30_000),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed(undefined)
      ),
      Effect.ensuring(
        Effect.sync(() => {
          flight = undefined;
        })
      )
    );

    // A cancelled waiter leaves the shared producer alive for its siblings. The
    // workspace Scope cancels the producer at close; late read replies cannot ingest.
    const refreshOnce = Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (!flight) flight = yield* Effect.forkIn(Effect.interruptible(refresh), scope);
        return yield* restore(Fiber.join(flight));
      })
    );
    const authorizeExecution = Effect.fn('CliE2eeExecutionAuthorization.authorizeExecution')(
      function* (
        workspaceId: string,
        requesterDevice: string
      ): Effect.fn.Return<ExecutionAuthorization, unknown> {
        if (closed) return denied('closed');
        if (
          workspaceId !== options.workspaceId ||
          !requesterSchema.safeParse(requesterDevice).success
        )
          return denied('invalid-request');
        const requester = Bytes.signingPublicKey(Buffer.from(requesterDevice, 'hex'));
        if (Result.isFailure(requester)) return denied('invalid-request');
        const now = yield* stamp;
        for (const [device, start] of grants) if (!fresh(start, now)) grants.delete(device);
        const start = grants.get(requesterDevice) ?? (yield* refreshOnce);
        if (closed) return denied('closed');
        if (!start || !fresh(start, yield* stamp)) return denied('unavailable');
        // Offline state supplies immediate known revocations, never freshness.
        const view = yield* options.runtime.executionLedger();
        const state = view.inspectState();
        const local = state.devices.get(self);
        if (!local || !state.members.has(Buffer.from(local.membershipId.toBytes()).toString('hex')))
          return denied('not-authorized');
        const permissions = yield* Effect.fromResult(contentPermissions(view, requester.success));
        if (!permissions.mayWriteDocument) {
          grants.delete(requesterDevice);
          return denied('not-authorized');
        }
        if (!fresh(start, yield* stamp)) return denied('unavailable');
        // Bounded cache; eviction can only require an earlier authenticated reread.
        if (grants.size >= 1024) grants.clear();
        grants.set(requesterDevice, start);
        return { _tag: 'Authorized' };
      },
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed(denied('unavailable'))
      )
    );
    return { authorizeExecution };
  }
);
