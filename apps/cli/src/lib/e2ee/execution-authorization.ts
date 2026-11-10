import { Cause, Clock, Effect, Fiber, Result } from 'effect';
import { z } from 'zod';
import { Bytes, contentPermissions, accountIdFromUserId } from '@lody/e2ee-core/protocol';
import type { CloudE2eePort, E2eeMachineSharingView } from '@lody/platform';
import { CloudE2eeLedgerOutage } from '../cloud-e2ee-errors';
import { authorityClocksAgree, withinAuthorityLimit, type AuthorityStamp } from './authority-clock';
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
        /** The signer has no write authority in the current ledger. */
        | 'not-authorized'
        /** This machine's own device is no longer a member. */
        | 'e2ee_machine_not_member'
        | 'e2ee_machine_not_owned'
        | 'e2ee_schedule_not_authorized'
        | 'e2ee_signature_missing'
        | 'e2ee_signature_invalid'
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
/** Wall-clock ends of the outage window, for the person to see; never authority. */
export type E2eeAccessWindow = { readonly executionUntilMs: number; readonly readUntilMs: number };

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
    sessionSharing?: (
      requesterDevice: string,
      sessionId: string,
      sessionOwnerUserId?: string
    ) => Effect.Effect<{ allowed: boolean; isCurrent: () => boolean }, unknown>;
    onCredentialFailure?: (cause: unknown) => void;
    /** True while a window is in use, with its wall-clock ends (display only); false once
     * access is confirmed or refused again. */
    onWindowNotice?: (active: boolean, window?: E2eeAccessWindow) => void;
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
    let outage: { at: Stamp } | undefined;
    let windowGeneration = 0;
    let noticed = false;
    const clearNotice = () => {
      if (!noticed) return;
      noticed = false;
      options.onWindowNotice?.(false);
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
          if (failure instanceof CloudE2eeLedgerOutage || Cause.isTimeoutError(failure))
            outage = { at: yield* stamp };
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
        access: 'read' | 'execute' | 'owned-execute' | 'session-read',
        localProjectId?: string,
        sessionId?: string,
        sessionOwnerUserId?: string
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
        const grantedInWindow = windowGeneration;
        // Offline state supplies immediate known revocations, never freshness.
        let generation = options.runtime.executionGeneration();
        let policyCurrent: (() => boolean) | undefined;
        const view = yield* options.runtime.executionLedger();
        const state = view.inspectState();
        const local = state.devices.get(self);
        if (!local || !state.members.has(Buffer.from(local.membershipId.toBytes()).toString('hex')))
          return denied('e2ee_machine_not_member');
        const permissions = yield* Effect.fromResult(contentPermissions(view, requester.success));
        const reader = state.devices.get(requesterDevice);
        const mayRead =
          reader &&
          reader.kind !== 'recovery' &&
          state.members.has(Buffer.from(reader.membershipId.toBytes()).toString('hex'));
        if (
          access === 'read' || access === 'session-read' ? !mayRead : !permissions.mayWriteDocument
        ) {
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
        const current = (at: Stamp) => {
          if (!relaxed) return fresh(grantedFrom, at);
          if (windowGeneration !== grantedInWindow) return false;
          if (!authorityClocksAgree(grantedFrom, at)) {
            // Only a successful read reopens this: realigned clocks prove nothing.
            endWindow();
            return false;
          }
          return withinAuthorityLimit(grantedFrom, at, windowMs);
        };
        if (relaxed && !current(yield* stamp)) return denied('unavailable');
        if (principal === 'member') {
          grants.delete(requesterDevice);
          if (access === 'session-read') {
            if (!sessionId || !options.sessionSharing) return denied('e2ee_machine_not_shared');
            const generation = options.runtime.executionGeneration();
            const shared = yield* options.sessionSharing(
              requesterDevice,
              sessionId,
              sessionOwnerUserId
            );
            if (
              !shared.allowed ||
              !shared.isCurrent() ||
              generation !== options.runtime.executionGeneration()
            )
              return denied('e2ee_machine_not_shared');
            // The session policy check may ingest new ledger state. Revalidate both
            // devices and reader eligibility before allowing even a history reply.
            const after = (yield* options.runtime.executionLedger()).inspectState();
            const machine = after.devices.get(self),
              signer = after.devices.get(requesterDevice);
            if (
              !machine ||
              !signer ||
              signer.kind === 'recovery' ||
              !after.members.has(Buffer.from(machine.membershipId.toBytes()).toString('hex')) ||
              !after.members.has(Buffer.from(signer.membershipId.toBytes()).toString('hex')) ||
              !current(yield* stamp)
            )
              return denied('not-authorized');
            const isCurrent = () =>
              !closed &&
              options.runtime.executionGeneration() === generation &&
              shared.isCurrent() &&
              current({
                wall: clock.currentTimeMillisUnsafe(),
                monotonic: clock.monotonicTimeNanosUnsafe(),
              });
            return isCurrent()
              ? { _tag: 'Authorized' as const, isCurrent }
              : denied('not-authorized');
          }
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
            !latest.members.has(Buffer.from(machine.membershipId.toBytes()).toString('hex'))
          )
            return denied('e2ee_machine_not_member');
          if (
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
          if (!noticed) {
            noticed = true;
            // The window runs from the last successful latest read, never from now.
            options.onWindowNotice?.(true, {
              executionUntilMs: grantedFrom.wall + OUTAGE_EXECUTION_WINDOW_MS,
              readUntilMs: grantedFrom.wall + OUTAGE_READ_WINDOW_MS,
            });
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
      authorizeSessionRead: (
        workspaceId: string,
        requesterDevice: string,
        rootSessionId: string,
        sessionOwnerUserId?: string
      ) =>
        authorize(
          workspaceId,
          requesterDevice,
          'session-read',
          undefined,
          rootSessionId,
          sessionOwnerUserId
        ),
      authorizeRead: (workspaceId: string, requesterDevice: string) =>
        authorize(workspaceId, requesterDevice, 'read'),
      /** A reply moved the ledger back. Ordinary grants are unaffected; a later read reopens it. */
      endOutageWindow: endWindow,
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

export type CliE2eeSessionReadTarget = {
  machineId: string;
  rootSessionId: string;
  requesterUserId: string;
  sessionOwnerUserId?: string;
  localProjectId?: string;
};
/** Proxy reads retain the intersection of the source account and declared human. */
export const authorizeCliE2eeSessionTarget = (
  options: {
    runtime: Pick<
      Effect.Success<ReturnType<typeof makeCliE2eeRuntime>>,
      'executionLedger' | 'executionGeneration'
    >;
    sourceDevice: string;
    readPolicy?: (machineId: string) => Effect.Effect<E2eeMachineSharingView, unknown>;
  },
  target: CliE2eeSessionReadTarget
) =>
  Effect.gen(function* () {
    const state = (yield* options.runtime.executionLedger()).inspectState();
    const generation = options.runtime.executionGeneration();
    const source = state.devices.get(options.sourceDevice);
    if (!source || source.kind === 'recovery') return false;
    const issuer = state.members.get(Buffer.from(source.membershipId.toBytes()).toString('hex'));
    const account = issuer && accountIdFromUserId(issuer.userId);
    if (!account || Result.isFailure(account)) return false;
    const machine = [...state.devices.values()].find(
      (row) => row.kind === 'machine' && row.machineId === target.machineId
    );
    if (!machine) return false;
    let policy: E2eeMachineSharingView | undefined;
    const check = Effect.fnUntraced(function* (userId: string) {
      const member = [...state.members.entries()].find(([, row]) => {
        const account = accountIdFromUserId(row.userId);
        return Result.isSuccess(account) && account.success === userId;
      });
      if (!member) return false;
      if (
        Buffer.from(machine.membershipId.toBytes()).toString('hex') === member[0] ||
        target.sessionOwnerUserId === userId
      )
        return true;
      if (!options.readPolicy) return false;
      policy ??= yield* options.readPolicy(target.machineId);
      if (policy.removed || policy.unavailable) return false;
      return (
        (member[1].role !== 'guest' &&
          policy.sharedWithTeam &&
          (!target.localProjectId || policy.projects.includes(target.localProjectId))) ||
        policy.sessions.some(
          (row) =>
            row.sessionId === target.rootSessionId &&
            (row.audience === 'team' || row.audience.userId === userId)
        )
      );
    });
    const allowed = (yield* check(account.success)) && (yield* check(target.requesterUserId));
    return allowed && generation === options.runtime.executionGeneration();
  });
