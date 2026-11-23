export type SessionSyncProgress = {
  readonly kind: 'history' | 'bootstrap' | 'updates' | 'chunks';
  readonly received: number;
  readonly total?: number;
};

export type SessionSyncProgressView = {
  readonly getSnapshot: () => SessionSyncProgress | null;
  readonly subscribe: (listener: () => void) => () => void;
};

function isVisibleProgressStep(
  previous: SessionSyncProgress | null,
  next: SessionSyncProgress | null
): boolean {
  if (previous === null || next === null) return previous !== next;
  if (previous.kind !== next.kind || previous.total !== next.total) return true;
  if (next.received === previous.received) return false;
  if (next.received === next.total || next.received < previous.received) return true;
  return (next.received - previous.received) * 100 >= (next.total ?? previous.received);
}

/** Drops steps under 1% so per-chunk catch-up does not re-render per chunk. */
export function createSessionSyncProgressStore(observerLabel: string) {
  let snapshot: SessionSyncProgress | null = null;
  const listeners = new Set<() => void>();
  const view: SessionSyncProgressView = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    view,
    publish(next: SessionSyncProgress | null) {
      if (!isVisibleProgressStep(snapshot, next)) return;
      snapshot = next;
      for (const listener of Array.from(listeners)) {
        try {
          listener();
        } catch (error) {
          console.error(`${observerLabel} failed`, error);
        }
      }
    },
    clearListeners() {
      listeners.clear();
    },
  };
}

function streamOffset(offset: string): bigint | undefined {
  if (offset === '-1') return 0n;
  return /^\d{1,20}$/.test(offset) ? BigInt(offset) : undefined;
}

export type LoroTailDeadline = () => AbortSignal;

const defaultTailDeadline: LoroTailDeadline = () => AbortSignal.timeout(1500);

function trackLoroCatchUp(
  offset: string,
  readTail: (signal: AbortSignal) => Promise<string | undefined>,
  publish: (progress: SessionSyncProgress | null) => void,
  tailDeadline: LoroTailDeadline
) {
  const start = streamOffset(offset);
  let current = start;
  let target: bigint | undefined;
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, tailDeadline()]);
  const report = () => {
    if (start === undefined || current === undefined || controller.signal.aborted) return;
    if (target !== undefined && current >= target) {
      controller.abort();
      publish(null);
      return;
    }
    const received = Number(current - start);
    const total = target === undefined ? undefined : Number(target - start);
    if (
      !Number.isSafeInteger(received) ||
      (total !== undefined && (!Number.isSafeInteger(total) || total <= 0))
    )
      return;
    publish({ kind: 'updates', received, ...(total === undefined ? {} : { total }) });
  };
  report();
  void Promise.resolve()
    .then(() => (signal.aborted ? undefined : readTail(signal)))
    .then((tail) => {
      if (signal.aborted || start === undefined || tail === undefined) return;
      const observed = streamOffset(tail);
      if (observed === undefined) return;
      target = observed;
      report();
    })
    .catch(() => {});
  return {
    advance(nextOffset: string) {
      if (controller.signal.aborted) return;
      const next = streamOffset(nextOffset);
      if (next !== undefined && current !== undefined && next > current) {
        current = next;
        report();
      }
    },
    stop() {
      controller.abort();
    },
  };
}

export function createLoroSyncProgress(
  publish: (progress: SessionSyncProgress | null) => void,
  tailDeadline: LoroTailDeadline = defaultTailDeadline
) {
  let epoch = 0;
  let catchUp: ReturnType<typeof trackLoroCatchUp> | undefined;
  const begin = () => {
    const started = ++epoch;
    catchUp?.stop();
    catchUp = undefined;
    return (progress: SessionSyncProgress | null) => {
      if (epoch === started) publish(progress);
    };
  };
  return {
    beginBootstrap: begin,
    catchUp(offset: string, readTail: (signal: AbortSignal) => Promise<string | undefined>) {
      if (!catchUp) catchUp = trackLoroCatchUp(offset, readTail, begin(), tailDeadline);
    },
    advance(offset: string) {
      catchUp?.advance(offset);
    },
    clear() {
      begin()(null);
    },
  };
}

export function observeLoroBootstrap(
  fetchStream: typeof fetch,
  begin: () => (progress: SessionSyncProgress | null) => void,
  discardCursor: () => void
): typeof fetch {
  let generation = 0;
  return async (input, init) => {
    if (init?.method !== 'GET') return fetchStream(input, init);
    const url = new URL(typeof input === 'string' || !('url' in input) ? input : input.url);
    if (!url.pathname.endsWith('/bootstrap')) {
      const started = generation;
      const response = await fetchStream(input, init);
      if (started === generation && response.status === 410 && url.searchParams.has('offset'))
        discardCursor();
      return response;
    }

    generation += 1;
    const publish = begin();
    publish({ kind: 'bootstrap', received: 0 });
    try {
      const response = await fetchStream(input, init);
      if (response.ok && response.body)
        return observeBootstrapBody(response, response.body, publish);
      publish(null);
      return response;
    } catch (error) {
      publish(null);
      throw error;
    }
  };
}

function observeBootstrapBody(
  response: Response,
  body: ReadableStream<Uint8Array>,
  publish: (progress: SessionSyncProgress | null) => void
): Response {
  const length = response.headers.get('Content-Length');
  const encoding = response.headers.get('Content-Encoding');
  const sameOrigin = response.type === 'basic' || response.type === 'default';
  let total =
    (encoding === 'identity' || (encoding === null && sameOrigin)) &&
    length !== null &&
    /^\d+$/.test(length) &&
    Number.isSafeInteger(Number(length)) &&
    Number(length) > 0
      ? Number(length)
      : undefined;
  let received = 0;
  const reader = body.getReader();
  let reading = true;
  const observed = new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (!reading) return;
          if (next.done) {
            if (received > 0) publish({ kind: 'bootstrap', received, total: received });
            controller.close();
            reading = false;
            reader.releaseLock();
            return;
          }
          received += next.value.byteLength;
          if (total !== undefined && received > total) total = undefined;
          if (received !== total) {
            publish({ kind: 'bootstrap', received, ...(total === undefined ? {} : { total }) });
          }
          controller.enqueue(next.value);
        } catch (error) {
          if (!reading) return;
          reading = false;
          reader.releaseLock();
          publish(null);
          controller.error(error);
        }
      },
      async cancel(reason) {
        if (!reading) return;
        reading = false;
        publish(null);
        try {
          await reader.cancel(reason);
        } finally {
          reader.releaseLock();
        }
      },
    }),
    { status: response.status, statusText: response.statusText, headers: response.headers }
  );
  Object.defineProperties(observed, {
    url: { value: response.url },
    redirected: { value: response.redirected },
    type: { value: response.type },
  });
  return observed;
}
