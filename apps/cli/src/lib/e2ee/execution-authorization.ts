import { Cause, Clock, Effect, Fiber, Result } from 'effect';
import { z } from 'zod';
import { Bytes, contentPermissions } from '@lody/e2ee-core/protocol';
import type { CloudE2eePort } from '@lody/platform';
import { CloudE2eeLedgerOutage } from '../cloud-e2ee-errors';
import { withinAuthorityLimit, type AuthorityStamp } from './authority-clock';
import type { makeCliE2eeRuntime } from './runtime';

export type ExecutionAuthorization =
  | {
      readonly _tag: 'Authorized';
      readonly isCurrent?: () => boolean;
      /** Whose authority admitted the signer: the machine owner's own membership,
       * or another member through the owner's sharing policy. Only `owner` may
       * lend the turn's identity to derived work. */
      readonly principal?: 'owner' | 'member';
    }
  | {
      readonly _tag: 'Denied';
      readonly reason:
        | 'invalid-request'
        | 'not-authorized'
        | 'e2ee_machine_not_owned'
        | 'e2ee_machine_not_shared'
        | 'unavailable'
        | 'closed';
    };
const denied = (reason: Extract<ExecutionAuthorization, { _tag: 'Denied' }>['reason']) =>
  ({ _tag: 'Denied', reason }) as const;
const requesterSchema = z.string().regex(/^[0-9a-f]{64}$/);
const ttl = 15 * 60_000;
/** Windows of specs/e2ee/execution-freshness-outage.md, from the last successful latest read. */
const OUTAGE_EXECUTION_WINDOW_MS = 4 * 60 * 60_000;
const OUTAGE_READ_WINDOW_MS = 24 * 60 * 60_000;
/** A failed read is not repeated for this long, so an outage does not delay every request. */
const OUTAGE_RETRY_MS = 60_000;
type Stamp = AuthorityStamp;

/** One workspace/device-identity lifetime. This gate grants admission only for the
 * immediate new execution; callers must authenticate the frame and claim its journal
 * separately. Never persist or forward its result as an authorization certificate. */
export const makeCliE2eeExecutionAuthorization = Effect.fn('CliE2eeExecutionAuthorization.make')(
  function* (options: {
    workspaceId: string;
    credential: string;
    cloud: Pick<CloudE2eePort, 'getHistory'>;
    sharing?: (
      requesterDevice: string,
      localProjectId?: string
    ) => Effect.Effect<{ allowed: boolean; isCurrent?: () => boolean }, unknown>;
    onCredentialFailure?: (cause: unknown) => void;
    /** A window is in use, or `null` once access is confirmed or refused again. */
    onWindowNotice?: (notice: { signInExpired: boolean } | null) => void;
    runtime: Pick<
      Effect.Success<ReturnType<typeof makeCliE2eeRuntime>>,
      'status' | 'ingest' | 'executionLedger' | 'executionGeneration'
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
    let lastRead: Stamp | undefined;
    let outage: { at: Stamp; signInExpired: boolean } | undefined;
    let windowGeneration = 0;
    let noticed: boolean | undefined;
    const clearNotice = () => {
      if (noticed === undefined) return;
      noticed = undefined;
      options.onWindowNotice?.(null);
    };
    const confirmRead = (started: Stamp) => {
      if (!lastRead || started.monotonic > lastRead.monotonic) lastRead = started;
      outage = undefined;
      clearNotice();
    };
    const endWindow = () => {
      windowGeneration += 1;
      lastRead = undefined;
      outage = undefined;
      clearNotice();
    };
    let flight: Fiber.Fiber<Stamp | undefined> | undefined;
    let closed = false;
    const authorityController = new AbortController();
    // Fence synchronously before asynchronous owner drain. Scope close still
    // owns the actual raw reads and final resource release.
    const invalidate = () => {
      closed = true;
      authorityController.abort();
      grants.clear();
    };
    yield* Effect.addFinalizer(() => Effect.sync(invalidate));

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
          catch: (cause) => {
            options.onCredentialFailure?.(cause);
            return cause;
          },
        });
        // One authenticated endpoint for all pages, never a requester-supplied proof.
        checkpoint ??= { ...page.checkpoint };
        if (
          checkpoint.length < initial.length ||
          (checkpoint.length === initial.length && checkpoint.headHash !== initial.headHash)
        ) {
          endWindow();
          return undefined;
        }
        if (
          checkpoint.length !== page.checkpoint.length ||
          checkpoint.headHash !== page.checkpoint.headHash
        ) {
          endWindow();
          return undefined;
        }
        status = yield* options.runtime.ingest(page);
        if (!fresh(started, yield* stamp)) {
          endWindow();
          return undefined;
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      confirmRead(started);
      return started;
    }).pipe(
      Effect.timeout(30_000),
      Effect.catchCause((cause) => {
        if (Cause.hasInterrupts(cause)) return Effect.interrupt;
        return Effect.gen(function* () {
          const failure = Cause.squash(cause);
          if (failure instanceof CloudE2eeLedgerOutage)
            outage = { at: yield* stamp, signInExpired: failure.signInExpired };
          else if (Cause.isTimeoutError(failure))
            outage = { at: yield* stamp, signInExpired: false };
          else endWindow();
          return undefined;
        });
      }),
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
        if (closed) return undefined;
        if (!flight) flight = yield* Effect.forkIn(Effect.interruptible(refresh), scope);
        return yield* restore(Fiber.join(flight));
      })
    );
    const authorize = Effect.fn('CliE2eeExecutionAuthorization.authorize')(
      function* (
        workspaceId: string,
        requesterDevice: string,
        access: 'read' | 'execute' | 'owned-execute',
        localProjectId?: string
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
        if (closed) return denied('closed');
        for (const [device, start] of grants) if (!fresh(start, now)) grants.delete(device);
        let start = grants.get(requesterDevice);
        let relaxed = false;
        if (!start) {
          relaxed =
            !!outage &&
            !!lastRead &&
            withinAuthorityLimit(outage.at, now, OUTAGE_RETRY_MS) &&
            withinAuthorityLimit(lastRead, now, OUTAGE_READ_WINDOW_MS);
          if (!relaxed) {
            start = yield* refreshOnce;
            relaxed = !start && !!outage;
          }
          if (relaxed) start = lastRead;
        }
        if (closed) return denied('closed');
        if (!start || (!relaxed && !fresh(start, yield* stamp))) return denied('unavailable');
        const grantedFrom = start;
        // Offline state supplies immediate known revocations, never freshness.
        let generation = options.runtime.executionGeneration();
        let policyCurrent: (() => boolean) | undefined;
        const view = yield* options.runtime.executionLedger();
        const state = view.inspectState();
        const local = state.devices.get(self);
        if (!local || !state.members.has(Buffer.from(local.membershipId.toBytes()).toString('hex')))
          return denied('not-authorized');
        const permissions = yield* Effect.fromResult(contentPermissions(view, requester.success));
        const reader = state.devices.get(requesterDevice);
        const mayRead =
          reader &&
          reader.kind !== 'recovery' &&
          state.members.has(Buffer.from(reader.membershipId.toBytes()).toString('hex'));
        if (access === 'read' ? !mayRead : !permissions.mayWriteDocument) {
          grants.delete(requesterDevice);
          return denied('not-authorized');
        }
        const sender = state.devices.get(requesterDevice);
        const principal =
          sender &&
          Buffer.from(sender.membershipId.toBytes()).equals(
            Buffer.from(local.membershipId.toBytes())
          )
            ? ('owner' as const)
            : ('member' as const);
        const windowMs =
          principal === 'member'
            ? 0
            : access === 'read'
              ? OUTAGE_READ_WINDOW_MS
              : OUTAGE_EXECUTION_WINDOW_MS;
        const current = (at: Stamp) =>
          relaxed ? withinAuthorityLimit(grantedFrom, at, windowMs) : fresh(grantedFrom, at);
        if (relaxed && !current(yield* stamp)) return denied('unavailable');
        if (principal === 'member') {
          grants.delete(requesterDevice);
          if (access !== 'execute') return denied('e2ee_machine_not_owned');
          if (!options.sharing) return denied('e2ee_machine_not_shared');
          const shared = yield* options
            .sharing(requesterDevice, localProjectId)
            .pipe(Effect.catch(() => Effect.succeed({ allowed: false, isCurrent: undefined })));
          if (!shared.allowed) return denied('e2ee_machine_not_shared');
          policyCurrent = shared.isCurrent;
          // The policy check yields, and verified records (a removal, revocation or
          // role change) may land meanwhile. Pin the generation first, then recheck
          // the requester and this machine against the ledger it names: a later
          // ingest makes isCurrent() false, an earlier one is seen here.
          generation = options.runtime.executionGeneration();
          const after = yield* options.runtime.executionLedger();
          const latest = after.inspectState();
          const machine = latest.devices.get(self);
          const signer = latest.devices.get(requesterDevice);
          if (
            !machine ||
            !latest.members.has(Buffer.from(machine.membershipId.toBytes()).toString('hex')) ||
            !signer ||
            Buffer.from(signer.membershipId.toBytes()).equals(
              Buffer.from(machine.membershipId.toBytes())
            ) ||
            !(yield* Effect.fromResult(contentPermissions(after, requester.success)))
              .mayWriteDocument
          )
            return denied('not-authorized');
        }
        if (!current(yield* stamp)) return denied('unavailable');
        // Revocation may arrive while a native check yields. Nothing may publish
        // an old grant after the synchronous host fence, including cached reads.
        if (closed) return denied('closed');
        // Bounded cache; eviction can only require an earlier authenticated reread.
        if (grants.size >= 1024) grants.clear();
        if (relaxed) {
          const signInExpired = outage?.signInExpired ?? false;
          if (noticed !== signInExpired) {
            noticed = signInExpired;
            options.onWindowNotice?.({ signInExpired });
          }
        } else grants.set(requesterDevice, grantedFrom);
        if (access === 'read') return { _tag: 'Authorized' };
        return {
          _tag: 'Authorized',
          principal,
          isCurrent: () =>
            !closed &&
            options.runtime.executionGeneration() === generation &&
            current({
              wall: clock.currentTimeMillisUnsafe(),
              monotonic: clock.monotonicTimeNanosUnsafe(),
            }) &&
            (policyCurrent?.() ?? true),
        };
      },
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed(denied('unavailable'))
      )
    );
    return {
      authorizeExecution: (workspaceId: string, requesterDevice: string, localProjectId?: string) =>
        authorize(workspaceId, requesterDevice, 'execute', localProjectId),
      authorizeOwnedExecution: (workspaceId: string, requesterDevice: string) =>
        authorize(workspaceId, requesterDevice, 'owned-execute'),
      refreshLedger: refreshOnce.pipe(
        Effect.flatMap((value) => (value ? Effect.void : Effect.fail('unavailable' as const)))
      ),
      authorizeRead: (workspaceId: string, requesterDevice: string) =>
        authorize(workspaceId, requesterDevice, 'read'),
      /** A background ledger read counts as a successful read once its callback runs. */
      beginLatestRead: () => {
        const started = {
          wall: clock.currentTimeMillisUnsafe(),
          monotonic: clock.monotonicTimeNanosUnsafe(),
        };
        const generation = windowGeneration;
        return () => {
          if (!closed && generation === windowGeneration) confirmRead(started);
        };
      },
      authoritySignal: authorityController.signal,
      invalidate,
    };
  }
);
