import { Clock, Effect, Semaphore } from 'effect';
import { toHex } from './bytes';
import { Result } from 'effect';
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
type Entry = {
  readonly context: AutomaticPairingContext;
  readonly role: 'requester' | 'approver';
  readonly gate: Semaphore.Semaphore;
  exchange?: AutomaticPairingExchange;
  channel?: AutomaticPairingChannel;
  code?: string;
  lookupId?: string;
  nativeRequestId?: string;
  attempted: boolean;
  admitted: boolean;
  submitted: boolean;
  authorizing: boolean;
  phase: E2eeAutomaticPairingState['phase'];
};
const refuse = (code: string) => Object.assign(new Error(`e2ee_${code}`), { code });
const promise = <A>(work: () => Promise<A>) =>
  Effect.tryPromise({ try: work, catch: (cause) => cause });
const id = (crypto: Crypto) =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');
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
  readonly crypto: Crypto;
  readonly now?: () => number;
  readonly run: <A>(work: Effect.Effect<A, unknown>) => Promise<A>;
}) {
  const requesting = new Map<string, Entry>();
  const approving = new Map<string, Entry>();
  const notified = new Map<string, number>();
  const { runtime, relay } = options;
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
  const entry = (context: AutomaticPairingContext, role: Entry['role']): Entry => ({
    context: Object.freeze({ ...context }),
    role,
    gate: Semaphore.makeUnsafe(1),
    attempted: false,
    admitted: false,
    submitted: false,
    authorizing: false,
    phase: 'preparing',
  });
  const dispose = (value: Entry) => {
    value.channel?.dispose();
    value.exchange?.dispose();
    value.code = undefined;
  };
  const snapshot = (value: Entry): E2eeAutomaticPairingState => ({
    id: value.context.id,
    workspaceId: value.context.workspaceId,
    workspaceName: workspace(value.context.workspaceId)?.name ?? value.context.workspaceId,
    deviceName: value.context.deviceName,
    expiresAt: value.context.expiresAt,
    comparisonCode: value.channel?.comparisonCode ?? null,
    phase: value.phase,
  });
  const checked = (value: Entry, row: E2eeAutomaticPairingRecord) =>
    Effect.try({
      try: () => {
        if (!['pending', 'approved', 'declined', 'cancelled'].includes(row.state))
          throw refuse('pairing-tampered');
        if (original(row.context) !== original(value.context)) throw refuse('pairing-tampered');
        if (row.commitment) AutomaticPairingCommitmentSchema.parse(row.commitment);
        if (row.reveal) AutomaticPairingRevealSchema.parse(row.reveal);
        if (row.requesterKey && !/^04[0-9a-f]{128}$/.test(row.requesterKey))
          throw refuse('pairing-tampered');
        return row;
      },
      catch: () => refuse('pairing-tampered'),
    });
  const channel = (value: Entry, result: AutomaticPairingChannel) => {
    value.channel = result;
    const keys = Result.getOrThrow(derivePairingKeys(result.secret));
    try {
      value.lookupId = toHex(keys.lookupId);
    } finally {
      disposePairingKeys(keys);
    }
    value.code = formatPairingString(Result.getOrThrow(encodePairingSecret(result.secret)));
  };
  const expires = Effect.fnUntraced(function* (value: Entry) {
    yield* check();
    if (!value.admitted && (yield* now) >= value.context.expiresAt) {
      value.phase = 'expired';
      dispose(value);
      return true;
    }
    return ['declined', 'cancelled', 'expired', 'joined'].includes(value.phase);
  });
  const updateKeys = Effect.fnUntraced(function* (value: Entry) {
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
      value.phase = 'joined';
      dispose(value);
    } else value.phase = 'syncing';
  });
  const exchangeFor = Effect.fnUntraced(function* (value: Entry) {
    yield* check();
    if (value.exchange) return value.exchange;
    const created = yield* makeAutomaticPairingExchange({
      context: value.context,
      role: value.role,
      crypto: options.crypto,
    });
    if (closed || options.account() !== account) {
      created.dispose();
      return yield* Effect.fail(refuse('account_changed'));
    }
    value.exchange = created;
    return created;
  });
  const requesterTick = Effect.fnUntraced(function* (value: Entry) {
    if (yield* expires(value)) return snapshot(value);
    if (value.admitted) {
      yield* updateKeys(value);
      return snapshot(value);
    }
    const exchange = yield* exchangeFor(value);
    let row = yield* relay.exchange({ id: value.context.id, context: value.context });
    row = yield* checked(value, row);
    yield* check();
    if (row.state === 'declined' || row.state === 'cancelled') {
      value.phase = row.state;
      dispose(value);
      return snapshot(value);
    }
    if (!row.commitment) return snapshot(value);
    const requesterKey = yield* exchange.requestKey(row.commitment);
    if (row.requesterKey && row.requesterKey !== requesterKey)
      return yield* Effect.fail(refuse('pairing-tampered'));
    if (!row.requesterKey)
      row = yield* checked(value, yield* relay.exchange({ id: value.context.id, requesterKey }));
    if (!row.reveal) return snapshot(value);
    channel(value, yield* exchange.finish(row.reveal));
    yield* check();
    if (!value.attempted) {
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
    if (!value.submitted) {
      value.attempted = true;
      const submitted = yield* promise(() =>
        runtime.requestAccountPairing!({
          pairingString: value.code!,
          expiresAt: value.context.expiresAt,
          preserveExisting: true,
          workspace: hint,
        })
      );
      if (submitted.expiresAt !== value.context.expiresAt)
        return yield* Effect.fail(refuse('pairing-update-required'));
      value.submitted = true;
    }
    if (yield* expires(value)) return snapshot(value);
    const state = yield* promise(() => runtime.accountPairingRequest!());
    yield* check();
    if (state?.status === 'declined' || state?.status === 'expired') {
      value.phase = state.status;
      dispose(value);
      return snapshot(value);
    }
    if (state?.workspaces.some((w) => w.workspaceId === hint.workspaceId && w.state === 'joined')) {
      value.admitted = true;
      value.phase = 'syncing';
      dispose(value);
      yield* updateKeys(value);
    } else value.phase = 'waiting';
    return snapshot(value);
  });
  const approveTick = Effect.fnUntraced(function* (value: Entry) {
    if (
      !value.nativeRequestId ||
      !value.code ||
      !runtime.approveAccountPairing ||
      (yield* expires(value))
    )
      return;
    const row = yield* relay.read(value.context.id);
    if (!row) return yield* Effect.fail(refuse('pairing-tampered'));
    yield* checked(value, row);
    if (row.state === 'declined' || row.state === 'cancelled') {
      value.phase = row.state;
      return;
    }
    // The stored preview binds this exact request. The native workflow rechecks
    // its MAC and expiry before signing, and returns an exact completion receipt
    // on a retry. Re-inspection would incorrectly reject that completed request.
    const result = yield* promise(() =>
      runtime.approveAccountPairing!({
        pairingString: value.code!,
        requestId: value.nativeRequestId!,
        workspaceIds: [value.context.workspaceId],
      })
    );
    yield* check();
    const outcome = result.workspaces.find(
      (w) => w.workspaceId === value.context.workspaceId
    )?.outcome;
    if (outcome === 'admitted') {
      value.phase = 'joined';
      value.admitted = true;
      dispose(value);
      yield* relay.exchange({ id: value.context.id, terminal: 'approved' });
    } else value.phase = 'syncing';
  });
  const approverTick = Effect.fnUntraced(function* (
    value: Entry,
    source: E2eeAutomaticPairingRecord
  ) {
    if (yield* expires(value)) return null;
    let row = yield* checked(value, source);
    if (value.authorizing) {
      yield* approveTick(value);
      return value.phase === 'joined'
        ? null
        : { ...snapshot(value), requestId: value.nativeRequestId ?? '' };
    }
    const exchange = yield* exchangeFor(value);
    const commitment = exchange.commitment!;
    if (!row.commitment)
      row = yield* checked(value, yield* relay.exchange({ id: value.context.id, commitment }));
    if (
      row.commitment?.peerId !== commitment.peerId ||
      row.commitment.commitment !== commitment.commitment
    )
      return null;
    if (!row.requesterKey) return null;
    const reveal = yield* exchange.reveal(row.requesterKey);
    if (!row.reveal)
      row = yield* checked(value, yield* relay.exchange({ id: value.context.id, reveal }));
    if (row.reveal?.publicKey !== reveal.publicKey || row.reveal.nonce !== reveal.nonce)
      return yield* Effect.fail(refuse('pairing-tampered'));
    channel(value, yield* exchange.finish(row.requesterKey!));
    const preview = yield* promise(() => runtime.inspectAccountPairing!(value.code!));
    yield* check();
    if (!preview || !preview.workspaces.some((w) => w.workspaceId === value.context.workspaceId))
      return null;
    if (preview.expiresAt !== value.context.expiresAt)
      return yield* Effect.fail(refuse('pairing-tampered'));
    value.nativeRequestId = preview.requestId;
    value.phase = 'waiting';
    return {
      ...snapshot(value),
      deviceName: preview.deviceName,
      requestId: preview.requestId,
    } satisfies E2eeAutomaticPairingReview;
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
            !other.admitted &&
            !(yield* expires(other))
          )
            return yield* Effect.fail(refuse('pairing-elsewhere'));
        }
        let retained = requesting.get(workspaceId);
        if (retained && (yield* expires(retained)) && retained.attempted && !retained.admitted) {
          const expectedLookupId = retained.lookupId;
          if (expectedLookupId)
            yield* promise(() => runtime.cancelAccountPairing!({ expectedLookupId }));
          retained.attempted = false;
        }
        if (!retained || ['expired', 'declined', 'cancelled'].includes(retained.phase)) {
          if (retained) dispose(retained);
          retained = entry(
            {
              version: 1,
              id: id(options.crypto),
              accountId: account!,
              workspaceId,
              genesisHash: hint.genesisHash,
              deviceName: options.deviceName,
              expiresAt: (yield* now) + 600_000,
            },
            'requester'
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
        dispose(value);
        approving.delete(id);
      }
    for (const value of requesting.values()) yield* expires(value);
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
                  dispose(previous);
                  approving.delete(key);
                }
              if (approving.size >= 10) return null;
            }
            value = entry(c, 'approver');
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
              if (!closed && options.account() === account) changed();
            }),
        }
      : {}),
    startAutomaticPairing: (workspaceId: string) => options.run(start(workspaceId)),
    automaticPairingState: (workspaceId: string) => {
      const value = requesting.get(workspaceId);
      return value
        ? options.run(value.gate.withPermit(requesterTick(value)))
        : Promise.resolve(null);
    },
    cancelAutomaticPairing: (workspaceId: string) =>
      options.run(
        Effect.gen(function* () {
          yield* check();
          const value = requesting.get(workspaceId);
          if (!value) return;
          yield* value.gate.withPermit(
            Effect.gen(function* () {
              if (value.admitted) return;
              yield* relay.exchange({ id: value.context.id, terminal: 'cancelled' });
              if (value.attempted && value.lookupId)
                yield* promise(() =>
                  runtime.cancelAccountPairing!({ expectedLookupId: value.lookupId! })
                );
              value.phase = 'cancelled';
              dispose(value);
            })
          );
        })
      ),
    pendingAutomaticPairing: () => options.run(pending()),
    approveAutomaticPairing: (id: string) =>
      options.run(
        Effect.gen(function* () {
          yield* check();
          const value = approving.get(id);
          if (!value?.nativeRequestId || !value.channel || value.phase !== 'waiting')
            return yield* Effect.fail(refuse('pairing-tampered'));
          yield* value.gate.withPermit(
            Effect.gen(function* () {
              if (yield* expires(value)) return yield* Effect.fail(refuse('pairing-expired'));
              value.authorizing = true;
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
              if (value.authorizing) return yield* Effect.fail(refuse('pairing-used'));
              if (value.code && value.nativeRequestId)
                yield* promise(() =>
                  runtime.declineAccountPairing!({
                    pairingString: value.code!,
                    requestId: value.nativeRequestId!,
                  })
                );
              yield* relay.exchange({ id, terminal: 'declined' });
              value.phase = 'declined';
              dispose(value);
            })
          );
        })
      ),
    disposeAutomaticPairing() {
      closed = true;
      for (const value of [...requesting.values(), ...approving.values()]) dispose(value);
      requesting.clear();
      approving.clear();
      notified.clear();
    },
  };
}
