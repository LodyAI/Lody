import { describe, expect, it } from 'vitest';
import { SimulatorFrameFlow, jpegDimensions, simulatorScale } from './frame-flow';

describe('simulator receiver credit and freshness', () => {
  it('bounds unacknowledged bytes and replaces pending JPEGs while a receiver stalls', () => {
    const flow = new SimulatorFrameFlow(true, 0);
    flow.offer(Buffer.alloc(300 * 1024, 1));
    expect(flow.take(0)?.readUInt32BE(4)).toBe(1);
    for (let n = 2; n <= 20; n++) {
      flow.offer(Buffer.alloc(300 * 1024, n));
      expect(flow.take(n * 40)).toBeUndefined();
    }
    expect(flow.snapshot(800)).toMatchObject({ inFlightFrames: 1, droppedFrames: 18 });
    expect(flow.acknowledge(1000, 900)).toBe(false);
    expect(flow.take(900)).toBeUndefined();
    expect(flow.acknowledge(1, 900)).toBe(true);
    expect(flow.take(900)?.subarray(8)).toEqual(Buffer.alloc(300 * 1024, 20));
  });

  it('paces to 30 FPS and flushes the final pending frame without another source event', () => {
    const flow = new SimulatorFrameFlow(true, 0);
    flow.offer(Buffer.from([1]));
    expect(flow.take(0)?.subarray(8)).toEqual(Buffer.from([1]));
    flow.offer(Buffer.from([2]));
    expect(flow.take(10)).toBeUndefined();
    flow.offer(Buffer.from([3]));
    expect(flow.take(33)).toBeUndefined();
    expect(flow.take(34)?.subarray(8)).toEqual(Buffer.from([3]));
    expect(flow.acknowledge(2, 100)).toBe(true);
    expect(flow.acknowledge(1, 101)).toBe(true);
    expect(flow.snapshot(200)).toMatchObject({ inFlightFrames: 0, inFlightBytes: 0, ackMs: 66 });
    expect(flow.snapshot(2200)).toMatchObject({ sourceFps: 0, sentFps: 0, sentMbps: 0 });
  });

  it('pipelines across RTT instead of stop-and-wait, with a hard frame cap and age budget', () => {
    const flow = new SimulatorFrameFlow(true, 0);
    flow.recordRtt(200);
    for (let i = 0; i < 8; i++) {
      flow.offer(Buffer.from([i]));
      expect(flow.take(i * 34)?.readUInt32BE(4)).toBe(i + 1);
    }
    flow.offer(Buffer.from([9]));
    expect(flow.take(300)).toBeUndefined();
    flow.acknowledge(1, 700);
    expect(flow.take(750)).toBeUndefined(); // oldest frame is too old, even with a credit
    flow.acknowledge(8, 800);
    expect(flow.take(800)?.subarray(8)).toEqual(Buffer.from([9]));
  });

  it('allows one oversized JPEG but cannot accumulate another', () => {
    const flow = new SimulatorFrameFlow(true, 0);
    flow.offer(Buffer.alloc(1024 * 1024));
    expect(flow.take(0)).toBeDefined();
    flow.offer(Buffer.alloc(1024 * 1024));
    expect(flow.take(100)).toBeUndefined();
    expect(flow.snapshot(100)).toMatchObject({ inFlightFrames: 1, inFlightBytes: 1024 * 1024 });
  });
});

describe('remote JPEG resolution', () => {
  it('reads a bounded SOF and rejects truncated or impossible geometry', () => {
    const jpeg = Buffer.from([255, 216, 255, 192, 0, 11, 8, 9, 252, 4, 155, 1, 1, 17, 0]);
    expect(jpegDimensions(jpeg)).toEqual({ width: 1179, height: 2556 });
    expect(jpegDimensions(jpeg.subarray(0, 10))).toBeUndefined();
    jpeg.writeUInt16BE(65535, 7);
    expect(jpegDimensions(jpeg)).toBeUndefined();
  });
  it('uses bounded DPR and integer scale, preserves local pixels and rotation-independent fit', () => {
    const native = { width: 1200, height: 2600 };
    expect(simulatorScale(native, { width: 300, height: 650, dpr: 2 }, true)).toBe(2);
    expect(
      simulatorScale({ width: 1180, height: 2556 }, { width: 360, height: 780, dpr: 2 }, true)
    ).toBe(2);
    expect(simulatorScale(native, { width: 650, height: 300, dpr: 2 }, true)).toBe(2);
    expect(simulatorScale(native, { width: 300, height: 650, dpr: 2 }, false)).toBe(1);
    expect(simulatorScale(native, { width: 1200, height: 2600, dpr: 2 }, true)).toBe(1);
  });
});
