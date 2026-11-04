import { own } from '../lifecycle';
import { Clock, Context, Effect, Layer, Result, Schema, Semaphore } from 'effect';
import { LedgerPinStore, LedgerViewSource } from '../../services/ledger';
import { makeEpochWriteGrace } from './epoch-write-grace';
import { WorkspaceScope } from '../../services/workspace';
import { hasVerifiedCheckpoint, requireLedgerContinuation, type LedgerView } from './index';

/**
 * The ledger view a workflow may act on was rejected.
 *
 * - `rollback`: the view does not extend what this device already accepted
 *   (in this process or durably pinned before restart), or it belongs to
 *   another workspace. Treat as a possible attack; never act on the view.
 * - `source`: the {@link LedgerViewSource} failed to produce a view.
 * - `storage`/`corrupt`: the pin store failed.
 *
 * @category Errors
 */
export class VerifiedLedgerError extends Schema.TaggedError<VerifiedLedgerError>()(
  'VerifiedLedgerError',
  {
    reason: Schema.Literals(['rollback', 'source', 'storage', 'corrupt']),
    cause: Schema.optional(Schema.Defect()),
  }
) {}

const reject = (reason: VerifiedLedgerError['reason'], cause?: unknown) =>
  new VerifiedLedgerError({ reason, cause });

/**
 * The single rollback/fork guard every workflow uses before acting on ledger
 * state.
 *
 * `current()` fetches a view from {@link LedgerViewSource}, then requires that
 * it is a genuine library-verified view of this workspace, that it extends the
 * newest view observed in this process, and that it contains the durably pinned
 * checkpoint. It then advances the pin. `ensureCurrent(view)` repeats the
 * in-process check for a view obtained earlier, so a workflow can refuse to
 * persist work derived from a view that something newer has superseded.
 *
 * Passing these checks proves freshness only relative to this device's own
 * history; global freshness still depends on the ledger log not hiding records.
 *
 * @category Workflows
 */
export class VerifiedLedger extends Context.Service<
  VerifiedLedger,
  {
    /** Verify workspace, continuation and the durable pin before returning a view; source failures leave the pin unchanged. */
    current(): Effect.Effect<LedgerView, VerifiedLedgerError>;
    /** Reject a view superseded by this process's observed history; performs no source read or pin write. */
    ensureCurrent(view: LedgerView): Effect.Effect<void, VerifiedLedgerError>;
    /** Local, durable <=15 minute budget after observing a newer published epoch. No source/network read
     * and no write permission; missing storage/clock continuity refuses retained-key writes. */
    readonly canWriteRetainedEpoch?: (epoch: number) => Effect.Effect<boolean>;
  }
>()('@lody/e2ee-core/VerifiedLedger') {
  /** Requires {@link WorkspaceScope}, {@link LedgerViewSource} and {@link LedgerPinStore}. */
  static readonly layer = Layer.effect(
    VerifiedLedger,
    Effect.gen(function* () {
      const { genesis } = yield* WorkspaceScope;
      const source = own(yield* LedgerViewSource);
      const pins = own(yield* LedgerPinStore);
      const serial = yield* Semaphore.make(1);
      const grace = makeEpochWriteGrace(pins, yield* Clock.Clock);
      let observed: LedgerView | undefined;
      let firstPinRead = true;

      const continues = (view: LedgerView) =>
        Result.isSuccess(requireLedgerContinuation(view, view)) &&
        view.genesis.equals(genesis) &&
        (!observed || Result.isSuccess(requireLedgerContinuation(observed, view)));

      const ensureCurrent = Effect.fnUntraced(function* (view: LedgerView) {
        if (!continues(view)) return yield* reject('rollback');
        return undefined;
      });

      const accept = Effect.fnUntraced(function* (view: LedgerView) {
        if (!continues(view)) return yield* reject('rollback');
        yield* grace.capture(view.inspectState().epoch.number);
        // Keep genuine knowledge even if persisting the pin fails below.
        observed = view;
        const pin = yield* pins
          .read()
          .pipe(
            Effect.mapError((error) =>
              reject(error.reason === 'corrupt' ? 'corrupt' : 'storage', error)
            )
          );
        if (pin) {
          const contained = hasVerifiedCheckpoint(view, pin);
          if (Result.isFailure(contained) || !contained.success) return yield* reject('rollback');
        }
        yield* grace.observe(view.inspectState().epoch.number, firstPinRead && pin !== null);
        firstPinRead = false;
        if (pin && pin.length === view.length && pin.head.equals(view.head)) return undefined;
        yield* pins
          .write({ head: view.head, length: view.length })
          .pipe(
            Effect.mapError((error) =>
              reject(error.reason === 'corrupt' ? 'corrupt' : 'storage', error)
            )
          );
        return undefined;
      });

      return VerifiedLedger.of({
        canWriteRetainedEpoch: Effect.fn('@lody/e2ee-core/VerifiedLedger.canWriteRetainedEpoch')(
          (epoch: number) =>
            serial.withPermit(
              Effect.suspend(() =>
                !Number.isSafeInteger(epoch) ||
                epoch < 0 ||
                !observed ||
                epoch >= observed.inspectState().epoch.number
                  ? Effect.succeed(false)
                  : grace.allowed(epoch)
              )
            )
        ),
        current: Effect.fn('@lody/e2ee-core/VerifiedLedger.current')(function* () {
          const view = yield* source
            .current()
            .pipe(Effect.mapError((cause) => reject('source', cause)));
          // Start at genuine observation, before waiting for another local pin operation.
          if (continues(view)) yield* grace.capture(view.inspectState().epoch.number);
          yield* serial.withPermit(accept(view));
          return view;
        }),
        ensureCurrent: Effect.fn('@lody/e2ee-core/VerifiedLedger.ensureCurrent')(function* (view) {
          return yield* serial.withPermit(ensureCurrent(view));
        }),
      });
    })
  );
}
