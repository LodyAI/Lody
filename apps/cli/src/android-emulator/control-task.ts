/** Cancellation ends the native owner before joining its pending command. */
export async function runAndroidControl(
  signal: AbortSignal,
  execute: () => Promise<void>,
  revoke: () => void
): Promise<void> {
  signal.throwIfAborted();
  const deadline = new AbortController();
  const effective = AbortSignal.any([signal, deadline.signal]);
  const timeout = setTimeout(() => deadline.abort(Error('Android control timed out')), 10_000);
  effective.addEventListener('abort', revoke, { once: true });
  try {
    await execute();
    effective.throwIfAborted();
  } finally {
    clearTimeout(timeout);
    effective.removeEventListener('abort', revoke);
  }
}
