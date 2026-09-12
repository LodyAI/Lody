import { ControlLogError, invariant } from './wire';

/** Already verified by the application for this exact request/credential. Not a token format. */
export interface StreamsRequestLease {
  readonly expiresAt: number;
  /** Abort on logout/known revocation, including while no bytes arrive. */
  readonly signal: AbortSignal;
  readonly assertValid: () => void;
}

export interface BoundedStreamsFetchOptions {
  readonly fetch: typeof globalThis.fetch;
  readonly maxResponseBytes: number;
  readonly requestTimeoutMs: number;
  /** Trusted Unix milliseconds; uncertainty must be deducted from the lease deadline. */
  readonly now: () => number;
  /** Synchronous: called after the SDK's credential lookup, before network dispatch. */
  readonly authorize: (request: Request) => StreamsRequestLease;
}

/** Opt-in fetch for control/history/key SDK clients. Bounds bytes BEFORE SDK buffering.
 * This is client-side resource/lifecycle enforcement, not server revocation or write rollback.
 * The supplied fetch must honor manual redirects and abort. No retry or credential refresh. */
export function createBoundedStreamsFetch(
  options: BoundedStreamsFetchOptions
): typeof globalThis.fetch {
  const { fetch: upstream, maxResponseBytes, requestTimeoutMs, now, authorize } = options;
  invariant(
    Number.isSafeInteger(maxResponseBytes) &&
      maxResponseBytes > 0 &&
      maxResponseBytes <= 16 * 1024 * 1024,
    'invalid-response-limit'
  );
  invariant(
    Number.isSafeInteger(requestTimeoutMs) && requestTimeoutMs > 0 && requestTimeoutMs <= 900000,
    'invalid-request-timeout'
  );

  return async (input, init) => {
    const request = new Request(input, init);
    const lease = authorize(request);
    const { expiresAt, signal, assertValid } = lease;
    invariant(Number.isSafeInteger(expiresAt) && expiresAt >= 0, 'invalid-request-expiry');
    let lastTime = now();
    invariant(Number.isSafeInteger(lastTime) && lastTime >= 0, 'invalid-request-time');
    const deadline = Math.min(expiresAt, lastTime + requestTimeoutMs);
    const abort = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let output: ReadableStreamDefaultController<Uint8Array> | undefined;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectPending: (error: Error) => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      rejectPending = reject;
    });
    // A body can be cancelled after the fetch race settled; still observe its rejection.
    void cancelled.catch(() => {});
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      request.signal.removeEventListener('abort', onAbort);
      signal.removeEventListener('abort', onAbort);
    };
    function fail(error: Error) {
      if (finished) return;
      finished = true;
      cleanup();
      rejectPending(error);
      output?.error(error);
      abort.abort(error);
      // Cancellation must not wait for an uncooperative underlying source.
      if (reader) void reader.cancel(error).catch(() => {});
    }
    function onAbort() {
      fail(new ControlLogError('stream-request-aborted'));
    }
    function check() {
      if (finished) throw new ControlLogError('stream-request-ended');
      invariant(!request.signal.aborted && !signal.aborted, 'stream-request-aborted');
      assertValid();
      invariant(!finished && !request.signal.aborted && !signal.aborted, 'stream-request-aborted');
      const time = now();
      invariant(Number.isSafeInteger(time) && time >= lastTime, 'invalid-request-time');
      lastTime = time;
      invariant(time < deadline, 'stream-request-expired');
    }

    try {
      request.signal.addEventListener('abort', onAbort, { once: true });
      signal.addEventListener('abort', onAbort, { once: true });
      check();
      timer = setTimeout(
        () => fail(new ControlLogError('stream-request-expired')),
        deadline - lastTime
      );
      const pending = upstream(request, { signal: abort.signal, redirect: 'manual' }).then(
        (response) => {
          if (finished) {
            if (response.body) void response.body.cancel().catch(() => {});
            throw new ControlLogError('stream-request-ended');
          }
          return response;
        }
      );
      const response = await Promise.race([pending, cancelled]);
      // Own cancellation before checking metadata/authority, including error responses.
      reader = response.body?.getReader();
      check();
      invariant(
        !response.redirected &&
          response.status !== 0 &&
          ![301, 302, 303, 307, 308].includes(response.status),
        'stream-redirect-rejected'
      );
      const declared = response.headers.get('content-length');
      if (declared !== null)
        invariant(
          /^\d+$/.test(declared) && Number(declared) <= maxResponseBytes,
          'stream-response-too-large'
        );
      if (!reader) {
        finished = true;
        cleanup();
        return response;
      }
      const bodyReader = reader;
      let bytes = 0;
      const body = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            output = controller;
          },
          async pull(controller) {
            try {
              check();
              const next = await bodyReader.read();
              check();
              if (next.done) {
                finished = true;
                cleanup();
                bodyReader.releaseLock();
                controller.close();
                return;
              }
              invariant(next.value instanceof Uint8Array, 'invalid-response-chunk');
              bytes += next.value.byteLength;
              invariant(bytes <= maxResponseBytes, 'stream-response-too-large');
              controller.enqueue(next.value);
            } catch (error) {
              fail(error instanceof Error ? error : new ControlLogError('stream-response-failed'));
            }
          },
          cancel() {
            fail(new ControlLogError('stream-response-cancelled'));
          },
        },
        { highWaterMark: 0 }
      );
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      fail(error instanceof Error ? error : new ControlLogError('stream-request-failed'));
      throw error;
    }
  };
}
