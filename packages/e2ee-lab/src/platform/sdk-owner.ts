import { Cause, Data, Effect, Exit } from 'effect';

export class LabSdkError extends Data.TaggedError('LabSdkError')<{
  readonly code: 'closed' | 'native';
}> {}
/** For CRDT SDK lifecycle ports with close():Promise<void>. StreamsClient's
 * close() publishes stream EOF and is never lifecycle disposal; use an explicit
 * request-lease port for that HTTP facade. The CRDT SDK close() does not await every one-shot operation. Own raw operations
 * explicitly, abort this document's admission/requests, await actual settlement, then close
 * its SDK before earlier CRDT/storage owners can be released. No timeout implies stopped work. */
export function makeLabSdkOwner<T extends { close(): Promise<void> }>(
  create: (context: { readonly signal: AbortSignal; readonly assertOpen: () => void }) => T
) {
  return Effect.gen(function* () {
    const controller = new AbortController();
    const active = new Set<Promise<unknown>>();
    const assertOpen = () => {
      if (controller.signal.aborted) throw new LabSdkError({ code: 'closed' });
    };
    let sdk: T | undefined;
    yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          sdk = create({ signal: controller.signal, assertOpen });
          return sdk;
        },
        catch: () => new LabSdkError({ code: 'native' }),
      }),
      (value) =>
        Effect.promise(async () => {
          controller.abort();
          await Promise.allSettled([...active]);
          try {
            await value.close();
          } finally {
            sdk = undefined;
          }
        })
    );
    return Object.freeze({
      invoke: <A>(work: (value: T) => Promise<A>) =>
        Effect.acquireUseRelease(
          Effect.try({
            try: () => {
              assertOpen();
              const raw = Promise.resolve().then(() => {
                assertOpen();
                const current = sdk;
                if (!current) throw new LabSdkError({ code: 'closed' });
                return work(current);
              });
              active.add(raw);
              // Observers settle only with the raw SDK work, not Effect cancellation.
              raw.then(
                () => active.delete(raw),
                () => active.delete(raw)
              );
              return raw;
            },
            catch: (cause) =>
              cause instanceof LabSdkError ? cause : new LabSdkError({ code: 'native' }),
          }),
          (raw) =>
            Effect.tryPromise({
              try: (signal) => {
                if (signal.aborted) controller.abort();
                const cancel = () => controller.abort();
                signal.addEventListener('abort', cancel, { once: true });
                return raw
                  .then((value) => {
                    assertOpen();
                    return value;
                  })
                  .finally(() => signal.removeEventListener('abort', cancel));
              },
              catch: (cause) =>
                cause instanceof LabSdkError ? cause : new LabSdkError({ code: 'native' }),
            }),
          (raw, exit) =>
            Effect.promise(async () => {
              if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)) controller.abort();
              await raw.then(
                () => undefined,
                () => undefined
              );
            })
        ),
      stop: () => Effect.sync(() => controller.abort()),
      assertOpen,
      signal: controller.signal,
    });
  });
}
