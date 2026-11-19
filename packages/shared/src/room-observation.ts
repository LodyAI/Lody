/** The single observation lifecycle used by Node and renderer transports. */
export type ReleaseReceipt = { status: 'acknowledged' | 'disconnected'; generation: number };
export type ObservationHandle = { release(): Promise<ReleaseReceipt> };
export type ObservationEvent<T> =
  | { kind: 'snapshot' | 'changes'; entries: T[]; generation: number }
  | { kind: 'invalidated'; generation: number };
export type ObservationSource<T> = {
  begin(listener: (event: ObservationEvent<T>) => void): {
    handle: ObservationHandle;
    ready: Promise<unknown>;
  };
};

/** Ownership exists synchronously, including while establishment is pending.
 * The transport owns reconnection; only a fresh snapshot revalidates a view.
 * The underlying SDK/IPC handle retains failed release attempts for retry.
 */
export function observeRoom<T>(
  source: ObservationSource<T>,
  listener: (event: ObservationEvent<T>) => void
) {
  let active = true;
  let current: number | undefined;
  let valid = false;
  const opening = source.begin((event) => {
    if (!active || (current !== undefined && event.generation < current)) return;
    if (event.kind === 'invalidated') {
      current = event.generation;
      valid = false;
      listener(event);
    } else if (event.kind === 'snapshot') {
      current = event.generation;
      valid = true;
      listener(event);
    } else if (valid && event.generation === current) {
      listener(event);
    }
  });
  return {
    ready: opening.ready,
    release: () => {
      active = false;
      valid = false;
      return opening.handle.release();
    },
  };
}

/** Adapts asynchronous transports without losing ownership during acquisition. */
export function deferredObservationSource<T>(
  acquire: (listener: (event: ObservationEvent<T>) => void) => Promise<{
    handle: ObservationHandle;
    ready: Promise<unknown>;
  }>
): ObservationSource<T> {
  return {
    begin(listener) {
      const acquired = acquire(listener);
      let pending: Promise<ReleaseReceipt> | undefined;
      let result: ReleaseReceipt | undefined;
      return {
        ready: acquired.then((value) => value.ready),
        handle: {
          release() {
            if (result) return Promise.resolve(result);
            if (pending) return pending;
            pending = acquired
              .then(
                (value) => value.handle.release(),
                () => ({ status: 'disconnected' as const, generation: 0 })
              )
              .then((receipt) => {
                result = receipt;
                return receipt;
              })
              .finally(() => {
                pending = undefined;
              });
            return pending;
          },
        },
      };
    },
  };
}
