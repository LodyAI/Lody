import { afterEach, expect, it, vi } from 'vitest';
import { createAndroidViewerIdleTimeout, androidEncoderOptions } from './preview-policy';
afterEach(() => vi.useRealTimers());
it('releases unattended previews, cancels expiry for viewers, and restarts grace after the last viewer leaves', async () => {
  vi.useFakeTimers();
  let ended = false;
  const idle = createAndroidViewerIdleTimeout(() => {
    ended = true;
  });
  await vi.advanceTimersByTimeAsync(29_000);
  expect(ended).toBe(false);
  const leaveA = idle.attach();
  const leaveB = idle.attach();
  await vi.advanceTimersByTimeAsync(60_000);
  leaveA();
  leaveA();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(ended).toBe(false);
  leaveB();
  await vi.advanceTimersByTimeAsync(29_000);
  expect(ended).toBe(false);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(ended).toBe(true);
  idle.dispose();
});
it('disposes the idle timer and expires a preview that never gains a viewer', async () => {
  vi.useFakeTimers();
  let ended = false;
  const disposed = createAndroidViewerIdleTimeout(() => {
    throw Error('disposed timer fired');
  });
  disposed.dispose();
  const idle = createAndroidViewerIdleTimeout(() => {
    ended = true;
  });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(ended).toBe(true);
  idle.dispose();
});
it('bounds each quality tier and defaults to balanced', () => {
  expect(androidEncoderOptions()).toEqual({ videoBitRate: 600_000, maxSize: 960, maxFps: 24 });
  expect(androidEncoderOptions('saver')).toEqual({
    videoBitRate: 300_000,
    maxSize: 640,
    maxFps: 15,
  });
  expect(androidEncoderOptions('clear')).toEqual({
    videoBitRate: 1_000_000,
    maxSize: 1280,
    maxFps: 30,
  });
});
