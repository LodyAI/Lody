/* eslint-disable no-extend-native -- Install missing APIs before app or Worker dependencies run on iOS 16.4. */

const arrayPrototype = Array.prototype as Array<unknown> & {
  toReversed?: () => unknown[];
  toSorted?: (compareFn?: (a: unknown, b: unknown) => number) => unknown[];
  toSpliced?: (start: number, deleteCount?: number, ...items: unknown[]) => unknown[];
  with?: (index: number, value: unknown) => unknown[];
};

if (arrayPrototype.toSorted === undefined) {
  Object.defineProperty(Array.prototype, 'toSorted', {
    value: function toSorted<T>(this: T[], compareFn?: (a: T, b: T) => number): T[] {
      return [...this].sort(compareFn);
    },
    configurable: true,
    writable: true,
  });
}

if (arrayPrototype.toReversed === undefined) {
  Object.defineProperty(Array.prototype, 'toReversed', {
    value: function toReversed<T>(this: T[]): T[] {
      return [...this].reverse();
    },
    configurable: true,
    writable: true,
  });
}

if (arrayPrototype.toSpliced === undefined) {
  Object.defineProperty(Array.prototype, 'toSpliced', {
    value: function toSpliced<T>(
      this: T[],
      start: number,
      deleteCount?: number,
      ...items: T[]
    ): T[] {
      const copy = [...this];
      if (arguments.length === 1) {
        copy.splice(start);
      } else if (arguments.length > 1) {
        copy.splice(start, deleteCount ?? 0, ...items);
      }
      return copy;
    },
    configurable: true,
    writable: true,
  });
}

if (arrayPrototype.with === undefined) {
  Object.defineProperty(Array.prototype, 'with', {
    value: function arrayWith<T>(this: T[], index: number, value: T): T[] {
      const copy = [...this];
      // Unary + follows ToNumber (including rejecting bigint); NaN becomes 0.
      const numericIndex = +index;
      const integerIndex = Number.isNaN(numericIndex) ? 0 : Math.trunc(numericIndex);
      const resolvedIndex = integerIndex < 0 ? copy.length + integerIndex : integerIndex;
      if (resolvedIndex < 0 || resolvedIndex >= copy.length) {
        throw new RangeError('Invalid index');
      }
      copy[resolvedIndex] = value;
      return copy;
    },
    configurable: true,
    writable: true,
  });
}

const promiseConstructor = Promise as PromiseConstructor & { withResolvers?: unknown };

if (promiseConstructor.withResolvers === undefined) {
  Object.defineProperty(Promise, 'withResolvers', {
    value: function withResolvers<T>(this: PromiseConstructor) {
      let resolve: ((value: T | PromiseLike<T>) => void) | undefined;
      let reject: ((reason?: unknown) => void) | undefined;
      const promise = new this<T>((resolvePromise, rejectPromise) => {
        if (resolve !== undefined || reject !== undefined) {
          throw new TypeError('Promise capability already initialized');
        }
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      if (typeof resolve !== 'function' || typeof reject !== 'function') {
        throw new TypeError('Invalid Promise constructor');
      }
      return { promise, resolve, reject };
    },
    configurable: true,
    writable: true,
  });
}

if (AbortSignal.any === undefined) {
  // Keep composite signals through the entire fetch body lifetime. WebKit may
  // collect a signal passed only in RequestInit, even while native fetch is
  // following it. These weak keys release completed/unreferenced responses;
  // the source signal never roots an already completed request.
  if (typeof globalThis.fetch === 'function') {
    const nativeFetch = globalThis.fetch;
    const responseSignals = new WeakMap<Response | ReadableStream<Uint8Array>, AbortSignal>();
    globalThis.fetch = (input, init) => {
      // Request.signal is a following signal, not necessarily the original
      // composite. Callers constructing Requests must retain that original.
      const signal =
        init?.signal === undefined
          ? input instanceof Request
            ? input.signal
            : undefined
          : init.signal;
      return nativeFetch(input, init).then((response) => {
        // This closure also keeps the signal alive until headers arrive.
        if (signal) {
          responseSignals.set(response, signal);
          if (response.body) responseSignals.set(response.body, signal);
        }
        return response;
      });
    };
  }

  // This scoped shim requires an operation owner to hold its output until the
  // operation ends. Event-only consumers need explicit retention (PDF uses
  // pdfAbortSignalAny); it does not emulate native dependent-signal GC roots.
  // Use native getters for brand checks and abort state, including cross-realm
  // signals. instanceof and user-dispatched `abort` events are not sufficient.
  const signalPrototype = Object.getPrototypeOf(new AbortController().signal);
  const getAborted = Object.getOwnPropertyDescriptor(signalPrototype, 'aborted')!.get!;
  const getReason = Object.getOwnPropertyDescriptor(signalPrototype, 'reason')!.get!;

  type Subscription = { source: WeakRef<AbortSignal>; listener: () => void };
  // An externally held output keeps its controller and intermediate composites
  // alive. Ephemeron keys allow the whole group to be collected with the output.
  const activeSignals = new WeakMap<
    AbortSignal,
    { controller: AbortController; sources: AbortSignal[] }
  >();

  function removeSubscriptions(subscriptions: Subscription[]) {
    for (const { source, listener } of subscriptions) {
      source.deref()?.removeEventListener('abort', listener);
    }
    subscriptions.length = 0;
  }

  // Held values contain only weak source references and listeners whose closure
  // contains weak references too. Never capture a controller/output here.
  const collectedSignals = new FinalizationRegistry(removeSubscriptions);

  function createAbortListener(
    controllerRef: WeakRef<AbortController>,
    sourceRef: WeakRef<AbortSignal>,
    subscriptions: Subscription[]
  ) {
    return () => {
      const controller = controllerRef.deref();
      if (!controller) {
        removeSubscriptions(subscriptions);
        collectedSignals.unregister(subscriptions);
        return;
      }
      const source = sourceRef.deref();
      if (!source || !getAborted.call(source)) return;
      const reason = getReason.call(source);
      removeSubscriptions(subscriptions);
      collectedSignals.unregister(subscriptions);
      activeSignals.delete(controller.signal);
      controller.abort(reason);
    };
  }

  Object.defineProperty(AbortSignal, 'any', {
    value: function any(signals: Iterable<AbortSignal>): AbortSignal {
      // Validate the entire iterable before considering an already-aborted
      // source, matching Web IDL's conversion of sequence<AbortSignal>.
      const sources: AbortSignal[] = [];
      for (const source of signals) {
        getAborted.call(source);
        sources.push(source);
      }
      const controller = new AbortController();
      for (const source of sources) {
        if (getAborted.call(source)) {
          controller.abort(getReason.call(source));
          return controller.signal;
        }
      }
      const uniqueSources = [...new Set(sources)];
      if (uniqueSources.length === 0) return controller.signal;

      const subscriptions: Subscription[] = [];
      activeSignals.set(controller.signal, { controller, sources: uniqueSources });
      collectedSignals.register(controller.signal, subscriptions, subscriptions);
      const controllerRef = new WeakRef(controller);
      for (const source of uniqueSources) {
        const sourceRef = new WeakRef(source);
        const listener = createAbortListener(controllerRef, sourceRef, subscriptions);
        subscriptions.push({ source: sourceRef, listener });
        // Do not use once: a synthetic abort event must not consume the listener.
        source.addEventListener('abort', listener);
        listener();
        if (controller.signal.aborted) break;
      }
      return controller.signal;
    },
    configurable: true,
    writable: true,
  });
}
