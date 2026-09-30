import type { MarkdownTokens } from './markdown-highlighter';

export type MarkdownHighlightRequest = { id: number; code: string; language: string };
export type MarkdownHighlightResponse =
  | { id: number; tokens: MarkdownTokens }
  | { id: number; error: string };

/** The subset of `Worker` the client uses, so tests can pass a fake. */
export type MarkdownHighlightWorkerLike = {
  postMessage(message: MarkdownHighlightRequest): void;
  onmessage: ((event: MessageEvent<MarkdownHighlightResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  terminate(): void;
};

export type MarkdownHighlightClient = {
  /** Tokens for `code`; identical in-flight requests share one worker round trip. */
  highlight(code: string, language: string): Promise<MarkdownTokens>;
  /** False once the worker failed; callers then highlight on the main thread. */
  readonly usable: boolean;
  dispose(): void;
};

/**
 * Main-thread side of the markdown highlight worker. A worker crash rejects
 * every pending request and marks the client unusable instead of retrying:
 * the caller falls back to its main-thread highlighter for later blocks.
 */
export function createMarkdownHighlightClient(
  createWorker: () => MarkdownHighlightWorkerLike
): MarkdownHighlightClient {
  const worker = createWorker();
  let nextId = 1;
  let usable = true;
  const pending = new Map<
    number,
    { key: string; resolve: (tokens: MarkdownTokens) => void; reject: (error: Error) => void }
  >();
  const inFlight = new Map<string, Promise<MarkdownTokens>>();

  const failAll = (error: Error) => {
    usable = false;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    inFlight.clear();
  };

  worker.onmessage = (event) => {
    const response = event.data;
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    inFlight.delete(request.key);
    if ('error' in response) request.reject(new Error(response.error));
    else request.resolve(response.tokens);
  };
  worker.onerror = (event) => {
    failAll(new Error(event.message || 'Markdown highlight worker failed'));
  };

  return {
    get usable() {
      return usable;
    },
    highlight(code, language) {
      if (!usable) return Promise.reject(new Error('Markdown highlight worker is unavailable'));
      const key = `${language}\0${code}`;
      const existing = inFlight.get(key);
      if (existing) return existing;
      const id = nextId++;
      const promise = new Promise<MarkdownTokens>((resolve, reject) => {
        pending.set(id, { key, resolve, reject });
      });
      inFlight.set(key, promise);
      worker.postMessage({ id, code, language });
      return promise;
    },
    dispose() {
      failAll(new Error('Markdown highlight worker disposed'));
      worker.terminate();
    },
  };
}
