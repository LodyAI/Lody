import { memberPairingOffer } from '@lody/e2ee-client/member';
import { Cause, Effect, Exit, Result, Scope, Semaphore, type Layer } from 'effect';
import {
  makePersonalWorkspaceRuntime,
  personalRuntimeAccountRequester,
  personalRuntimeRecovery,
  type PersonalRuntimeRecovery,
  accountPairingOffer,
  PersonalCloseIncomplete,
  PersonalHostError,
  verifyPersonalOffer,
  type PersonalPairingOffer,
  type PersonalHostPorts,
  type PersonalRuntimeOptions,
} from '@lody/e2ee-client';
import { Bytes } from '@lody/e2ee-core/protocol';
import type {
  E2eeAppendRecordRequest,
  E2eeAppendRecordReply,
  E2eeWorkspaceBatchReply,
  E2eeWorkspaceHistoryRequest,
  E2eeWorkspaceHistoryPage,
} from '@lody/cloud-api';
import type { ClientCustodyBinding } from '@lody/e2ee-core/services';
import {
  makeAccountPairing,
  type AccountPairingRelay,
  type AccountPairingStore,
} from '@lody/e2ee-client/account-pairing';
import {
  makePortableAccountPairingApprover,
  makePortableAccountPairingRequester,
  type AccountPairingWorkspaceHint,
  type AccountPairingIdentityHost,
  type AccountPairingApproverSession,
  type AccountPairingKeyDeliveryEvent,
} from '@lody/e2ee-client/account-requester';
import type {
  E2eeAccountApprovalSession,
  E2eeAccountPairingRuntime,
  E2eeRuntimeFactory,
  E2eeWorkspaceRuntime,
  PlatformSessionState,
  ReadonlyStore,
} from '@lody/platform';
import { assertPersonalEntryOffer, samePersonalOffer, type PersonalEntryPins } from './entry-pins';
import { E2eeAccessRefusal } from './network';

const fail = (code: PersonalHostError['code']) => new PersonalHostError({ code });
/** The shared workflow's typed pairing refusal (`@lody/platform` `accountPairingErrorCode`). */
const pairingFail = (code: 'invalid-input' | 'pairing-tampered') =>
  Object.assign(new Error(`e2ee_${code}`), { code });
const fromHex = (value: string) =>
  Uint8Array.from(value.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
export interface PersonalEntryOptions {
  readonly pins: PersonalEntryPins;
  readonly run: PersonalRuntimeOptions<unknown>['run'];
  readonly ports: (input: {
    accountId: string;
    offer: PersonalPairingOffer;
    drainOld: (binding: ClientCustodyBinding) => Effect.Effect<void, unknown>;
    currentAccount: () => Effect.Effect<string | null>;
    mode: 'create-or-open' | 'open-existing';
  }) => Layer.Layer<PersonalHostPorts, unknown>;
  readonly ledgerRecords: (
    accountId: string,
    offer: PersonalPairingOffer
  ) => PersonalRuntimeOptions<unknown>['ledgerRecords'];
  /** Commit one prepared creation to a server workspace ID. Runs only after the
   * authenticated create response names the exact signed genesis. */
  readonly recordCreated?: (input: {
    workspaceId: string;
    genesisHash: string;
    requestId?: string;
    accountId: string;
  }) => Promise<void>;
  /** Account-wide pairing on a portable host. Absence hides the surface. */
  readonly accountPairing?: {
    readonly store: (accountId: string) => AccountPairingStore;
    readonly relay: AccountPairingRelay;
    readonly deviceName: string;
    readonly appendRecord: (request: E2eeAppendRecordRequest) => Promise<unknown>;
    readonly historyBatch?: (
      items: E2eeWorkspaceHistoryRequest[]
    ) => Promise<E2eeWorkspaceBatchReply<E2eeWorkspaceHistoryPage>>;
    readonly appendRecordsBatch?: (
      items: E2eeAppendRecordRequest[]
    ) => Promise<E2eeWorkspaceBatchReply<E2eeAppendRecordReply>>;
    /** Upper bound of each pairing cloud port call in milliseconds. Defaults to 30 s. */
    readonly requestTimeoutMs?: number;
    readonly workspaceName?: (workspaceId: string) => string | null;
    /** Optional requester composition. Ordinary reader open never invokes these ports. */
    readonly requester?: {
      readonly workspaces: () => Promise<readonly AccountPairingWorkspaceHint[]>;
      readonly history: (request: E2eeWorkspaceHistoryRequest) => Promise<E2eeWorkspaceHistoryPage>;
      readonly historyBatch?: (
        items: E2eeWorkspaceHistoryRequest[]
      ) => Promise<E2eeWorkspaceBatchReply<E2eeWorkspaceHistoryPage>>;
    };
    /** Observes the background key delivery the shared approver starts after each
     * committed admission; it retries on its own bounded schedule until mailbox
     * evidence says `delivered`, the bound is spent or this account's session ends. */
    readonly onKeyDelivery?: (event: AccountPairingKeyDeliveryEvent) => void;
    /** The shared approver's due-retry schedule; owning tests inject `sleep`. */
    readonly keyDeliveryRetry?: Parameters<
      typeof makePortableAccountPairingApprover
    >[0]['keyDeliveryRetry'];
  };
  /** The host ports compose a native iroh port; the facade then forwards the route. */
  readonly iroh?: boolean;
}
export interface PersonalEntryRecovery {
  restore(
    workspaceId: string,
    offer: PersonalPairingOffer,
    input: Parameters<PersonalRuntimeRecovery['restore']>[0]
  ): Promise<Effect.Success<ReturnType<PersonalRuntimeRecovery['restore']>>>;
  setup(
    workspaceId: string,
    input: Parameters<PersonalRuntimeRecovery['setup']>[0]
  ): Promise<Effect.Success<ReturnType<PersonalRuntimeRecovery['setup']>>>;
}
const recoveries = new WeakMap<E2eeWorkspaceRuntime, PersonalEntryRecovery>();
/** Closed commands borrowing the application's existing identity owner. */
export const personalEntryRecovery = (runtime: E2eeWorkspaceRuntime) =>
  recoveries.get(runtime) ?? null;
type RecordEntry = {
  accountId: string;
  workspaceId: string;
  offer: PersonalPairingOffer;
  scope: Scope.Closeable;
  retired: boolean;
  readers: Set<string>;
  openingOwner?: string;
  ready: Promise<E2eeWorkspaceRuntime>;
  close?: Promise<void>;
  failure?: unknown;
  recovery?: Promise<void>;
};
const key = (accountId: string, workspaceId: string) => JSON.stringify([accountId, workspaceId]);
const sameOffer = samePersonalOffer;
/** The exact public codes the shared providers recognise as terminal access loss. */
type AccessLoss = 'e2ee_device_revoked' | 'e2ee_member_removed';
/**
 * What a failed runtime call proves about access. Only two sources count: a credential-bound
 * endpoint's refusal (typed by the network adapter, never a matching message or another
 * endpoint), and the public runtime's own `revoked`, decided against this device's verified
 * ledger. Transport, JWT, parsing and every other failure prove nothing.
 */
const failureLoss = (error: unknown): AccessLoss | null => {
  if (error instanceof PersonalHostError && error.code === 'revoked') return 'e2ee_device_revoked';
  // The public runtime's own exact result for a typed verified-ledger loss: a plain `Error`
  // whose message is the code. Only its direct rejection counts; the network adapter wraps
  // every cloud failure in its own types, so no server message reaches here in this shape.
  if (
    error instanceof Error &&
    Object.getPrototypeOf(error) === Error.prototype &&
    (error.message === 'e2ee_device_revoked' || error.message === 'e2ee_member_removed')
  )
    return error.message;
  // The refusal is nested: a ledger read wraps it in the feed error, which the session wraps
  // again, and multi-reason runtime failures keep it inside their Cause.
  const pending: unknown[] = [error];
  for (let seen = 0; pending.length && seen < 64; seen++) {
    const current = pending.shift();
    if (current instanceof E2eeAccessRefusal) return current.code;
    if (Cause.isCause(current))
      for (const reason of current.reasons)
        pending.push(
          Cause.isFailReason(reason)
            ? reason.error
            : Cause.isDieReason(reason)
              ? reason.defect
              : undefined
        );
    else if (current && typeof current === 'object' && 'cause' in current)
      pending.push(current.cause);
  }
  return null;
};
/** A verified-ledger status in which this device, or its membership, is no longer active. */
const statusLoss = (value: unknown): AccessLoss | null => {
  if (!value || typeof value !== 'object' || !('deviceKind' in value) || !('memberRole' in value))
    return null;
  if (value.deviceKind === null) return 'e2ee_device_revoked';
  if (value.memberRole === null) return 'e2ee_member_removed';
  return null;
};
const unwrap = <A>(exit: Exit.Exit<A, unknown>): A => {
  if (Exit.isSuccess(exit)) return exit.value;
  if (exit.cause.reasons.length === 1) throw Cause.squash(exit.cause);
  throw new Error('e2ee_entry_close_failed', { cause: exit.cause });
};
/** Application entry owns executors and physical lifetime. Factory calls only borrow a pure facade. */
export function personalEntry(options: PersonalEntryOptions) {
  const execute = options.run;
  const executeExit = <A>(program: Effect.Effect<A, unknown>) => execute(Effect.exit(program));
  const records = new Map<string, RecordEntry>();
  const all = new Set<RecordEntry>();
  const facades = new WeakMap<ReadonlyStore<PlatformSessionState>, E2eeWorkspaceRuntime>();
  const subscriptions = new Map<ReadonlyStore<PlatformSessionState>, () => void>();
  let closed = false;
  const accountWaiters = new Set<() => void>();
  const finish = (entry: RecordEntry) => {
    entry.failure = undefined;
    all.delete(entry);
    if (records.get(key(entry.accountId, entry.workspaceId)) === entry)
      records.delete(key(entry.accountId, entry.workspaceId));
  };
  const retire = (entry: RecordEntry): Promise<void> => {
    entry.retired = true;
    for (const publish of accountWaiters) publish();
    return (entry.close ??= (async () => {
      await entry.ready.catch(() => {});
      const result = await executeExit(Scope.close(entry.scope, Exit.void));
      if (Exit.isSuccess(result)) {
        finish(entry);
        return;
      }
      // Preserve the entire failure. Deadlines are waiter outcomes, not resource release.
      entry.failure = result;
      const owners = result.cause.reasons.map((reason) =>
        Cause.isFailReason(reason)
          ? reason.error
          : Cause.isDieReason(reason)
            ? reason.defect
            : undefined
      );
      if (owners.length && owners.every((value) => value instanceof PersonalCloseIncomplete)) {
        entry.recovery = (async () => {
          for (const value of owners) {
            if (!(value instanceof PersonalCloseIncomplete)) throw fail('closed');
            unwrap(await executeExit(value.owner.awaitSettled()));
          }
          finish(entry);
        })();
        void entry.recovery.catch((error) => {
          entry.failure = error;
        });
      }
      unwrap(result);
    })().catch((error) => {
      if (entry.failure === undefined) entry.failure = error;
      throw error;
    }));
  };
  const createRuntime: E2eeRuntimeFactory = ({ session }) => {
    const existingFacade = facades.get(session);
    if (existingFacade) return existingFacade;
    const pending = new Map<
      string,
      { cancelled: boolean; accountId: string | null; started: boolean; entry?: RecordEntry }
    >();
    let lastAccount: string | null = null;
    const identity = () => {
      const state = session.get();
      return state.status === 'authenticated'
        ? state.user.id
        : state.status === 'unauthenticated' && state.uncertain
          ? lastAccount
          : null;
    };
    const check = (accountId: string) => {
      if (closed || identity() !== accountId) throw fail('scope-mismatch');
    };
    const observe = () => {
      if (subscriptions.has(session)) return;
      const initial = session.get();
      if (initial.status === 'authenticated') lastAccount = initial.user.id;
      const stop = session.subscribe(() => {
        const state = session.get();
        if (state.status === 'loading' || (state.status === 'unauthenticated' && state.uncertain))
          return;
        lastAccount = state.status === 'authenticated' ? state.user.id : null;
        for (const entry of all)
          if (entry.accountId !== lastAccount) void retire(entry).catch(() => {});
      });
      subscriptions.set(session, stop);
    };
    // A refresh does not prove logout. Hold the account guard until a definite
    // session result; a retained in-page identity may continue local offline reads.
    const resolveAccount = (live: () => boolean = () => true) =>
      Effect.callback<string | null>((resume) => {
        let done = false,
          stop = () => {};
        const publish = () => {
          if (done || (!closed && live() && session.get().status === 'loading')) return;
          done = true;
          stop();
          accountWaiters.delete(publish);
          resume(Effect.succeed(closed || !live() ? null : identity()));
        };
        accountWaiters.add(publish);
        stop = session.subscribe(publish);
        publish();
        if (done) stop();
        return Effect.sync(() => {
          done = true;
          stop();
          accountWaiters.delete(publish);
        });
      });
    const account = async () => {
      observe();
      const id = await execute(resolveAccount());
      return id
        ? {
            userId: id,
            source:
              session.get().status === 'authenticated'
                ? ('network' as const)
                : ('offline' as const),
          }
        : null;
    };
    /**
     * Confirms an access loss for this exact entry and makes it terminal for that offer: the
     * pin stops routing it as ready (offer and genesis kept, so only a same-genesis pairing
     * replaces it) and the entry retires through its Scope. Only a definite session of the
     * same account, and a pin holding this exact offer as ready (or already cancelled by an
     * earlier loss, as after a relaunch) confirm it; otherwise the caller keeps its original
     * failure. A cancelled pairing that was never admitted cannot reach here: its identity
     * never opens, so it has no status, ledger verdict or credential. Retirement drains in
     * the background; the next acquisition waits for it.
     */
    const lose = async (entry: RecordEntry, accountId: string) => {
      const definite = () => {
        const state = session.get();
        return !closed && state.status === 'authenticated' && state.user.id === accountId;
      };
      if (!definite()) return false;
      try {
        const pin = await execute(options.pins.read(accountId, entry.workspaceId));
        if (!pin || pin.phase === 'pending' || !sameOffer(pin.offer, entry.offer) || !definite())
          return false;
        await execute(options.pins.retire(accountId, entry.offer));
      } catch {
        return false;
      }
      void retire(entry).catch(() => {});
      return true;
    };
    const project = async (entry: RecordEntry, accountId: string, error: unknown) => {
      const loss = failureLoss(error);
      if (loss && (await lose(entry, accountId))) throw new Error(loss);
      throw error;
    };
    const get = async (
      workspaceId: string,
      source?: PersonalPairingOffer | ((accountId: string) => PersonalPairingOffer),
      live: () => boolean = () => true,
      kind?: 'member'
    ) => {
      if (closed) throw fail('closed');
      if (source && typeof source !== 'function' && Result.isFailure(verifyPersonalOffer(source)))
        throw fail('invalid-input');
      observe();
      const accountId = await execute(resolveAccount(live));
      if (!live()) throw fail('closed');
      if (!accountId) throw fail('scope-mismatch');
      // An offer derived from the account is derived from this resolved one, never from an
      // earlier synchronous read that an account switch may have overtaken.
      const supplied = typeof source === 'function' ? source(accountId) : source;
      if (supplied && Result.isFailure(verifyPersonalOffer(supplied))) throw fail('invalid-input');
      const saved = await execute(options.pins.read(accountId, workspaceId));
      check(accountId);
      if (supplied) assertPersonalEntryOffer(saved, supplied);
      const offer = supplied ?? saved?.offer;
      if (!offer) throw fail('approval-required');
      const id = key(accountId, workspaceId);
      let previous = records.get(id);
      if (previous && (previous.retired || !sameOffer(previous.offer, offer))) {
        await retire(previous);
        check(accountId);
        previous = undefined;
      }
      if (supplied) {
        await execute(options.pins.prepare(accountId, supplied, kind));
        check(accountId);
      }
      let entry = records.get(id);
      if (!entry) {
        const scope = Scope.makeUnsafe();
        const record: RecordEntry = {
          accountId,
          workspaceId,
          offer: { ...offer },
          scope,
          retired: false,
          readers: new Set(),
          ready: undefined!,
        };
        const drainOld = (binding: ClientCustodyBinding) =>
          Effect.tryPromise({
            try: async () => {
              const matches = [...all].filter(
                (other) =>
                  other !== record &&
                  other.accountId === binding.accountId &&
                  other.workspaceId === binding.workspaceId &&
                  other.offer.genesisHash ===
                    Array.from(binding.genesis.toBytes(), (b) =>
                      b.toString(16).padStart(2, '0')
                    ).join('')
              );
              for (const other of matches) await retire(other);
            },
            catch: (error) => error,
          });
        const run = <A>(program: Effect.Effect<A, unknown>) => execute(program);
        record.ready = executeExit(
          makePersonalWorkspaceRuntime({
            accountId,
            workspaceId,
            genesisHash: offer.genesisHash,
            ports: options.ports({
              accountId,
              offer: { ...offer },
              drainOld,
              currentAccount: () =>
                resolveAccount(() => !record.retired).pipe(
                  Effect.map((observedAccount) => (record.retired ? null : observedAccount))
                ),
              mode: saved?.phase === 'ready' ? 'open-existing' : 'create-or-open',
            }),
            retainedOffer: () =>
              options.pins
                .read(accountId, workspaceId)
                .pipe(Effect.map((pin) => pin?.offer ?? null)),
            account: () =>
              resolveAccount(() => !record.retired).pipe(
                Effect.map((observedAccount) =>
                  !record.retired && observedAccount === accountId
                    ? {
                        userId: accountId,
                        source:
                          session.get().status === 'authenticated'
                            ? ('network' as const)
                            : ('offline' as const),
                      }
                    : null
                )
              ),
            ledgerRecords: options.ledgerRecords(accountId, offer),
            run,
          }).pipe(Scope.provide(scope))
        ).then(unwrap);
        records.set(id, record);
        all.add(record);
        entry = record;
        void record.ready.catch(() => {
          void retire(record).catch(() => {});
        });
      }
      const runtime = await entry.ready;
      check(accountId);
      if (entry.retired) throw fail('closed');
      return { entry, runtime, accountId };
    };
    const invoke = async <A>(
      workspaceId: string,
      work: (runtime: E2eeWorkspaceRuntime) => Promise<A>,
      inspect?: (value: unknown) => AccessLoss | null
    ) => {
      const { entry, runtime, accountId } = await get(workspaceId);
      const value = await work(runtime).catch((error: unknown) => project(entry, accountId, error));
      const loss = inspect?.(value) ?? null;
      if (loss && (await lose(entry, accountId))) throw new Error(loss);
      try {
        check(accountId);
        if (entry.retired) throw fail('closed');
      } catch (error) {
        if (value instanceof Uint8Array) value.fill(0);
        throw error;
      }
      return value;
    };
    const call = async <K extends keyof E2eeWorkspaceRuntime>(
      workspaceId: string,
      method: K,
      args: Parameters<Extract<E2eeWorkspaceRuntime[K], (...args: never[]) => unknown>>,
      inspect?: (value: unknown) => AccessLoss | null
    ): Promise<
      Awaited<ReturnType<Extract<E2eeWorkspaceRuntime[K], (...args: never[]) => unknown>>>
    > =>
      invoke(
        workspaceId,
        async (runtime) => {
          const methodValue = runtime[method];
          if (typeof methodValue !== 'function') throw fail('unsupported');
          return Reflect.apply(methodValue, runtime, args);
        },
        inspect
      );
    /**
     * A new invitation for a workspace whose earlier join is still pinned as pending: ask
     * that join once and stop routing to it if it ended (rejected, cancelled, or its
     * invitation expired). The pin grants nothing; the host still retires the old request
     * through the relay before a new identity, and an admitted join claims as committed.
     */
    const settleEndedMemberJoin = async (invitation: import('@lody/cloud-api').E2eeMemberOffer) => {
      observe();
      const accountId = await execute(resolveAccount());
      if (!accountId) return;
      const pin = await execute(options.pins.read(accountId, invitation.workspaceId));
      check(accountId);
      if (!pin || pin.kind !== 'member' || pin.phase !== 'pending') return;
      if (sameOffer(pin.offer, memberPairingOffer(accountId, invitation))) return;
      const { runtime, entry } = await get(invitation.workspaceId);
      const pending = await runtime.pendingMemberJoin!(invitation.workspaceId);
      check(accountId);
      if (!pending?.requestId) return;
      const { state } = await runtime.claimMemberJoin!(invitation.workspaceId, pending.requestId);
      check(accountId);
      const ended =
        state === 'rejected' ||
        state === 'cancelled' ||
        (state === 'pending' && pending.offer.expiresAt <= Date.now());
      if (ended) await execute(options.pins.finish(accountId, entry.offer, 'cancelled'));
      check(accountId);
    };
    /**
     * The single way to an approval session. Acquiring it opens the workspace, and every
     * operation on it may reach a credential-bound endpoint or the verified ledger, so each
     * failure passes the same access-loss boundary as content calls: an exact loss retires
     * this workspace's pin, anything else keeps its original failure.
     */
    const approvalSession = async (workspaceId: string) => {
      const { entry, runtime, accountId } = await get(workspaceId);
      if (!runtime.accountApproval) throw fail('unsupported');
      const guarded = <A>(work: () => Promise<A>) =>
        work().catch((error: unknown) => project(entry, accountId, error));
      /** The verified ledger read by the open or a refresh may no longer hold this device
       * or its membership: the same status rule as the facade's `status`/`refresh`. The
       * public runtime refuses `status` with the exact loss once its verified ledger shows
       * it; only that typed result counts, and any other status failure proves nothing. */
      const verifiedAccess = async () => {
        const loss = await runtime.status(workspaceId).then(statusLoss, failureLoss);
        if (loss && (await lose(entry, accountId))) throw new Error(loss);
      };
      type ModeApprovalSession = Omit<E2eeAccountApprovalSession, 'keyRound'> & {
        keyRound(mode?: 'full' | 'distribute'): Promise<void>;
      };
      const approval = (await guarded(() => runtime.accountApproval!())) as ModeApprovalSession;
      try {
        await verifiedAccess();
      } catch (error) {
        await approval.release().catch(() => {});
        throw error;
      }
      const session: ModeApprovalSession = {
        device: approval.device,
        sign: (row) => guarded(() => approval.sign(row)),
        settle: (record, refresh) => guarded(() => approval.settle(record, refresh)),
        ...(approval.checkpoint ? { checkpoint: () => guarded(() => approval.checkpoint!()) } : {}),
        ...(approval.ingest
          ? {
              ingest: (page: E2eeWorkspaceHistoryPage) =>
                guarded(async () => {
                  await approval.ingest!(page);
                  await verifiedAccess();
                }),
            }
          : {}),
        ...(approval.prepareDelivery
          ? {
              prepareDelivery: (recipient: string) =>
                guarded(() => approval.prepareDelivery!(recipient)),
            }
          : {}),
        invitation: (record) => guarded(() => approval.invitation(record)),
        access: () => guarded(() => approval.access()),
        refresh: () =>
          guarded(async () => {
            await approval.refresh();
            await verifiedAccess();
          }),
        keyRound: (mode) => guarded(() => (mode ? approval.keyRound(mode) : approval.keyRound())),
        keyDeliveryEvidence: (device) => guarded(() => approval.keyDeliveryEvidence(device)),
        // Ending this holder's use proves nothing about access.
        release: () => approval.release(),
      };
      return { entry, accountId, approval: session };
    };
    const facade: E2eeWorkspaceRuntime = {
      readerLeases: 'preallocated-v1',
      account,
      accountApproval: async (workspaceId) => {
        if (!workspaceId) throw fail('invalid-input');
        return (await approvalSession(workspaceId)).approval;
      },
      recordCreated: async (input) => {
        if (!options.recordCreated) throw fail('unsupported');
        const accountId = identity();
        if (!accountId) throw fail('scope-mismatch');
        await options.recordCreated({ ...input, accountId });
        check(accountId);
      },
      open: async (id, observed, expected, owner) => {
        const reader = owner ?? crypto.randomUUID(),
          label = key(id, reader);
        const state: {
          cancelled: boolean;
          accountId: string | null;
          started: boolean;
          entry?: RecordEntry;
        } = { cancelled: false, accountId: expected ?? identity(), started: false };
        if (pending.has(label)) throw fail('conflict');
        pending.set(label, state);
        try {
          for (let attempt = 0; attempt < 2; attempt++) {
            const { entry, runtime, accountId } = await get(id, undefined, () => !state.cancelled);
            state.accountId = accountId;
            if (expected && expected !== accountId) throw fail('scope-mismatch');
            if (state.cancelled) throw fail('closed');
            state.entry = entry;
            state.started = true;
            if (!entry.readers.size && !entry.openingOwner) entry.openingOwner = reader;
            try {
              const value = await runtime
                .open(id, observed, expected, reader)
                .catch((error: unknown) => project(entry, accountId, error));
              // The opened ledger already proves this device is gone: retire, never publish.
              // Decided before the fence below, so its await cannot outlive a close.
              const loss = statusLoss(value);
              if (loss && (await lose(entry, accountId))) throw new Error(loss);
              if (state.cancelled || entry.retired || identity() !== accountId) {
                await runtime.close(id, accountId, reader);
                throw fail('closed');
              }
              entry.readers.add(reader);
              return value;
            } catch (error) {
              // Only retry a failed reader acquisition, after complete Scope drain.
              // Content, signing and RPC operations are never repeated here.
              if (
                attempt === 0 &&
                !state.cancelled &&
                !entry.readers.size &&
                error instanceof PersonalHostError &&
                error.code === 'closed'
              ) {
                await retire(entry);
                continue;
              }
              throw error;
            } finally {
              if (entry.openingOwner === reader) entry.openingOwner = undefined;
            }
          }
          throw fail('closed');
        } finally {
          pending.delete(label);
        }
      },
      close: async (id, expected, owner) => {
        const accountId = expected ?? identity();
        const matching = [...pending.entries()].filter(
          ([label, state]) =>
            JSON.parse(label)[0] === id &&
            (state.accountId === null || state.accountId === accountId) &&
            (!owner || JSON.parse(label)[1] === owner)
        );
        for (const [, state] of matching) state.cancelled = true;
        for (const publish of accountWaiters) publish();
        if (!accountId) return;
        const entry = records.get(key(accountId, id));
        if (!entry) return;
        const pendingRoot =
          !entry.readers.size &&
          matching.some(
            ([label, state]) =>
              state.started && state.entry === entry && entry.openingOwner === JSON.parse(label)[1]
          );
        if (pendingRoot) entry.retired = true;
        // Public close fences these readers before waiting for native drain.
        // A timeout retains resources, never an active reader label.
        if (owner) entry.readers.delete(owner);
        else entry.readers.clear();
        const runtime = await entry.ready;
        try {
          await runtime.close(id, accountId, owner);
        } catch (error) {
          if (pendingRoot) void retire(entry).catch(() => {});
          throw error;
        }
        // The public host retires an assembly whose first native open was closed.
        // Reacquire only after that complete Scope has confirmed retirement.
        if (pendingRoot) await retire(entry);
      },
      status: (id) => call(id, 'status', [id], statusLoss),
      refresh: (id, input) => call(id, 'refresh', [id, input], statusLoss),
      readIdentity: (input) => call(input.workspaceId, 'readIdentity', [input]),
      contentStreamsToken: (id, ...args) => call(id, 'contentStreamsToken', [id, ...args]),
      seal: async (id, input) => {
        // Snapshot before lazy account/pin lookup. Copy plaintext last, then
        // synchronously establish cleanup even if no lower runtime starts.
        const captured = {
          ...input,
          room: { ...input.room },
          context: { ...input.context },
          additionalData: new Uint8Array(input.additionalData),
          plaintext: new Uint8Array(input.plaintext),
        };
        try {
          return await invoke(id, (runtime) => runtime.seal(id, captured));
        } finally {
          // The public runtime owns its separate native-call copy.
          captured.plaintext.fill(0);
          captured.additionalData.fill(0);
        }
      },
      openContent: async (id, input) => {
        const captured = {
          ...input,
          room: { ...input.room },
          context: { ...input.context },
          header: new Uint8Array(input.header),
          additionalData: new Uint8Array(input.additionalData),
          sealed: new Uint8Array(input.sealed),
        };
        try {
          return await invoke(id, (runtime) => runtime.openContent(id, captured));
        } finally {
          captured.header.fill(0);
          captured.additionalData.fill(0);
          captured.sealed.fill(0);
        }
      },
      ingestLedgerRecords: (id, page) => call(id, 'ingestLedgerRecords', [id, page]),
      ledgerView: (id) => call(id, 'ledgerView', [id]),
      prepareDispatch: (id, ...args) => call(id, 'prepareDispatch', [id, ...args]),
      // Encrypted schedules saved from this host carry its own signed declaration.
      signScheduleDeclaration: (id, ...args) => call(id, 'signScheduleDeclaration', [id, ...args]),
      acceptDispatchResponse: (id, ...args) => call(id, 'acceptDispatchResponse', [id, ...args]),
      prepareFeatureRpc: (id, ...args) => call(id, 'prepareFeatureRpc', [id, ...args]),
      // Machine sharing is the shared host every Web/mobile runtime carries; the facade
      // forwards it unchanged, so the page reads and writes through the same reader.
      readMachineSharing: (id, ...args) => call(id, 'readMachineSharing', [id, ...args]),
      updateMachineSharing: (id, ...args) => call(id, 'updateMachineSharing', [id, ...args]),
      acceptFeatureRpcResponse: (id, ...args) =>
        call(id, 'acceptFeatureRpcResponse', [id, ...args]),
      managementState: (id) => call(id, 'managementState', [id]),
      updateKeys: (id) => call(id, 'updateKeys', [id]),
      revokeDevice: (id, device) => call(id, 'revokeDevice', [id, device]),
      removeMember: (id, member) => call(id, 'removeMember', [id, member]),
      setMemberRole: (id, member, role) => call(id, 'setMemberRole', [id, member, role]),
      // Team management on the portable runtime (admin side). The member relay port is
      // always composed here, so the session-level capability gate admits these.
      transferOwnership: (id, member) => call(id, 'transferOwnership', [id, member]),
      createMemberInvitation: (input) =>
        call(input.workspaceId, 'createMemberInvitation', [{ ...input }]),
      memberJoinRequests: (id) => call(id, 'memberJoinRequests', [id]),
      approveMemberJoin: (id, requestId, mode) =>
        call(id, 'approveMemberJoin', [id, requestId, mode]),
      memberKeyDeliveries: (id) => call(id, 'memberKeyDeliveries', [id]),
      retryMemberKeyDelivery: (id, requestId) =>
        call(id, 'retryMemberKeyDelivery', [id, requestId]),
      rejectMemberJoin: (id, requestId) => call(id, 'rejectMemberJoin', [id, requestId]),
      revokeMemberInvitation: (id, token) => call(id, 'revokeMemberInvitation', [id, token]),
      preparePersonalJoin: async (offer) => {
        const { runtime, accountId, entry } = await get(offer.workspaceId, { ...offer });
        const value = await runtime.preparePersonalJoin!(offer);
        check(accountId);
        if (entry.retired) throw fail('closed');
        return value;
      },
      pendingPersonalJoin: async (id) => {
        // A pairing page opened cold asks while the login is still loading; wait for the
        // account, as for a team join, so a saved request is not reported missing.
        observe();
        const accountId = await execute(resolveAccount());
        if (!accountId) return null;
        const pin = await execute(options.pins.read(accountId, id));
        check(accountId);
        if (!pin || pin.phase !== 'pending' || pin.kind === 'member') return null;
        return { pairingSessionId: pin.offer.pairingSessionId, offer: pin.offer };
      },
      claimPersonalJoin: async (id, pairingId) => {
        const { runtime, accountId, entry } = await get(id);
        const value = await runtime.claimPersonalJoin!(id, pairingId);
        check(accountId);
        if (entry.retired) throw fail('closed');
        if (value.ready) await execute(options.pins.finish(accountId, entry.offer, 'ready'));
        check(accountId);
        return value;
      },
      // Joining a team: the identity offer derives from the invitation and is pinned as a
      // member join, so personal pairing never shows it; the portable host verifies admission.
      prepareMemberJoin: async (invitation) => {
        await settleEndedMemberJoin(invitation);
        const { runtime, accountId, entry } = await get(
          invitation.workspaceId,
          (account) => memberPairingOffer(account, invitation),
          undefined,
          'member'
        );
        const value = await runtime.prepareMemberJoin!(invitation);
        check(accountId);
        if (entry.retired) throw fail('closed');
        return value;
      },
      pendingMemberJoin: async (id) => {
        // A join link opened cold reaches here while the login is still loading. Wait for
        // the account like every other entry call: an early null reads as "no saved
        // request", and the page never asks again.
        observe();
        const accountId = await execute(resolveAccount());
        if (!accountId) return null;
        const pin = await execute(options.pins.read(accountId, id));
        check(accountId);
        // A completed join stays resumable: after a reload the page claims it again and,
        // with the admission and current key held, shows it as joined instead of asking for
        // a new request. Only verified committed admission makes a member pin ready, so a
        // rejected or ended join is never offered here and a new invitation still applies.
        if (!pin || pin.phase === 'cancelled' || pin.kind !== 'member') return null;
        const { runtime, entry } = await get(id);
        const value = await runtime.pendingMemberJoin!(id);
        check(accountId);
        if (entry.retired) throw fail('closed');
        return value;
      },
      claimMemberJoin: async (id, requestId) => {
        const { runtime, accountId, entry } = await get(id);
        const value = await runtime.claimMemberJoin!(id, requestId);
        check(accountId);
        if (entry.retired) throw fail('closed');
        if (value.state === 'rejected' || value.state === 'cancelled') {
          // The join ended: its pin stops routing, so a new invitation can retire it.
          await execute(options.pins.finish(accountId, entry.offer, 'cancelled'));
          check(accountId);
        }
        if (value.state !== 'committed') return { ready: false, state: value.state };
        // Verified admission: this identity opens from now on.
        await execute(options.pins.finish(accountId, entry.offer, 'ready'));
        check(accountId);
        // Ready means this device installed the current epoch key, as on desktop. Key
        // delivery follows admission, so until it arrives the join page keeps claiming and
        // each claim tries to receive it again; the admission itself is never undone.
        const reader = crypto.randomUUID();
        let opened = false,
          ready = false;
        try {
          const status = await runtime.open(id, undefined, accountId, reader);
          opened = true;
          check(accountId);
          // A device that already installed the current key is joined as it reopens,
          // without waiting on another key round.
          ready =
            status.hasCurrentKey ||
            (await runtime.refresh(id, { keyMode: 'receive' })).hasCurrentKey;
        } catch {
          ready = false;
        } finally {
          if (opened) await runtime.close(id, accountId, reader);
        }
        check(accountId);
        if (entry.retired) throw fail('closed');
        return { ready, state: 'committed' };
      },
      cancelPersonalJoin: async (id, pairingId) => {
        const { runtime, accountId, entry } = await get(id);
        const value = await runtime.cancelPersonalJoin!(id, pairingId);
        check(accountId);
        if (entry.retired) throw fail('closed');
        await execute(options.pins.finish(accountId, entry.offer, 'cancelled'));
        check(accountId);
        return value;
      },
    };
    if (options.accountPairing) {
      let pairing: E2eeAccountPairingRuntime | undefined;
      let pairingAccount: string | undefined;
      const accountPairing = (): E2eeAccountPairingRuntime => {
        const owner = identity();
        if (!owner) throw fail('scope-mismatch');
        if (pairing && pairingAccount === owner) return pairing;
        pairingAccount = owner;
        const configured = options.accountPairing!;
        /**
         * Every cloud port the pairing workflow awaits, bounded on the Effect clock. The
         * workflow runs one operation at a time, so one unanswered socket would otherwise
         * hold every later request, poll, approval and cancel of this session. A timeout is
         * a retryable failure, never access loss; a retried append is settled from the
         * ledger, never signed again.
         */
        const bounded = <A>(work: () => Promise<A>) =>
          Effect.tryPromise({ try: work, catch: (error) => error }).pipe(
            Effect.timeoutOrElse({
              duration: configured.requestTimeoutMs ?? 30_000,
              orElse: () => Effect.fail(new Error('e2ee_pairing_relay_failed')),
            })
          );
        /** This pass's ready workspaces; the shared approver reads them synchronously. */
        let approverHints: AccountPairingWorkspaceHint[] = [];
        /** Current requester pass's workspace hints; shared by the single portable requester
         * instance so verified ledger prefixes persist across identity() and accept(). */
        let requesterHints: readonly AccountPairingWorkspaceHint[] = [];
        let cachingRequesterHints = false;
        let activeRequesterHints: readonly AccountPairingWorkspaceHint[] | undefined;
        const requesterHintsLock = Semaphore.makeUnsafe(1);
        const withRequesterHintsScope = <A, E>(work: Effect.Effect<A, E>) =>
          requesterHintsLock.withPermits(1)(
            Effect.acquireUseRelease(
              Effect.sync(() => {
                cachingRequesterHints = true;
                activeRequesterHints = undefined;
              }),
              () => work,
              () =>
                Effect.sync(() => {
                  cachingRequesterHints = false;
                  activeRequesterHints = undefined;
                })
            )
          );
        const readRequesterHints = Effect.fnUntraced(function* () {
          if (!configured.requester) return [] as readonly AccountPairingWorkspaceHint[];
          if (cachingRequesterHints && activeRequesterHints !== undefined) {
            check(owner);
            return activeRequesterHints;
          }
          const hints = yield* bounded(configured.requester.workspaces);
          check(owner);
          if (cachingRequesterHints) activeRequesterHints = hints;
          return hints;
        });
        /** Display names from the account's workspace list. Best effort and bounded: a
         * name never decides which workspaces are offered. */
        const listedNames = () =>
          configured.requester
            ? bounded(configured.requester.workspaces).pipe(
                Effect.map((hints) => new Map(hints.map((hint) => [hint.workspaceId, hint.name]))),
                Effect.timeoutOrElse({
                  duration: 5_000,
                  orElse: () => Effect.succeed(new Map<string, string>()),
                }),
                Effect.orElseSucceed(() => new Map<string, string>())
              )
            : Effect.succeed(new Map<string, string>());
        // The shared portable approver owns signing, append/settle, invitation and the
        // background key delivery to the admitted device; this composition only selects
        // ready workspaces and adapts their purpose-limited approval sessions.
        const approver = makePortableAccountPairingApprover({
          workspaces: () => approverHints,
          session: (workspaceId) =>
            Effect.tryPromise({
              try: async (): Promise<AccountPairingApproverSession | null> => {
                const sessionOwner = identity();
                if (!sessionOwner) return null;
                const pin = await execute(options.pins.read(sessionOwner, workspaceId));
                if (!pin || pin.phase !== 'ready') return null;
                // A ready workspace not yet opened in this process opens on demand, as on
                // the desktop. One that cannot open now is left out, never the whole list;
                // an exact access loss has already retired its pin on the way.
                const opened = await approvalSession(workspaceId).catch(() => null);
                if (!opened || opened.accountId !== sessionOwner) {
                  if (opened) await opened.approval.release().catch(() => {});
                  return null;
                }
                const { entry: record, approval } = opened;
                // The account may have changed while the lookup awaited: never hand out
                // a session for a record whose owner is no longer signed in. The shared
                // approver also ends a delivery whose session device changed.
                if (identity() !== sessionOwner || record.retired) {
                  await approval.release().catch(() => {});
                  return null;
                }
                // Causes keep their codes: the workflow classifies refusals by them.
                const promise = <A>(work: () => Promise<A>) =>
                  Effect.tryPromise({ try: work, catch: (cause) => cause });
                return {
                  binding: { device: { toBytes: () => fromHex(approval.device) } },
                  accountApproval: {
                    sign: (row) => promise(() => approval.sign(row)),
                    settle: (bytes, refresh) => promise(() => approval.settle(bytes, refresh)),
                    ...(approval.checkpoint
                      ? { checkpoint: () => promise(() => approval.checkpoint!()) }
                      : {}),
                    ...(approval.ingest
                      ? {
                          ingest: (page: E2eeWorkspaceHistoryPage) =>
                            promise(() => approval.ingest!(page)),
                        }
                      : {}),
                    ...(approval.prepareDelivery
                      ? {
                          prepareDelivery: (recipient: string) =>
                            promise(() => approval.prepareDelivery!(recipient)),
                        }
                      : {}),
                    invitation: (bytes) => promise(() => approval.invitation(bytes)),
                    access: () => promise(() => approval.access()),
                  },
                  refresh: () => promise(() => approval.refresh()),
                  keyRound: (mode) => promise(() => approval.keyRound(mode)),
                  // Ends this holder's use; the runtime closes a reader it opened.
                  release: () => promise(() => approval.release()),
                  keyDeliveryEvidence: (device) =>
                    promise(() => approval.keyDeliveryEvidence(device)),
                };
              },
              catch: (cause) => cause,
            }),
          appendRecord: (request) => bounded(() => configured.appendRecord(request)),
          ...(configured.historyBatch
            ? {
                historyBatch: (items: E2eeWorkspaceHistoryRequest[]) =>
                  bounded(() => configured.historyBatch!(items)),
              }
            : {}),
          ...(configured.appendRecordsBatch
            ? {
                appendRecordsBatch: (items: E2eeAppendRecordRequest[]) =>
                  bounded(() => configured.appendRecordsBatch!(items)),
              }
            : {}),
          ...(configured.onKeyDelivery ? { onKeyDelivery: configured.onKeyDelivery } : {}),
          ...(configured.keyDeliveryRetry ? { keyDeliveryRetry: configured.keyDeliveryRetry } : {}),
        });
        const portableRequester = configured.requester
          ? makePortableAccountPairingRequester({
              accountId: owner,
              workspaces: () => requesterHints,
              history: (request) => bounded(() => configured.requester!.history(request)),
              ...(configured.requester.historyBatch
                ? {
                    historyBatch: (items: E2eeWorkspaceHistoryRequest[]) =>
                      bounded(() => configured.requester!.historyBatch!(items)),
                  }
                : {}),
              host: (workspaceId, suppliedHint) =>
                Effect.gen(function* () {
                  const hint =
                    requesterHints.find((row) => row.workspaceId === workspaceId) ?? suppliedHint;
                  if (!hint) return null;
                  const previous = yield* options.pins.read(owner, workspaceId);
                  check(owner);
                  if (previous?.phase === 'ready') return null;
                  const target = async (pin?: {
                    genesisRecordHex: string;
                    membershipId: string;
                  }) => {
                    const opened = await get(
                      workspaceId,
                      pin
                        ? accountPairingOffer(
                            {
                              workspaceId,
                              genesis: Result.getOrThrow(
                                Bytes.genesisHash(fromHex(hint.genesisHash))
                              ),
                            },
                            pin
                          )
                        : undefined
                    );
                    const requester = personalRuntimeAccountRequester(opened.runtime);
                    if (!requester) throw fail('unsupported');
                    return { ...opened, requester };
                  };
                  const call = <A>(work: () => Promise<A>) =>
                    Effect.tryPromise({ try: work, catch: (error) => error });
                  const accept = async (
                    input: { genesisRecordHex: string; membershipId: string },
                    action: (host: AccountPairingIdentityHost) => Effect.Effect<void, unknown>
                  ) => {
                    const opened = await target(input);
                    await execute(action(opened.requester));
                    check(owner);
                    await execute(options.pins.finish(owner, opened.entry.offer, 'ready'));
                  };
                  return {
                    workspaceId,
                    genesisHash: hint.genesisHash,
                    pendingPersonalJoin: () => Effect.succeed(null),
                    prepareAccountIdentity: (pin) =>
                      call(async () =>
                        execute((await target(pin)).requester.prepareAccountIdentity(pin))
                      ),
                    acceptAccountHistory: (input) =>
                      call(() => accept(input, (host) => host.acceptAccountHistory!(input))),
                    acceptAccountInvitation: (input) =>
                      call(() => accept(input, (host) => host.acceptAccountInvitation(input))),
                    activate: (preview) =>
                      call(async () => {
                        const opened = await target();
                        const state = await opened.runtime.open(workspaceId, undefined, owner);
                        try {
                          if (opened.runtime.activateAccountPairing)
                            await opened.runtime.activateAccountPairing(workspaceId, preview);
                          else await opened.runtime.refresh(workspaceId, { keyMode: 'receive' });
                        } finally {
                          await opened.runtime.close(workspaceId, owner, state.readerOwner);
                        }
                      }),
                  } satisfies AccountPairingIdentityHost;
                }),
            })
          : undefined;
        const effects = makeAccountPairing({
          store: configured.store(owner),
          account: owner,
          deviceName: configured.deviceName,
          relay: configured.relay,
          // Every workspace this account is ready in on this device, opened or not.
          approverWorkspaces: (filter?: {
            readonly geneses?: ReadonlySet<string>;
            readonly workspaceIds?: ReadonlySet<string>;
          }) =>
            Effect.gen(function* () {
              const allPins = yield* options.pins.listReady(owner);
              const pins = filter
                ? allPins.filter(
                    ({ offer }) =>
                      (!filter.workspaceIds || filter.workspaceIds.has(offer.workspaceId)) &&
                      (!filter.geneses || filter.geneses.has(offer.genesisHash.toLowerCase()))
                  )
                : allPins;
              if (pins.length === 0) {
                check(owner);
                approverHints = [];
                return [];
              }
              const names = yield* listedNames();
              check(owner);
              approverHints = pins.map(({ offer }) => ({
                workspaceId: offer.workspaceId,
                name:
                  names.get(offer.workspaceId) ??
                  configured.workspaceName?.(offer.workspaceId) ??
                  offer.workspaceId,
                genesisHash: offer.genesisHash,
              }));
              return yield* approver(filter);
            }),
          requesterWorkspaces: portableRequester
            ? Effect.fnUntraced(function* (hints, filter) {
                // A retained request already fixes the workspace/genesis set. Its
                // verified identity prefixes belong to this account's live workflow.
                if (!filter?.geneses || requesterHints.length === 0)
                  requesterHints = yield* readRequesterHints();
                return yield* portableRequester(hints, filter);
              })
            : () => Effect.succeed([]),
        });
        const runPairing = <A>(work: Effect.Effect<A, unknown>) =>
          execute(Effect.exit(work)).then(unwrap);
        /** The workflow scopes a request by workspace ID only; a named workspace must be
         * the account's own (same ID and genesis) before anything is journaled or sent. */
        const scopedRequest = Effect.fnUntraced(function* (
          input: Parameters<NonNullable<E2eeAccountPairingRuntime['requestAccountPairing']>>[0]
        ) {
          const { workspace, ...options } = input ?? {};
          if (workspace) {
            const hints = yield* readRequesterHints();
            const hint = hints.find((row) => row.workspaceId === workspace.workspaceId);
            if (!hint) return yield* Effect.fail(pairingFail('invalid-input'));
            if (hint.genesisHash !== workspace.genesisHash)
              return yield* Effect.fail(pairingFail('pairing-tampered'));
          }
          return yield* effects.requestAccountPairing({
            ...options,
            ...(workspace ? { workspaceId: workspace.workspaceId } : {}),
          });
        });
        pairing = {
          requestAccountPairing: (input) =>
            runPairing(withRequesterHintsScope(scopedRequest(input))),
          accountPairingRequest: () =>
            runPairing(withRequesterHintsScope(effects.accountPairingRequest())),
          cancelAccountPairing: (input) => runPairing(effects.cancelAccountPairing(input)),
          accountPairingCode: () => runPairing(effects.accountPairingCode()),
          inspectAccountPairing: (code) => runPairing(effects.inspectAccountPairing(code)),
          approveAccountPairing: (input) => runPairing(effects.approveAccountPairing(input)),
          declineAccountPairing: (input) => runPairing(effects.declineAccountPairing(input)),
        };
        return pairing;
      };
      const currentPairing = () => accountPairing();
      // A host without requester ports cannot request pairing; it shows no such surface.
      if (options.accountPairing.requester) {
        facade.requestAccountPairing = (input) => currentPairing().requestAccountPairing!(input);
        facade.accountPairingRequest = () => currentPairing().accountPairingRequest!();
        facade.cancelAccountPairing = (input) => currentPairing().cancelAccountPairing!(input);
      }
      facade.accountPairingCode = () => currentPairing().accountPairingCode!();
      facade.inspectAccountPairing = (code) => currentPairing().inspectAccountPairing!(code);
      facade.approveAccountPairing = (input) => currentPairing().approveAccountPairing!(input);
      facade.declineAccountPairing = (input) => currentPairing().declineAccountPairing!(input);
    }
    if (options.iroh) {
      // Route selection keys on these methods; a failure means "use Streams RPC".
      facade.irohPath = (id, target) =>
        call(id, 'irohPath', [id, target]).catch(() => 'none' as const);
      facade.irohReady = (id, target) => call(id, 'irohReady', [id, target]).catch(() => false);
      facade.irohCall = (id, target, envelope, timeoutMs) =>
        call(id, 'irohCall', [id, target, envelope, timeoutMs]);
    }
    recoveries.set(facade, {
      restore: async (workspaceId, offer, input) => {
        const opened = await get(workspaceId, offer);
        const commands = personalRuntimeRecovery(opened.runtime);
        if (!commands) throw fail('unsupported');
        const result = await execute(commands.restore(input)).catch((error: unknown) =>
          project(opened.entry, opened.accountId, error)
        );
        check(opened.accountId);
        if (opened.entry.retired) throw fail('closed');
        if (result.outcome === 'Committed' && result.partialEpochKey !== true) {
          await execute(options.pins.finish(opened.accountId, result.offer, 'ready'));
          check(opened.accountId);
          if (opened.entry.retired) throw fail('closed');
        }
        return result;
      },
      setup: async (workspaceId, input) => {
        const opened = await get(workspaceId);
        const commands = personalRuntimeRecovery(opened.runtime);
        if (!commands) throw fail('unsupported');
        const reader = crypto.randomUUID();
        try {
          await opened.runtime.open(workspaceId, undefined, opened.accountId, reader);
          check(opened.accountId);
          if (opened.entry.retired) throw fail('closed');
          const result = await execute(commands.setup(input));
          check(opened.accountId);
          if (opened.entry.retired) throw fail('closed');
          return result;
        } finally {
          await opened.runtime.close(workspaceId, opened.accountId, reader);
        }
      },
    });
    facades.set(session, facade);
    return facade;
  };
  return {
    createRuntime,
    /** Application recovery waits only already-retired roots; a failed drain remains fenced. */
    awaitRetirements: async () => {
      for (const entry of [...all].filter((value) => value.retired)) {
        try {
          await retire(entry);
        } catch (error) {
          if (!entry.recovery) throw error;
          await entry.recovery;
        }
      }
    },
    close: async () => {
      closed = true;
      for (const publish of accountWaiters) publish();
      for (const stop of subscriptions.values()) stop();
      subscriptions.clear();
      await Promise.all([...all].map(retire));
    },
  };
}
