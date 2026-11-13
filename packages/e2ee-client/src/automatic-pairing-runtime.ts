import {
  Clock,
  Effect,
  Result,
  Semaphore,
} from 'effect';
import { toHex } from './bytes';
import {
  derivePairingKeys,
  disposePairingKeys,
  encodePairingSecret,
  formatPairingString,
} from '@lody/e2ee-core/protocol';
import type { E2eeAutomaticPairingCommand, E2eeAutomaticPairingRecord } from '@lody/cloud-api';
import type {
  E2eeAutomaticPairingState,
  E2eeAutomaticPairingReview,
  E2eeWorkspaceRuntime,
} from '@lody/platform';
import {
  AutomaticPairingContextSchema,
  AutomaticPairingCommitmentSchema,
  AutomaticPairingRevealSchema,
  makeAutomaticPairingExchange,
  type AutomaticPairingExchange,
  type AutomaticPairingChannel,
  type AutomaticPairingContext,
} from './automatic-pairing-crypto';

type Hint = { workspaceId: string; name: string; genesisHash: string };
/** The relay transports public originals only. It never receives a pairing secret. */
export interface AutomaticPairingRelay {
  subscribe?(changed: () => void): () => void;
  pending(): Effect.Effect<readonly E2eeAutomaticPairingRecord[], unknown>;
  read(id: string): Effect.Effect<E2eeAutomaticPairingRecord | null, unknown>;
  exchange(
    command: E2eeAutomaticPairingCommand
  ): Effect.Effect<E2eeAutomaticPairingRecord, unknown>;
}

/**
 * Compile-time monotonic phase ordering for automatic pairing state machines.
 * A state slot can only advance to a strictly higher rank or refine within the
 * same rank; backward transitions are rejected by TypeScript's type checker.
 */
type RequesterPhaseRank = {
  readonly Negotiating: 0;
  readonly ChannelReady: 1;
  readonly RequestSubmitted: 2;
  readonly AdmittedSyncing: 3;
  readonly Terminal: 4;
};

type ApproverPhaseRank = {
  readonly Negotiating: 0;
  readonly ChannelDerived: 1;
  readonly WaitingForCode: 2;
  readonly Authorizing: 3;
  readonly Terminal: 4;
};

type AllowedSourceRanksForTarget = {
  readonly 0: 0;
  readonly 1: 0 | 1;
  readonly 2: 0 | 1 | 2;
  readonly 3: 0 | 1 | 2 | 3;
  readonly 4: 0 | 1 | 2 | 3 | 4;
};

type AllowedRequesterNext<From extends RequesterState['_tag']> = Extract<
  RequesterState,
  {
    readonly _tag: {
      [K in RequesterState['_tag']]: [RequesterPhaseRank[From]] extends [
        AllowedSourceRanksForTarget[RequesterPhaseRank[K]],
      ]
        ? K
        : never;
    }[RequesterState['_tag']];
  }
>;

type AllowedApproverNext<From extends ApproverState['_tag']> = Extract<
  ApproverState,
  {
    readonly _tag: {
      [K in ApproverState['_tag']]: [ApproverPhaseRank[From]] extends [
        AllowedSourceRanksForTarget[ApproverPhaseRank[K]],
      ]
        ? K
        : never;
    }[ApproverState['_tag']];
  }
>;

type RequesterState =
  | {
      readonly _tag: 'Negotiating';
      readonly exchange?: AutomaticPairingExchange;
    }
  | {
      readonly _tag: 'ChannelReady';
      readonly exchange: AutomaticPairingExchange;
      readonly channel: AutomaticPairingChannel;
      readonly comparisonCode: string;
      readonly lookupId: string;
      readonly code: string;
      readonly attempted: boolean;
    }
  | {
      readonly _tag: 'RequestSubmitted';
      readonly exchange: AutomaticPairingExchange;
      readonly channel: AutomaticPairingChannel;
      readonly comparisonCode: string;
      readonly lookupId: string;
      readonly code: string;
      readonly phase: 'preparing' | 'waiting';
    }
  | {
      readonly _tag: 'AdmittedSyncing';
      readonly lookupId?: string;
    }
  | {
      readonly _tag: 'Terminal';
      readonly outcome: 'joined' | 'declined' | 'cancelled' | 'expired';
      readonly lookupId?: string;
      readonly attempted: boolean;
    };

type ApproverState =
  | {
      readonly _tag: 'Negotiating';
      readonly exchange?: AutomaticPairingExchange;
    }
  | {
      readonly _tag: 'ChannelDerived';
      readonly exchange: AutomaticPairingExchange;
      readonly channel: AutomaticPairingChannel;
      readonly lookupId: string;
      readonly code: string;
    }
  | {
      readonly _tag: 'WaitingForCode';
      readonly exchange: AutomaticPairingExchange;
      readonly channel: AutomaticPairingChannel;
      readonly lookupId: string;
      readonly code: string;
      readonly nativeRequestId: string;
      readonly deviceName: string;
      readonly codeFailures: number;
    }
  | {
      readonly _tag: 'Authorizing';
      readonly exchange: AutomaticPairingExchange;
      readonly channel: AutomaticPairingChannel;
      readonly lookupId: string;
      readonly code: string;
      readonly nativeRequestId: string;
      readonly deviceName: string;
      readonly phase: 'waiting' | 'syncing';
    }
  | {
      readonly _tag: 'Terminal';
      readonly outcome: 'joined' | 'declined' | 'cancelled' | 'expired';
      readonly declineUndelivered: boolean;
      readonly declineSending: boolean;
    };

type RequesterEntry = {
  readonly context: AutomaticPairingContext;
  readonly gate: Semaphore.Semaphore;
  state: RequesterState;
};

type ApproverEntry = {
  readonly context: AutomaticPairingContext;
  readonly gate: Semaphore.Semaphore;
  state: ApproverState;
};

const advanceRequester = <From extends RequesterState['_tag']>(
  entry: RequesterEntry,
  _from: From,
  next: AllowedRequesterNext<From>
): void => {
  entry.state = next;
};

const advanceApprover = <From extends ApproverState['_tag']>(
  entry: ApproverEntry,
  _from: From,
  next: AllowedApproverNext<From>
): void => {
  entry.state = next;
};

const refuse = (code: string) => Object.assign(new Error(`e2ee_${code}`), { code });
const promise = <A>(work: () => Promise<A>) =>
  Effect.tryPromise({ try: work, catch: (cause) => cause });
const id = (crypto: Crypto) =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');
/** Bound for the native decline at lockout; the hosted client may hold calls while offline. */
const LOCKOUT_DECLINE_TIMEOUT_MS = 5_000;
/** Bound for each relay call: a hosted client queues writes while offline and would
 * otherwise hold a request's gate, and every later read of that request, forever. */
const RELAY_TIMEOUT_MS = 15_000;
/** Bound for the best-effort `cancelled` notice sent after a local cancellation. */
const CANCEL_NOTICE_TIMEOUT_MS = 5_000;
const bounded = <A>(work: Effect.Effect<A, unknown>, ms: number) =>
  work.pipe(Effect.timeoutOrElse({ duration: ms, orElse: () => Effect.fail(refuse('network')) }));
/** Wrong codes an approving device accepts for one request before it ends that request. */
export const AUTOMATIC_PAIRING_CODE_ATTEMPTS = 3;
const sameCode = (entered: string, expected: string) => {
  let difference = entered.length ^ expected.length;
  for (let i = 0; i < expected.length; i++)
    difference |= entered.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
};
const original = (context: AutomaticPairingContext) =>
  JSON.stringify(AutomaticPairingContextSchema.parse(context));

/**
 * Application-owned automatic pairing over the existing retained account pairing
 * workflow. Constructors are pure. Callers supply their executor and close this
 * owner before its session/runtime dependencies retire. One failed candidate does
 * not block another workspace or the application's ordinary content runtime.
 */
export function makeAutomaticPairingRuntime(options: {
  readonly runtime: E2eeWorkspaceRuntime;
  readonly relay: AutomaticPairingRelay;
  readonly account: () => string | null;
  readonly workspaces: () => readonly Hint[];
  readonly deviceName: string;
  readonly canPresent: () => boolean;
  /** Advisory background hint only, after retained local identity verification. */
  readonly notifyPending?: (id: string) => void;
  /** Surfaces `preparing` reviews once this device's local identity is verified, so
   * Instant QR hosts can present their one-time QR immediately while ECDH finishes. */
  readonly includePreparingReviews?: boolean;
  readonly crypto: Crypto;
  readonly now?: () => number;
  readonly run: <A>(work: Effect.Effect<A, unknown>) => Promise<A>;
  /** Overrides the relay call bounds (tests). */
  readonly relayTimeoutMs?: { readonly call: number; readonly cancelNotice: number };
}) {
  const requesting = new Map<string, RequesterEntry>();
  const approving = new Map<string, ApproverEntry>();
  const notified = new Map<string, number>();
  const { runtime } = options;
  const limits = options.relayTimeoutMs ?? {
    call: RELAY_TIMEOUT_MS,
    cancelNotice: CANCEL_NOTICE_TIMEOUT_MS,
  };
  // Every relay call is bounded, so none can hold an entry's gate indefinitely.
  const relay: AutomaticPairingRelay = {
    ...(options.relay.subscribe ? { subscribe: options.relay.subscribe } : {}),
    pending: () => bounded(options.relay.pending(), limits.call),
    read: (id) => bounded(options.relay.read(id), limits.call),
    exchange: (command) => bounded(options.relay.exchange(command), limits.call),
  };
  const setup = Semaphore.makeUnsafe(1);
  let closed = false;
  let account: string | null = null;
  const check = () =>
    Effect.try({
      try: () => {
        const observed = options.account();
        if (!account && observed) account = observed;
        if (closed || !account || observed !== account) throw refuse('account_changed');
      },
      catch: (error) => error,
    });
  const now = options.now ? Effect.sync(options.now) : Clock.currentTimeMillis;
  const workspace = (workspaceId: string) =>
    options.workspaces().find((hint) => hint.workspaceId === workspaceId);

  const requesterEntry = (
    context: AutomaticPairingContext,
    initialState: RequesterState = { _tag: 'Negotiating' }
  ): RequesterEntry => ({
    context: Object.freeze({ ...context }),
    gate: Semaphore.makeUnsafe(1),
    state: initialState,
  });

  const approverEntry = (context: AutomaticPairingContext): ApproverEntry => ({
    context: Object.freeze({ ...context }),
    gate: Semaphore.makeUnsafe(1),
    state: { _tag: 'Negotiating' },
  });

  const disposeRequesterCrypto = (state: RequesterState) => {
    if (
      state._tag === 'Negotiating' ||
      state._tag === 'ChannelReady' ||
      state._tag === 'RequestSubmitted'
    ) {
      if ('channel' in state) state.channel.dispose();
      state.exchange?.dispose();
    }
  };

  const disposeApproverCrypto = (state: ApproverState) => {
    if (
      state._tag === 'Negotiating' ||
      state._tag === 'ChannelDerived' ||
      state._tag === 'WaitingForCode' ||
      state._tag === 'Authorizing'
    ) {
      if ('channel' in state) state.channel.dispose();
      state.exchange?.dispose();
    }
  };

  const requesterPhaseOf = (state: RequesterState): E2eeAutomaticPairingState['phase'] => {
    switch (state._tag) {
      case 'Negotiating':
      case 'ChannelReady':
        return 'preparing';
      case 'RequestSubmitted':
        return state.phase;
      case 'AdmittedSyncing':
        return 'syncing';
      case 'Terminal':
        return state.outcome;
    }
  };

  const requesterComparisonCodeOf = (state: RequesterState): string | null => {
    switch (state._tag) {
      case 'ChannelReady':
      case 'RequestSubmitted':
        return state.comparisonCode;
      case 'Negotiating':
      case 'AdmittedSyncing':
      case 'Terminal':
        return null;
    }
  };

  const isRequesterAdmitted = (state: RequesterState): boolean =>
    state._tag === 'AdmittedSyncing' || (state._tag === 'Terminal' && state.outcome === 'joined');

  const isRequesterAttempted = (state: RequesterState): boolean => {
    switch (state._tag) {
      case 'Negotiating':
        return false;
      case 'ChannelReady':
        return state.attempted;
      case 'RequestSubmitted':
      case 'AdmittedSyncing':
        return true;
      case 'Terminal':
        return state.attempted;
    }
  };

  const requesterLookupIdOf = (state: RequesterState): string | undefined => {
    switch (state._tag) {
      case 'Negotiating':
        return undefined;
      case 'ChannelReady':
      case 'RequestSubmitted':
        return state.lookupId;
      case 'AdmittedSyncing':
      case 'Terminal':
        return state.lookupId;
    }
  };

  const snapshotRequester = (value: RequesterEntry): E2eeAutomaticPairingState => ({
    id: value.context.id,
    workspaceId: value.context.workspaceId,
    workspaceName: workspace(value.context.workspaceId)?.name ?? value.context.workspaceId,
    deviceName: value.context.deviceName,
    expiresAt: value.context.expiresAt,
    comparisonCode: requesterComparisonCodeOf(value.state),
    phase: requesterPhaseOf(value.state),
  });

  const approverPhaseOf = (state: ApproverState): E2eeAutomaticPairingState['phase'] => {
    switch (state._tag) {
      case 'Negotiating':
      case 'ChannelDerived':
        return 'preparing';
      case 'WaitingForCode':
        return 'waiting';
      case 'Authorizing':
        return state.phase;
      case 'Terminal':
        return state.outcome;
    }
  };

  /** The approver never shows its derived code: the person types the new device's code. */
  const reviewApprover = (
    value: ApproverEntry,
    requestId: string,
    deviceName = value.context.deviceName
  ): E2eeAutomaticPairingReview => ({
    id: value.context.id,
    workspaceId: value.context.workspaceId,
    workspaceName: workspace(value.context.workspaceId)?.name ?? value.context.workspaceId,
    deviceName,
    expiresAt: value.context.expiresAt,
    phase: approverPhaseOf(value.state),
    requestId,
  });

  /** Never awaited: a hosted mutation can stay queued while offline. One write at a time;
   * a failure leaves the entry undelivered for the next discovery round. */
  const sendDecline = (id: string, value: ApproverEntry) => {
    const state = value.state;
    if (state._tag !== 'Terminal' || !state.declineUndelivered || state.declineSending) return;
    advanceApprover(value, 'Terminal', {
      ...state,
      declineSending: true,
    });
    void options
      .run(relay.exchange({ id, terminal: 'declined' }))
      .then(
        () => {
          if (value.state._tag === 'Terminal') {
            advanceApprover(value, 'Terminal', {
              ...value.state,
              declineUndelivered: false,
            });
          }
        },
        () => undefined
      )
      .finally(() => {
        if (value.state._tag === 'Terminal') {
          advanceApprover(value, 'Terminal', {
            ...value.state,
            declineSending: false,
          });
        }
      });
  };

  const checked = (context: AutomaticPairingContext, row: E2eeAutomaticPairingRecord) =>
    Effect.try({
      try: () => {
        if (!['pending', 'approved', 'declined', 'cancelled'].includes(row.state))
          throw refuse('pairing-tampered');
        if (original(row.context) !== original(context)) throw refuse('pairing-tampered');
        if (row.commitment) AutomaticPairingCommitmentSchema.parse(row.commitment);
        if (row.reveal) AutomaticPairingRevealSchema.parse(row.reveal);
        if (row.requesterKey && !/^04[0-9a-f]{128}$/.test(row.requesterKey))
          throw refuse('pairing-tampered');
        return row;
      },
      catch: () => refuse('pairing-tampered'),
    });

  const deriveChannelCredentials = (result: AutomaticPairingChannel) => {
    const keys = Result.getOrThrow(derivePairingKeys(result.secret));
    let lookupId: string;
    try {
      lookupId = toHex(keys.lookupId);
    } finally {
      disposePairingKeys(keys);
    }
    const code = formatPairingString(Result.getOrThrow(encodePairingSecret(result.secret)));
    return {
      channel: result,
      comparisonCode: result.comparisonCode,
      lookupId,
      code,
    };
  };

  const settleRequesterTerminal = (
    value: RequesterEntry,
    outcome: 'joined' | 'declined' | 'cancelled' | 'expired'
  ) => {
    const prev = value.state;
    const lookupId = requesterLookupIdOf(prev);
    const attempted = isRequesterAttempted(prev);
    disposeRequesterCrypto(prev);
    advanceRequester(value, prev._tag, {
      _tag: 'Terminal',
      outcome,
      ...(lookupId ? { lookupId } : {}),
      attempted,
    });
  };

  const settleApproverTerminal = (
    value: ApproverEntry,
    outcome: 'joined' | 'declined' | 'cancelled' | 'expired',
    declineUndelivered = false
  ) => {
    const prev = value.state;
    disposeApproverCrypto(prev);
    advanceApprover(value, prev._tag, {
      _tag: 'Terminal',
      outcome,
      declineUndelivered,
      declineSending: false,
    });
  };

  const expiresRequester = Effect.fnUntraced(function* (value: RequesterEntry) {
    yield* check();
    if (!isRequesterAdmitted(value.state) && (yield* now) >= value.context.expiresAt) {
      settleRequesterTerminal(value, 'expired');
      return true;
    }
    return value.state._tag === 'Terminal';
  });

  const expiresApprover = Effect.fnUntraced(function* (value: ApproverEntry) {
    yield* check();
    if (
      !(value.state._tag === 'Terminal' && value.state.outcome === 'joined') &&
      (yield* now) >= value.context.expiresAt
    ) {
      settleApproverTerminal(value, 'expired');
      return true;
    }
    return value.state._tag === 'Terminal';
  });

  const updateKeys = Effect.fnUntraced(function* (value: RequesterEntry) {
    const inspected = yield* Effect.result(
      promise(() => runtime.status(value.context.workspaceId))
    );
    yield* check();
    let status = Result.isSuccess(inspected) ? inspected.success : null;
    if (status?.deviceKind === 'personal' && status.hasDeviceCredential && !status.hasCurrentKey) {
      const received = yield* Effect.result(
        promise(() => runtime.refresh(value.context.workspaceId, { installKeys: true }))
      );
      yield* check();
      if (Result.isSuccess(received)) status = received.success;
    }
    if (status?.deviceKind === 'personal' && status.hasDeviceCredential && status.hasCurrentKey) {
      settleRequesterTerminal(value, 'joined');
    } else if (value.state._tag !== 'AdmittedSyncing') {
      const prev = value.state;
      const lookupId = requesterLookupIdOf(prev);
      disposeRequesterCrypto(prev);
      if (
        prev._tag === 'Negotiating' ||
        prev._tag === 'ChannelReady' ||
        prev._tag === 'RequestSubmitted'
      ) {
        advanceRequester(value, prev._tag, {
          _tag: 'AdmittedSyncing',
          ...(lookupId ? { lookupId } : {}),
        });
      }
    }
  });

  const ensureRequesterExchange = Effect.fnUntraced(function* (value: RequesterEntry) {
    yield* check();
    if (
      value.state._tag === 'Negotiating' ||
      value.state._tag === 'ChannelReady' ||
      value.state._tag === 'RequestSubmitted'
    ) {
      if (value.state.exchange) return value.state.exchange;
    }
    const created = yield* makeAutomaticPairingExchange({
      context: value.context,
      role: 'requester',
      crypto: options.crypto,
    });
    if (closed || options.account() !== account) {
      created.dispose();
      return yield* Effect.fail(refuse('account_changed'));
    }
    if (value.state._tag === 'Negotiating') {
      advanceRequester(value, 'Negotiating', {
        _tag: 'Negotiating',
        exchange: created,
      });
    }
    return created;
  });

  const ensureApproverExchange = Effect.fnUntraced(function* (value: ApproverEntry) {
    yield* check();
    if (
      value.state._tag === 'Negotiating' ||
      value.state._tag === 'ChannelDerived' ||
      value.state._tag === 'WaitingForCode' ||
      value.state._tag === 'Authorizing'
    ) {
      if (value.state.exchange) return value.state.exchange;
    }
    const created = yield* makeAutomaticPairingExchange({
      context: value.context,
      role: 'approver',
      crypto: options.crypto,
    });
    if (closed || options.account() !== account) {
      created.dispose();
      return yield* Effect.fail(refuse('account_changed'));
    }
    if (value.state._tag === 'Negotiating') {
      advanceApprover(value, 'Negotiating', {
        _tag: 'Negotiating',
        exchange: created,
      });
    }
    return created;
  });

  const requesterTick = Effect.fnUntraced(function* (value: RequesterEntry) {
    if (yield* expiresRequester(value)) return snapshotRequester(value);
    if (value.state._tag === 'AdmittedSyncing') {
      yield* updateKeys(value);
      return snapshotRequester(value);
    }
    if (value.state._tag === 'Terminal') {
      return snapshotRequester(value);
    }
    const exchange = yield* ensureRequesterExchange(value);
    let row = yield* relay.exchange({ id: value.context.id, context: value.context });
    row = yield* checked(value.context, row);
    yield* check();
    if (row.state === 'declined' || row.state === 'cancelled') {
      settleRequesterTerminal(value, row.state);
      return snapshotRequester(value);
    }
    if (!row.commitment) return snapshotRequester(value);
    const requesterKey = yield* exchange.requestKey(row.commitment);
    if (row.requesterKey && row.requesterKey !== requesterKey)
      return yield* Effect.fail(refuse('pairing-tampered'));
    if (!row.requesterKey)
      row = yield* checked(
        value.context,
        yield* relay.exchange({ id: value.context.id, requesterKey })
      );
    if (!row.reveal) return snapshotRequester(value);
    if (value.state._tag === 'Negotiating') {
      const derived = deriveChannelCredentials(yield* exchange.finish(row.reveal));
      advanceRequester(value, 'Negotiating', {
        _tag: 'ChannelReady',
        exchange,
        channel: derived.channel,
        comparisonCode: derived.comparisonCode,
        lookupId: derived.lookupId,
        code: derived.code,
        attempted: false,
      });
    }
    yield* check();
    if (value.state._tag === 'ChannelReady' && !value.state.attempted) {
      const retained = yield* promise(
        () => runtime.accountPairingRequest?.() ?? Promise.resolve(null)
      );
      if (retained?.status === 'waiting') return yield* Effect.fail(refuse('pairing-elsewhere'));
    }
    const hint = workspace(value.context.workspaceId);
    if (!hint || hint.genesisHash !== value.context.genesisHash || !runtime.requestAccountPairing)
      return yield* Effect.fail(refuse('pairing-unavailable'));
    // The host journals its original before submit. A lost response retries this
    // same code/identity; makeAccountPairing treats that as the same request.
    if (value.state._tag === 'ChannelReady') {
      const readyState = value.state;
      advanceRequester(value, 'ChannelReady', {
        ...readyState,
        attempted: true,
      });
      const submitted = yield* promise(() =>
        runtime.requestAccountPairing!({
          pairingString: readyState.code,
          expiresAt: value.context.expiresAt,
          preserveExisting: true,
          workspace: hint,
        })
      );
      if (submitted.expiresAt !== value.context.expiresAt)
        return yield* Effect.fail(refuse('pairing-update-required'));
      advanceRequester(value, 'ChannelReady', {
        _tag: 'RequestSubmitted',
        exchange: readyState.exchange,
        channel: readyState.channel,
        comparisonCode: readyState.comparisonCode,
        lookupId: readyState.lookupId,
        code: readyState.code,
        phase: 'preparing',
      });
    }
    if (yield* expiresRequester(value)) return snapshotRequester(value);
    const state = yield* promise(() => runtime.accountPairingRequest!());
    yield* check();
    if (state?.status === 'declined' || state?.status === 'expired') {
      settleRequesterTerminal(value, state.status);
      return snapshotRequester(value);
    }
    if (state?.workspaces.some((w) => w.workspaceId === hint.workspaceId && w.state === 'joined')) {
      const prev = value.state;
      const lookupId = requesterLookupIdOf(prev);
      disposeRequesterCrypto(prev);
      if (prev._tag === 'RequestSubmitted' || prev._tag === 'ChannelReady') {
        advanceRequester(value, prev._tag, {
          _tag: 'AdmittedSyncing',
          ...(lookupId ? { lookupId } : {}),
        });
      }
      yield* updateKeys(value);
    } else if (value.state._tag === 'RequestSubmitted' && value.state.phase !== 'waiting') {
      advanceRequester(value, 'RequestSubmitted', {
        ...value.state,
        phase: 'waiting',
      });
    }
    return snapshotRequester(value);
  });

  const approveTick = Effect.fnUntraced(function* (value: ApproverEntry) {
    if (
      value.state._tag !== 'Authorizing' ||
      !runtime.approveAccountPairing ||
      (yield* expiresApprover(value))
    )
      return;
    const authState = value.state;
    const row = yield* relay.read(value.context.id);
    if (!row) return yield* Effect.fail(refuse('pairing-tampered'));
    yield* checked(value.context, row);
    if (row.state === 'declined' || row.state === 'cancelled') {
      settleApproverTerminal(value, row.state);
      return;
    }
    // The stored preview binds this exact request. The native workflow rechecks
    // its MAC and expiry before signing, and returns an exact completion receipt
    // on a retry. Re-inspection would incorrectly reject that completed request.
    const result = yield* promise(() =>
      runtime.approveAccountPairing!({
        pairingString: authState.code,
        requestId: authState.nativeRequestId,
        workspaceIds: [value.context.workspaceId],
      })
    );
    yield* check();
    const outcome = result.workspaces.find(
      (w) => w.workspaceId === value.context.workspaceId
    )?.outcome;
    if (outcome === 'admitted') {
      yield* relay.exchange({ id: value.context.id, terminal: 'approved' });
      settleApproverTerminal(value, 'joined');
    } else if (value.state._tag === 'Authorizing') {
      advanceApprover(value, 'Authorizing', {
        ...value.state,
        phase: 'syncing',
      });
    }
  });

  const approverTick = Effect.fnUntraced(function* (
    value: ApproverEntry,
    source: E2eeAutomaticPairingRecord
  ) {
    if (yield* expiresApprover(value)) return null;
    let row = yield* checked(value.context, source);
    if (value.state._tag === 'Authorizing') {
      const nativeRequestId = value.state.nativeRequestId;
      const deviceName = value.state.deviceName;
      yield* approveTick(value);
      return approverPhaseOf(value.state) === 'joined'
        ? null
        : reviewApprover(value, nativeRequestId, deviceName);
    }
    if (row.state !== 'pending') {
      settleApproverTerminal(value, row.state === 'approved' ? 'joined' : row.state);
      return null;
    }
    const exchange = yield* ensureApproverExchange(value);
    const commitment = exchange.commitment!;
    if (!row.commitment)
      row = yield* checked(
        value.context,
        yield* relay.exchange({ id: value.context.id, commitment })
      );
    if (row.state !== 'pending') {
      settleApproverTerminal(value, row.state === 'approved' ? 'joined' : row.state);
      return null;
    }
    if (
      row.commitment?.peerId !== commitment.peerId ||
      row.commitment.commitment !== commitment.commitment
    )
      return null;
    if (!row.requesterKey)
      return options.includePreparingReviews ? reviewApprover(value, '') : null;
    const reveal = yield* exchange.reveal(row.requesterKey);
    if (!row.reveal)
      row = yield* checked(value.context, yield* relay.exchange({ id: value.context.id, reveal }));
    if (row.state !== 'pending') {
      settleApproverTerminal(value, row.state === 'approved' ? 'joined' : row.state);
      return null;
    }
    if (row.reveal?.publicKey !== reveal.publicKey || row.reveal.nonce !== reveal.nonce)
      return yield* Effect.fail(refuse('pairing-tampered'));
    if (value.state._tag === 'Negotiating') {
      const derived = deriveChannelCredentials(yield* exchange.finish(row.requesterKey!));
      advanceApprover(value, 'Negotiating', {
        _tag: 'ChannelDerived',
        exchange,
        channel: derived.channel,
        lookupId: derived.lookupId,
        code: derived.code,
      });
    }
    const code =
      value.state._tag === 'ChannelDerived' || value.state._tag === 'WaitingForCode'
        ? value.state.code
        : undefined;
    if (!code) return null;
    const preview = yield* promise(() => runtime.inspectAccountPairing!(code));
    yield* check();
    if (!preview) return options.includePreparingReviews ? reviewApprover(value, '') : null;
    if (!preview.workspaces.some((w) => w.workspaceId === value.context.workspaceId)) return null;
    if (preview.expiresAt !== value.context.expiresAt)
      return yield* Effect.fail(refuse('pairing-tampered'));
    if (value.state._tag === 'ChannelDerived') {
      advanceApprover(value, 'ChannelDerived', {
        _tag: 'WaitingForCode',
        exchange: value.state.exchange,
        channel: value.state.channel,
        lookupId: value.state.lookupId,
        code: value.state.code,
        nativeRequestId: preview.requestId,
        deviceName: preview.deviceName,
        codeFailures: 0,
      });
    } else if (value.state._tag === 'WaitingForCode') {
      advanceApprover(value, 'WaitingForCode', {
        ...value.state,
        nativeRequestId: preview.requestId,
        deviceName: preview.deviceName,
      });
    }
    return reviewApprover(value, preview.requestId, preview.deviceName);
  });

  const start = Effect.fnUntraced(function* (workspaceId: string) {
    yield* check();
    const hint = workspace(workspaceId);
    if (!hint) return yield* Effect.fail(refuse('invalid-input'));
    const value = yield* setup.withPermit(
      Effect.gen(function* () {
        for (const other of requesting.values()) {
          if (
            other.context.workspaceId !== workspaceId &&
            !isRequesterAdmitted(other.state) &&
            !(yield* expiresRequester(other))
          )
            return yield* Effect.fail(refuse('pairing-elsewhere'));
        }
        let retained = requesting.get(workspaceId);
        if (
          retained &&
          (yield* expiresRequester(retained)) &&
          isRequesterAttempted(retained.state) &&
          !isRequesterAdmitted(retained.state)
        ) {
          const expectedLookupId = requesterLookupIdOf(retained.state);
          if (expectedLookupId)
            yield* promise(() => runtime.cancelAccountPairing!({ expectedLookupId }));
          if (retained.state._tag === 'Terminal') {
            advanceRequester(retained, 'Terminal', {
              ...retained.state,
              attempted: false,
            });
          }
        }
        if (
          !retained ||
          (retained.state._tag === 'Terminal' &&
            ['expired', 'declined', 'cancelled'].includes(retained.state.outcome))
        ) {
          if (retained) disposeRequesterCrypto(retained.state);
          let initialState: RequesterState = { _tag: 'Negotiating' };
          if (runtime.status) {
            const currentStatus = yield* Effect.result(promise(() => runtime.status(workspaceId)));
            if (
              Result.isSuccess(currentStatus) &&
              currentStatus.success.genesisHash === hint.genesisHash &&
              currentStatus.success.deviceKind === 'personal' &&
              currentStatus.success.hasDeviceCredential
            ) {
              initialState = { _tag: 'AdmittedSyncing' };
            }
          }
          retained = requesterEntry(
            {
              version: 1,
              id: id(options.crypto),
              accountId: account!,
              workspaceId,
              genesisHash: hint.genesisHash,
              deviceName: options.deviceName,
              expiresAt: (yield* now) + 600_000,
            },
            initialState
          );
          requesting.set(workspaceId, retained);
        }
        return retained;
      })
    );
    return yield* value.gate.withPermit(requesterTick(value));
  });

  const pending = Effect.fnUntraced(function* () {
    yield* check();
    if (!runtime.inspectAccountPairing || !runtime.approveAccountPairing) return [];
    const clock = yield* now;
    for (const [id, value] of approving)
      if (value.context.expiresAt <= clock) {
        disposeApproverCrypto(value.state);
        approving.delete(id);
      }
    for (const [id, value] of approving) sendDecline(id, value);
    for (const value of requesting.values()) yield* expiresRequester(value);
    for (const [id, expiry] of notified) if (expiry <= clock) notified.delete(id);
    const rows = (yield* relay.pending()).slice(0, 10);
    const result: E2eeAutomaticPairingReview[] = [];
    for (const source of rows) {
      const parsed = AutomaticPairingContextSchema.safeParse(source.context);
      if (
        !parsed.success ||
        parsed.data.accountId !== account ||
        parsed.data.expiresAt <= (yield* now) ||
        parsed.data.expiresAt > (yield* now) + 600_000
      )
        continue;
      const c = parsed.data;
      if ([...requesting.values()].some((value) => value.context.id === c.id)) continue;
      const hint = workspace(c.workspaceId);
      if (!hint || hint.genesisHash !== c.genesisHash) continue;
      const attempt = yield* Effect.result(
        Effect.gen(function* () {
          let value = approving.get(c.id);
          if (!value) {
            if (!options.canPresent() && notified.has(c.id)) return null;
            // Account catalogs and relay summaries are never proof that this device
            // may approve. Read only its retained, verified local identity first.
            const identity = yield* promise(() =>
              runtime.readIdentity!({ workspaceId: c.workspaceId, accountId: account! })
            );
            if (!identity || identity.genesisHash !== c.genesisHash) return null;
            yield* check();
            if (!options.canPresent()) {
              if (notified.size < 10 && !notified.has(c.id)) {
                notified.set(c.id, c.expiresAt);
                try {
                  options.notifyPending?.(c.id);
                } catch {
                  /* Notifications never gate approval. */
                }
              }
              return null;
            }
            if (approving.size >= 10) {
              for (const [key, previous] of approving)
                if (previous.context.expiresAt <= (yield* now)) {
                  disposeApproverCrypto(previous.state);
                  approving.delete(key);
                }
              if (approving.size >= 10) return null;
            }
            value = approverEntry(c);
            approving.set(c.id, value);
          }
          return yield* value.gate.withPermit(approverTick(value, source));
        })
      );
      // One invalid or temporarily unavailable candidate cannot hide others.
      if (Result.isSuccess(attempt) && attempt.success) result.push(attempt.success);
    }
    return result;
  });

  return {
    ...(relay.subscribe
      ? {
          subscribeAutomaticPairing: (changed: () => void) =>
            relay.subscribe!(() => {
              if (!closed && (!account || options.account() === account)) changed();
            }),
        }
      : {}),
    startAutomaticPairing: (workspaceId: string) => options.run(start(workspaceId)),
    restartAutomaticPairing: (workspaceId: string, input: { expectedLookupId: string }) =>
      options.run(
        Effect.gen(function* () {
          yield* check();
          if (!workspace(workspaceId) || !/^[0-9a-f]{32}$/.test(input.expectedLookupId))
            return yield* Effect.fail(refuse('invalid-input'));
          const admitted = yield* setup.withPermit(
            Effect.suspend(() => {
              const previous = requesting.get(workspaceId);
              const recovery = Effect.gen(function* () {
                const current = yield* promise(() => runtime.accountPairingRequest!());
                yield* check();
                const joined = (state: typeof current) =>
                  state?.workspaces.some(
                    (row) => row.workspaceId === workspaceId && row.state === 'joined'
                  ) === true;
                if (current?.status === 'waiting' && !joined(current)) {
                  if (!current.lookupId || !runtime.cancelAccountPairing)
                    return yield* Effect.fail(refuse('pairing-update-required'));
                  if (current.lookupId !== input.expectedLookupId)
                    return yield* Effect.fail(refuse('pairing-elsewhere'));
                  yield* promise(() =>
                    runtime.cancelAccountPairing!({ expectedLookupId: input.expectedLookupId })
                  );
                  yield* check();
                }
                // Cancellation is compare-and-set: another window may already have
                // replaced the displayed request. Never authorize cancelling that one.
                const after = yield* promise(() => runtime.accountPairingRequest!());
                yield* check();
                const completed = joined(current) || joined(after);
                if (after?.status === 'waiting' && !completed)
                  return yield* Effect.fail(refuse('pairing-elsewhere'));
                if (previous) {
                  settleRequesterTerminal(previous, 'cancelled');
                  if (requesting.get(workspaceId) === previous) requesting.delete(workspaceId);
                }
                // Discovery is advisory. Its old row expires naturally and indexed
                // server cleanup owns erasure; no cleanup write can undo native cancel.
                if (completed) {
                  const hint = workspace(workspaceId)!;
                  const value = requesterEntry(
                    {
                      version: 1,
                      id: id(options.crypto),
                      accountId: account!,
                      workspaceId,
                      genesisHash: hint.genesisHash,
                      deviceName: options.deviceName,
                      expiresAt: (yield* now) + 600_000,
                    },
                    { _tag: 'AdmittedSyncing' }
                  );
                  requesting.set(workspaceId, value);
                  return value;
                }
              });
              return previous ? previous.gate.withPermit(recovery) : recovery;
            })
          );
          if (admitted) {
            yield* admitted.gate.withPermit(updateKeys(admitted));
            return snapshotRequester(admitted);
          }
          return yield* start(workspaceId);
        })
      ),
    automaticPairingState: (workspaceId: string) => {
      const value = requesting.get(workspaceId);
      return value
        ? options.run(
            value.gate.withPermit(
              // A cancellation that held the gate first detached this request.
              Effect.suspend(() =>
                requesting.get(workspaceId) === value ? requesterTick(value) : Effect.succeed(null)
              )
            )
          )
        : Promise.resolve(null);
    },
    cancelAutomaticPairing: (workspaceId: string) =>
      options.run(
        Effect.gen(function* () {
          yield* check();
          const value = requesting.get(workspaceId);
          if (!value) return;
          // Local state settles under the gate; the relay notice goes out after the
          // gate is released, so an unreachable relay never blocks a new request.
          const detached = yield* value.gate.withPermit(
            Effect.gen(function* () {
              if (isRequesterAdmitted(value.state)) return false;
              const lookupId = requesterLookupIdOf(value.state);
              if (isRequesterAttempted(value.state) && lookupId)
                yield* promise(() => runtime.cancelAccountPairing!({ expectedLookupId: lookupId }));
              settleRequesterTerminal(value, 'cancelled');
              // A detached request is never read again: the next start makes a fresh
              // one with its own id and gate, not the dead `cancelled` original.
              if (requesting.get(workspaceId) === value) requesting.delete(workspaceId);
              return true;
            })
          );
          if (!detached) return;
          // Discovery is advisory: an undelivered notice only lets the other device's
          // copy expire on its own.
          yield* Effect.result(
            bounded(
              options.relay.exchange({ id: value.context.id, terminal: 'cancelled' }),
              limits.cancelNotice
            )
          );
        })
      ),
    pendingAutomaticPairing: () => options.run(pending()),
    approveAutomaticPairing: (id: string, enteredCode: string) =>
      options.run(
        Effect.gen(function* () {
          yield* check();
          if (typeof enteredCode !== 'string' || !/^\d{6}$/.test(enteredCode))
            return yield* Effect.fail(refuse('invalid-input'));
          const value = approving.get(id);
          if (
            !value ||
            (value.state._tag !== 'WaitingForCode' &&
              !(value.state._tag === 'Authorizing' && value.state.phase === 'waiting'))
          )
            return yield* Effect.fail(refuse('pairing-tampered'));
          yield* value.gate.withPermit(
            Effect.gen(function* () {
              if (yield* expiresApprover(value)) return yield* Effect.fail(refuse('pairing-expired'));
              // A retry after a lost reply resumes the already-verified approval.
              if (value.state._tag === 'WaitingForCode') {
                const waitingState = value.state;
                if (!sameCode(enteredCode, waitingState.channel.comparisonCode)) {
                  const codeFailures = waitingState.codeFailures + 1;
                  const attemptsLeft = AUTOMATIC_PAIRING_CODE_ATTEMPTS - codeFailures;
                  if (attemptsLeft > 0) {
                    advanceApprover(value, 'WaitingForCode', {
                      ...waitingState,
                      codeFailures,
                    });
                    return yield* Effect.fail(
                      Object.assign(refuse('pairing-code-mismatch'), { attemptsLeft })
                    );
                  }
                  // End the request on this device first, so no later entry can sign it,
                  // then tell the service and the new device; either may be unreachable.
                  const pairingString = waitingState.code;
                  const requestId = waitingState.nativeRequestId;
                  settleApproverTerminal(value, 'declined', true);
                  if (pairingString && requestId && runtime.declineAccountPairing)
                    yield* Effect.result(
                      promise(() =>
                        runtime.declineAccountPairing!({ pairingString, requestId })
                      ).pipe(Effect.timeout(LOCKOUT_DECLINE_TIMEOUT_MS))
                    );
                  // `pending()` resends until delivered or expired; the entry stays declined.
                  sendDecline(id, value);
                  return yield* Effect.fail(refuse('pairing-code-locked'));
                }
                advanceApprover(value, 'WaitingForCode', {
                  _tag: 'Authorizing',
                  exchange: waitingState.exchange,
                  channel: waitingState.channel,
                  lookupId: waitingState.lookupId,
                  code: waitingState.code,
                  nativeRequestId: waitingState.nativeRequestId,
                  deviceName: waitingState.deviceName,
                  phase: 'waiting',
                });
              }
              yield* approveTick(value);
            })
          );
        })
      ),
    declineAutomaticPairing: (id: string) =>
      options.run(
        Effect.gen(function* () {
          yield* check();
          const value = approving.get(id);
          if (!value) return;
          yield* value.gate.withPermit(
            Effect.gen(function* () {
              if (value.state._tag === 'Authorizing')
                return yield* Effect.fail(refuse('pairing-used'));
              if (value.state._tag === 'WaitingForCode') {
                const { code, nativeRequestId } = value.state;
                yield* promise(() =>
                  runtime.declineAccountPairing!({
                    pairingString: code,
                    requestId: nativeRequestId,
                  })
                );
              }
              yield* relay.exchange({ id, terminal: 'declined' });
              settleApproverTerminal(value, 'declined');
            })
          );
        })
      ),
    disposeAutomaticPairing() {
      closed = true;
      for (const value of requesting.values()) disposeRequesterCrypto(value.state);
      for (const value of approving.values()) disposeApproverCrypto(value.state);
      requesting.clear();
      approving.clear();
      notified.clear();
    },
  };
}
