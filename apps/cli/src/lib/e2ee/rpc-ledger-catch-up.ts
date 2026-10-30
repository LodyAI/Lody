import { Effect, Result } from 'effect';
import { ContentError, inspectContentFrame } from '@lody/e2ee-core/protocol';

const CATCH_UP_TIMEOUT_MS = 30_000;

/** Non-secret diagnosis of a request rejected by the core epoch guard. */
export type LedgerCatchUpEvent = {
  readonly frameEpoch: number;
  readonly localEpoch: number;
  readonly outcome: 'not-newer' | 'caught-up' | 'still-rejected';
};

type CatchUpOptions = {
  readonly currentEpoch: () => Effect.Effect<number, unknown>;
  readonly catchUp: () => Promise<void>;
  readonly frameEpoch?: (frameHex: string) => number | undefined;
  readonly timeoutMs?: number;
  readonly observe?: (event: LedgerCatchUpEvent) => void;
};

/** Unverified header epoch of a request frame; it only selects a refresh. */
const declaredRequestEpoch = (frameHex: string): number | undefined => {
  if (typeof frameHex !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(frameHex)) return undefined;
  const metadata = inspectContentFrame(Buffer.from(frameHex, 'hex'), 'rpc-request');
  return Result.isSuccess(metadata) ? metadata.success.epoch : undefined;
};

/**
 * A requester seals at its newest verified epoch, so a request sent right after a
 * key rotation can name an epoch this machine has not ingested yet. Only that case
 * joins the workspace's existing ledger/key refresh, once and bounded, then reopens
 * the same frame. The core open guard still decides the retried frame; a frame at
 * or below the verified epoch never triggers network work.
 */
export function openDispatchAfterLedgerCatchUp<A, E>(
  options: CatchUpOptions & {
    readonly open: (machineId: string, frameHex: string) => Effect.Effect<A, E>;
  }
) {
  const frameEpoch = options.frameEpoch ?? declaredRequestEpoch;
  const observe = (event: LedgerCatchUpEvent) => {
    try {
      options.observe?.(event);
    } catch {
      /* Diagnostics never change the open result. */
    }
  };
  return (machineId: string, frameHex: string): Effect.Effect<A, E> =>
    options.open(machineId, frameHex).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (!(error instanceof ContentError) || error.code !== 'unauthorized')
            return yield* Effect.fail(error);
          const declared = frameEpoch(frameHex);
          const local = yield* Effect.result(options.currentEpoch());
          if (declared === undefined || Result.isFailure(local)) return yield* Effect.fail(error);
          if (declared <= local.success) {
            observe({ frameEpoch: declared, localEpoch: local.success, outcome: 'not-newer' });
            return yield* Effect.fail(error);
          }
          // The refresh owner reports its own failures; a timeout leaves it running.
          yield* Effect.exit(
            Effect.promise(() => options.catchUp()).pipe(
              Effect.timeout(options.timeoutMs ?? CATCH_UP_TIMEOUT_MS)
            )
          );
          return yield* options.open(machineId, frameHex).pipe(
            Effect.tap(() =>
              Effect.sync(() =>
                observe({ frameEpoch: declared, localEpoch: local.success, outcome: 'caught-up' })
              )
            ),
            Effect.tapError(() =>
              Effect.sync(() =>
                observe({
                  frameEpoch: declared,
                  localEpoch: local.success,
                  outcome: 'still-rejected',
                })
              )
            )
          );
        })
      )
    );
}

/** Applies the same catch-up to every request opener of an encrypted RPC native. */
export function withLedgerCatchUp<
  N extends {
    readonly openDispatch: (machineId: string, frameHex: string) => Effect.Effect<unknown, unknown>;
    readonly openFeature: (machineId: string, frameHex: string) => Effect.Effect<unknown, unknown>;
  },
>(native: N, options: CatchUpOptions): N {
  // Each wrapper returns exactly its opener's success and failure types.
  return {
    ...native,
    openDispatch: openDispatchAfterLedgerCatchUp({ ...options, open: native.openDispatch }),
    openFeature: openDispatchAfterLedgerCatchUp({ ...options, open: native.openFeature }),
  } as N;
}
