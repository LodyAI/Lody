import { Cause, Effect, Exit, Layer, ManagedRuntime } from 'effect';
import { LocalLoroWriter, LocalLoroWriterLive, LocalLoroWriterTurn } from './index';

/** @deprecated Single execution boundary for room/doc/socket Promise owners.
 * Delete when the application provides LocalLoroWriter natively. Never use
 * this executor from a native Effect workflow. */
export const makeLocalLoroWriterLegacy = (turnLayer: Layer.Layer<LocalLoroWriterTurn>) => {
  const runtime = ManagedRuntime.make(LocalLoroWriterLive.pipe(Layer.provide(turnLayer)));
  const writer = runtime.runSync(LocalLoroWriter);
  const executeEffect = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
    runtime.runPromiseExit(effect).then((exit) => {
      if (Exit.isFailure(exit)) throw new LocalLoroWriterLegacyFailure(exit.cause);
      return exit.value;
    });
  let receipt: Promise<void> | null = null;
  let released = false;
  const closeLegacy = (): Promise<void> => {
    if (released) return Promise.resolve();
    return (receipt ??= executeEffect(writer.close)
      .then(() => runtime.dispose())
      .then(() => {
        released = true;
      })
      .finally(() => {
        receipt = null;
      }));
  };
  return { writer, executeEffect, closeLegacy, isReleased: () => released };
};

export class LocalLoroWriterLegacyFailure extends Error {
  constructor(readonly fullCause: Cause.Cause<unknown>) {
    super('Local Loro writer failed; full Cause and recovery owner retained');
  }
}

// Browser/in-memory fallback belongs to this deprecated platform facade only.
// The CLI injects its Node turn at process composition before creating engines.
let processWriterLegacy: ReturnType<typeof makeLocalLoroWriterLegacy> | undefined;
export const getProcessLocalLoroWriterLegacy = (turnLayer?: Layer.Layer<LocalLoroWriterTurn>) =>
  (processWriterLegacy ??= makeLocalLoroWriterLegacy(
    turnLayer ??
      Layer.succeed(LocalLoroWriterTurn, {
        next: Effect.callback<void>((resume) => {
          const handle = setTimeout(() => resume(Effect.void), 0);
          return Effect.sync(() => clearTimeout(handle));
        }),
      })
  ));
export const setProcessLocalLoroWriterLegacy = (
  writer: ReturnType<typeof makeLocalLoroWriterLegacy>
) => {
  if (processWriterLegacy && processWriterLegacy !== writer)
    throw new Error('local_loro_writer_already_owned');
  processWriterLegacy = writer;
};

export type LocalLoroWriterLegacy = ReturnType<typeof makeLocalLoroWriterLegacy>;
/** @deprecated Application shutdown only; failed close retains the same owner. */
export const closeProcessLocalLoroWriterLegacy = async (): Promise<void> => {
  const owner = processWriterLegacy;
  if (!owner) return;
  await owner.closeLegacy();
  if (processWriterLegacy === owner) processWriterLegacy = undefined;
};
