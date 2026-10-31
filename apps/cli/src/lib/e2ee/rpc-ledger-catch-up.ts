import { Effect, Result } from 'effect';
import { InstalledKeyError } from '@lody/e2ee-core';
import {
  Bytes,
  ContentError,
  inspectContentFrame,
  verifyContentSignature,
  type LedgerView,
} from '@lody/e2ee-core/protocol';

const CATCH_UP_TIMEOUT_MS = 30_000;
const CATCH_UP_COOLDOWN_MS = 60_000;

/** Non-secret diagnosis of a request rejected by the core epoch guard. */
export type LedgerCatchUpEvent = {
  readonly frameEpoch: number;
  readonly localEpoch: number;
  readonly outcome: 'not-newer' | 'unauthenticated' | 'cooldown' | 'caught-up' | 'still-rejected';
};

export type LedgerCatchUpOptions = {
  /** Hex genesis hash of this workspace. */
  readonly genesis: string;
  /** Logical RPC resource of the target machine. */
  readonly resource: (machineId: string) => string;
  /** This machine's current verified ledger. */
  readonly ledger: () => Effect.Effect<LedgerView, unknown>;
  /** Uses the workspace refresh owner; never extends an in-flight round or resets retries. */
  readonly catchUp: () => Promise<void>;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly cooldownMs?: number;
  readonly observe?: (event: LedgerCatchUpEvent) => void;
};

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const ledgerState = (view: LedgerView) => `${view.inspectState().epoch.number}:${view.length}`;

/**
 * A requester seals at its newest verified epoch, so a request sent right after a
 * key rotation can name an epoch this machine has not ingested or installed yet.
 * Only a frame signed by a device of the current verified ledger, for this exact genesis,
 * resource and declared epoch, may wait for the workspace's existing ledger/key
 * refresh. All such frames share one bounded wait per verified ledger state; a
 * rejected reopening at an unchanged state cools down before another attempt. The core
 * open guard still decides every reopened frame.
 */
export function makeLedgerCatchUp(options: LedgerCatchUpOptions) {
  const now = options.now ?? Date.now;
  let flight: { state: string; done: Promise<void> } | undefined;
  let exhausted: { state: string; until: number } | undefined;
  const observe = (event: LedgerCatchUpEvent) => {
    try {
      options.observe?.(event);
    } catch {
      /* Diagnostics never change the open result. */
    }
  };
  const authenticated = (view: LedgerView, machineId: string, frame: Uint8Array) => {
    const metadata = inspectContentFrame(frame, 'rpc-request');
    if (Result.isFailure(metadata)) return false;
    const state = view.inspectState();
    const device = state.devices.get(metadata.success.device);
    if (
      !device ||
      device.kind === 'recovery' ||
      !state.members.has(hex(device.membershipId.toBytes()))
    )
      return false;
    const signer = Bytes.signingPublicKey(Buffer.from(metadata.success.device, 'hex'));
    if (Result.isFailure(signer)) return false;
    let resource: string;
    try {
      resource = options.resource(machineId);
    } catch {
      return false;
    }
    return Result.isSuccess(
      verifyContentSignature(
        frame,
        {
          genesis: options.genesis,
          resource,
          epoch: metadata.success.epoch,
          purpose: 'rpc-request',
        },
        signer.success
      )
    );
  };
  // One wait per verified ledger state, shared by concurrent frames.
  const join = (state: string) => {
    if (flight?.state === state) return flight.done;
    const done = (async () => {
      await Effect.runPromise(
        Effect.exit(
          Effect.promise(() => options.catchUp()).pipe(
            Effect.timeout(options.timeoutMs ?? CATCH_UP_TIMEOUT_MS)
          )
        )
      );
      const after = await Effect.runPromise(Effect.result(options.ledger()));
      if (Result.isFailure(after) || ledgerState(after.success) === state)
        exhausted = { state, until: now() + (options.cooldownMs ?? CATCH_UP_COOLDOWN_MS) };
      if (flight?.state === state) flight = undefined;
    })();
    flight = { state, done };
    return done;
  };

  return <A, E>(open: (machineId: string, frameHex: string) => Effect.Effect<A, E>) =>
    (machineId: string, frameHex: string): Effect.Effect<A, E> =>
      open(machineId, frameHex).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            const missingKey = error instanceof InstalledKeyError && error.reason === 'missing-key';
            if (
              (!missingKey &&
                (!(error instanceof ContentError) || error.code !== 'unauthorized')) ||
              typeof frameHex !== 'string' ||
              !/^(?:[0-9a-f]{2})+$/.test(frameHex)
            )
              return yield* Effect.fail(error);
            const frame = Buffer.from(frameHex, 'hex');
            const metadata = inspectContentFrame(frame, 'rpc-request');
            const view = yield* Effect.result(options.ledger());
            if (Result.isFailure(metadata) || Result.isFailure(view))
              return yield* Effect.fail(error);
            const frameEpoch = metadata.success.epoch;
            const localEpoch = view.success.inspectState().epoch.number;
            const report = (outcome: LedgerCatchUpEvent['outcome']) =>
              observe({ frameEpoch, localEpoch, outcome });
            if (frameEpoch < localEpoch || (frameEpoch === localEpoch && !missingKey)) {
              report('not-newer');
              return yield* Effect.fail(error);
            }
            if (!authenticated(view.success, machineId, frame)) {
              report('unauthenticated');
              return yield* Effect.fail(error);
            }
            const state = ledgerState(view.success);
            if (exhausted?.state === state && now() < exhausted.until) {
              report('cooldown');
              return yield* Effect.fail(error);
            }
            yield* Effect.promise(() => join(state));
            return yield* open(machineId, frameHex).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  // Installing the key can make progress without changing the ledger.
                  if (exhausted?.state === state) exhausted = undefined;
                  report('caught-up');
                })
              ),
              Effect.tapError(() => Effect.sync(() => report('still-rejected')))
            );
          })
        )
      );
}

type RequestOpener = (machineId: string, frameHex: string) => Effect.Effect<unknown, unknown>;

/** Dispatch and feature requests share one catch-up budget and wait. */
export function withLedgerCatchUp<
  N extends { readonly openDispatch: RequestOpener; readonly openFeature: RequestOpener },
>(native: N, wrap: ReturnType<typeof makeLedgerCatchUp>): N {
  // Each wrapper keeps exactly its opener's success and failure types.
  return {
    ...native,
    openDispatch: wrap(native.openDispatch),
    openFeature: wrap(native.openFeature),
  } as N;
}
