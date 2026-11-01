import { it, expect, vi } from 'vitest';
import { runAndroidControl, setAndroidAppearance } from './control-task';
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

it('changes the device night mode in both directions and confirms the result', async () => {
  let night = 'no';
  const shell = {
    async spawnWaitText(command: readonly string[]) {
      expect(command.slice(0, 3)).toEqual(['cmd', 'uimode', 'night']);
      expect(['yes', 'no']).toContain(command[3]);
      night = command[3]!;
      return { exitCode: 0, stdout: `Night mode: ${night}\n` };
    },
  };
  await setAndroidAppearance(shell, 'dark');
  expect(night).toBe('yes');
  await setAndroidAppearance(shell, 'light');
  expect(night).toBe('no');
});
it('rejects unavailable shell control, failed commands and an unapplied mode', async () => {
  await expect(setAndroidAppearance(undefined, 'dark')).rejects.toThrow('unavailable');
  await expect(
    setAndroidAppearance({ spawnWaitText: async () => ({ exitCode: 1, stdout: '' }) }, 'dark')
  ).rejects.toThrow();
  await expect(
    setAndroidAppearance(
      { spawnWaitText: async () => ({ exitCode: 0, stdout: 'Night mode: no' }) },
      'dark'
    )
  ).rejects.toThrow();
});
