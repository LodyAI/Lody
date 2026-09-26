import {
  createMarkdownHighlightClient,
  type MarkdownHighlightClient,
  type MarkdownHighlightWorkerLike,
} from './markdown-highlight-client';

let client: MarkdownHighlightClient | null | undefined;

/**
 * The shared markdown highlight worker, created on first use. Null where
 * workers are unavailable (tests, server rendering) or after the worker failed;
 * callers then highlight on the main thread.
 */
export function getMarkdownHighlightWorker(): MarkdownHighlightClient | null {
  if (client === undefined) {
    client = null;
    if (typeof Worker !== 'undefined') {
      try {
        client = createMarkdownHighlightClient(
          () =>
            new Worker(new URL('./markdown-highlight.worker.ts', import.meta.url), {
              type: 'module',
            }) as unknown as MarkdownHighlightWorkerLike
        );
      } catch {
        client = null;
      }
    }
  }
  return client?.usable ? client : null;
}
