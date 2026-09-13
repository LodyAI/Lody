/** Bound I/O and wait for every started task before releasing shared resources. */
export async function mapShareConcurrent<T, R>(
  items: readonly T[],
  run: (item: T, index: number, signal: AbortSignal) => Promise<R>,
  signal?: AbortSignal
): Promise<R[]> {
  const abort = new AbortController();
  const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: unknown;
  let failed = false;
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      try {
        while (next < items.length) {
          combined.throwIfAborted();
          const index = next++;
          results[index] = await run(items[index]!, index, combined);
        }
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
        abort.abort();
      }
    })
  );
  if (failed) throw failure;
  combined.throwIfAborted();
  return results;
}
