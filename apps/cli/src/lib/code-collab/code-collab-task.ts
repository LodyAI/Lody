/** A deadline ends this refresh attempt, not the shared Repo or its live rooms. */
export class CodeCollabTaskTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Code Collab task exceeded ${timeoutMs}ms`);
    this.name = 'CodeCollabTaskTimeoutError';
  }
}

/** Observe late settlement even when an uncancellable SDK/storage read outlives its waiter. */
export async function waitForCodeCollabTask<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return await work;
  let abort = () => {};
  try {
    return await new Promise<T>((resolve, reject) => {
      work.then(resolve, reject);
      abort = () => reject(signal.reason);
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

export async function runCodeCollabTask<T>(
  timeoutMs: number,
  ownerSignal: AbortSignal,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const deadline = new AbortController();
  const signal = AbortSignal.any([ownerSignal, deadline.signal]);
  const timer = setTimeout(
    () => deadline.abort(new CodeCollabTaskTimeoutError(timeoutMs)),
    timeoutMs
  );
  timer.unref?.();
  try {
    signal.throwIfAborted();
    return await waitForCodeCollabTask(run(signal), signal);
  } catch (error) {
    deadline.abort(error);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
