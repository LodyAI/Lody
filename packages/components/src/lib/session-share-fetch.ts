/** Abort both the request and its body on teardown, including browsers without AbortSignal.any. */
export async function fetchSessionShare(
  input: string | URL,
  init: RequestInit,
  lifetime: AbortSignal,
  fetcher: typeof globalThis.fetch = globalThis.fetch
): Promise<Response> {
  const abort = new AbortController();
  const signals = [lifetime, ...(init.signal ? [init.signal] : [])];
  const stop = () => abort.abort();
  const cleanup = () => signals.forEach((signal) => signal.removeEventListener('abort', stop));
  for (const signal of signals) {
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
  }
  try {
    const response = await fetcher(input, { ...init, signal: abort.signal });
    if (!response.body) {
      cleanup();
      return response;
    }
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (abort.signal.aborted) throw new Error('Share request ended');
          if (next.done) {
            cleanup();
            controller.close();
          } else controller.enqueue(next.value);
        } catch {
          cleanup();
          controller.error(new Error('Share request ended'));
        }
      },
      async cancel() {
        abort.abort();
        cleanup();
        await reader.cancel();
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    cleanup();
    throw error;
  }
}
