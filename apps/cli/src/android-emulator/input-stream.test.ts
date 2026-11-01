import { afterEach, expect, it, vi } from 'vitest';
import { AndroidStream } from './input-stream';

afterEach(() => vi.useRealTimers());

it('fences an overloaded stream before error listeners try to release a touch', async () => {
  vi.useFakeTimers();
  let release = () => {};
  const stalled = new Promise<void>((resolve) => {
    release = resolve;
  });
  const delivered: string[] = [];
  let disposed = 0;
  const stream = new AndroidStream({
    open: async () => {},
    write: async (message) => {
      delivered.push(message);
      await stalled;
    },
    dispose: () => {
      disposed++;
    },
  });
  const states: number[] = [];
  const errors: string[] = [];
  stream.on('error', (error) => {
    states.push(stream.readyState);
    errors.push(error.message);
    // Like gateway shutdown: releasing a touch must not re-enter overload.
    if (errors.length === 1) stream.send('touch-up');
    stream.close();
  });
  await vi.advanceTimersByTimeAsync(0);
  const input = 'x'.repeat(32768);
  stream.send(input);
  await vi.advanceTimersByTimeAsync(0);
  stream.send(input);
  expect(stream.bufferedAmount).toBe(65536);
  stream.send('overflow');
  release();
  await vi.advanceTimersByTimeAsync(0);
  expect(errors).toEqual(['Android input queue full']);
  expect(states.every((state) => state !== 1)).toBe(true);
  expect(stream.readyState).toBe(3);
  expect(disposed).toBe(1);
  expect(delivered).toEqual([input]);
  expect(stream.bufferedAmount).toBe(0);
});

it('drains accepted touch release on ordinary close and refuses new input', async () => {
  vi.useFakeTimers();
  const delivered: string[] = [];
  let disposed = false;
  const stream = new AndroidStream({
    open: async () => {},
    write: async (message) => {
      delivered.push(message);
    },
    dispose: () => {
      disposed = true;
    },
  });
  await vi.advanceTimersByTimeAsync(0);
  stream.send('touch-down');
  stream.send('touch-up');
  stream.close();
  stream.send('late-touch');
  await vi.advanceTimersByTimeAsync(0);
  expect(delivered).toEqual(['touch-down', 'touch-up']);
  expect(disposed).toBe(true);
  expect(stream.readyState).toBe(3);
  expect(stream.bufferedAmount).toBe(0);
});
