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

/** Only fixed UI-mode commands may cross the private preview control boundary. */
export async function setAndroidAppearance(
  shell:
    | { spawnWaitText(command: readonly string[]): Promise<{ exitCode: number; stdout: string }> }
    | undefined,
  appearance: 'light' | 'dark'
): Promise<void> {
  if (!shell) throw Error('Android appearance control is unavailable');
  const mode = appearance === 'dark' ? 'yes' : 'no';
  const result = await shell.spawnWaitText(['cmd', 'uimode', 'night', mode]);
  if (result.exitCode !== 0 || result.stdout.trim() !== `Night mode: ${mode}`) {
    throw Error('Android appearance change failed');
  }
}
