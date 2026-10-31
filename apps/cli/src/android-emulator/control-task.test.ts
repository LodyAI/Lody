import { it, expect, vi } from 'vitest';
import { runAndroidControl } from './control-task';
it('revokes native ownership and joins the command when shutdown interrupts an ACK wait', async () => {
  let reject!: (reason: Error) => void;
  const native = new Promise<void>((_, r) => {
    reject = r;
  });
  let closed = false;
  const abort = new AbortController();
  const task = runAndroidControl(
    abort.signal,
    () => native,
    () => {
      closed = true;
      reject(Error('socket closed'));
    }
  );
  abort.abort();
  await expect(task).rejects.toThrow('socket closed');
  expect(closed).toBe(true);
});
it('bounds a missing native ACK by ending the owner, not abandoning the pending work', async () => {
  vi.useFakeTimers();
  try {
    let reject!: (reason: Error) => void;
    const native = new Promise<void>((_, r) => {
      reject = r;
    });
    const task = runAndroidControl(
      new AbortController().signal,
      () => native,
      () => reject(Error('deadline'))
    );
    const failed = expect(task).rejects.toThrow('deadline');
    await vi.advanceTimersByTimeAsync(10000);
    await failed;
  } finally {
    vi.useRealTimers();
  }
});
