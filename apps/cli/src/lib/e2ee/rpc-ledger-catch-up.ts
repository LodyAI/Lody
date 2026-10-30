import { Effect, Result } from 'effect';
import { ContentError, inspectContentFrame } from '@lody/e2ee-core/protocol';

const CATCH_UP_TIMEOUT_MS = 30_000;

/** Unverified header epoch of a dispatch request frame; it only selects a refresh. */
const declaredDispatchEpoch = (frameHex: string): number | undefined => {
  if (typeof frameHex !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(frameHex)) return undefined;
  const metadata = inspectContentFrame(Buffer.from(frameHex, 'hex'), 'rpc-request');
  return Result.isSuccess(metadata) ? metadata.success.epoch : undefined;
};

/**
 * A requester seals at its newest verified epoch, so a dispatch sent right after a
 * key rotation can name an epoch this machine has not ingested yet. Only that case
 * joins the workspace's existing ledger/key refresh, once and bounded, then reopens
 * the same frame. The core open guard still decides the retried frame; a frame at
 * or below the verified epoch never triggers network work.
 */
export function openDispatchAfterLedgerCatchUp<A, E>(options: {
  readonly open: (machineId: string, frameHex: string) => Effect.Effect<A, E>;
  readonly currentEpoch: () => Effect.Effect<number, unknown>;
  readonly catchUp: () => Promise<void>;
  readonly frameEpoch?: (frameHex: string) => number | undefined;
  readonly timeoutMs?: number;
}) {
  const frameEpoch = options.frameEpoch ?? declaredDispatchEpoch;
  return (machineId: string, frameHex: string): Effect.Effect<A, E> =>
    options.open(machineId, frameHex).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (!(error instanceof ContentError) || error.code !== 'unauthorized')
            return yield* Effect.fail(error);
          const declared = frameEpoch(frameHex);
          const local = yield* Effect.result(options.currentEpoch());
          if (declared === undefined || Result.isFailure(local) || declared <= local.success)
            return yield* Effect.fail(error);
          // The refresh owner reports its own failures; a timeout leaves it running.
          yield* Effect.exit(
            Effect.promise(() => options.catchUp()).pipe(
              Effect.timeout(options.timeoutMs ?? CATCH_UP_TIMEOUT_MS)
            )
          );
          return yield* options.open(machineId, frameHex);
        })
      )
    );
}
