import { describe, expect, it } from 'vitest';
import { SimulatorFrameFlow } from './frame-flow';
import { SimulatorIdleRefresh, readSimulatorStill } from './idle-refresh';
const jpeg = Buffer.from([255, 216, 255, 192, 0, 11, 8, 9, 252, 4, 155, 1, 1, 17, 0]);

function harness() {
  const captures: Array<{ scale: number; signal: AbortSignal; resolve: (frame: Buffer) => void }> =
    [];
  const flow = new SimulatorFrameFlow(true, 0);
  const idle = new SimulatorIdleRefresh(
    (scale, signal) => new Promise((resolve) => captures.push({ scale, signal, resolve })),
    (frame) => flow.offer(frame, true),
    () => flow.discardStill()
  );
  return { idle, captures, flow };
}

// Flush the capture promise, catch and finally without timers or real networking.
async function settled() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('quiet simulator quality refresh', () => {
  it('waits for a drained quiet screen, then sends one still without looping', async () => {
    const { idle, captures, flow } = harness();
    idle.activity(100);
    idle.tick(2000, 2, true);
    idle.tick(3000, 2, false);
    expect(captures).toHaveLength(0);
    idle.tick(3100, 2, true);
    expect(captures[0]?.scale).toBe(2);
    captures[0]?.resolve(jpeg);
    await settled();
    expect(flow.take(3200)?.subarray(8)).toEqual(jpeg);
    flow.acknowledge(1, 3500);
    idle.tick(60000, 2, true);
    expect(captures).toHaveLength(1);
    expect(flow.snapshot(60000).idleRefreshFrames).toBe(1);
    await idle.close();
  });

  it('discards in-progress and queued stills when fresh frames or input arrive', async () => {
    const { idle, captures, flow } = harness();
    idle.activity(0);
    idle.tick(2000, 2, true);
    idle.activity(2100);
    expect(captures[0]?.signal.aborted).toBe(true);
    captures[0]?.resolve(jpeg);
    await settled();
    expect(flow.take(2200)).toBeUndefined();
    idle.tick(4100, 2, true);
    captures[1]?.resolve(jpeg);
    await settled();
    idle.activity(4200);
    expect(flow.take(4200)).toBeUndefined();
    await idle.close();
  });

  it('joins a cancelled read and never publishes after close', async () => {
    const { idle, captures, flow } = harness();
    idle.activity(0);
    idle.tick(2000, 2, true);
    const closed = idle.close();
    expect(captures[0]?.signal.aborted).toBe(true);
    captures[0]?.resolve(jpeg);
    await closed;
    expect(flow.take(3000)).toBeUndefined();
    idle.tick(4000, 2, true);
    expect(captures).toHaveLength(1);
  });

  it('reads only a bounded fixed JPEG route and fences revoked results', async () => {
    let active = true;
    const options = {
      port: 1234,
      udid: 'test-device',
      scale: 2,
      signal: new AbortController().signal,
      active: () => active,
    };
    const frame = await readSimulatorStill({
      ...options,
      fetch: async (url, init) => {
        expect(String(url)).toBe(
          'http://127.0.0.1:1234/simulators/test-device/screenshot.jpg?scale=2&quality=0.85'
        );
        expect(init?.redirect).toBe('error');
        return new Response(jpeg);
      },
    });
    expect(frame).toEqual(jpeg);
    await expect(
      readSimulatorStill({
        ...options,
        fetch: async () => new Response(Buffer.alloc(512 * 1024 + 1)),
      })
    ).rejects.toThrow('too large');
    await expect(
      readSimulatorStill({
        ...options,
        fetch: async () => {
          active = false;
          return new Response(jpeg);
        },
      })
    ).rejects.toThrow('unavailable');
  });
});
