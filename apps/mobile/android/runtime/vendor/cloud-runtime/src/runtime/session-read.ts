// Retry reads only. Durable writes and Machine RPC must never use this helper.
export async function retrySessionRead<T>(
  signal: AbortSignal,
  read: () => Promise<T>,
  onRetry: (error: unknown) => void,
): Promise<T> {
  let delay = 1000;
  for (;;) {
    signal.throwIfAborted();
    try {
      const result = await read();
      signal.throwIfAborted();
      return result;
    } catch (error) {
      signal.throwIfAborted();
      onRetry(error);
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', abort);
          resolve();
        }, delay);
        signal.addEventListener('abort', abort, { once: true });
      });
      delay = Math.min(delay * 2, 30000);
    }
  }
}
