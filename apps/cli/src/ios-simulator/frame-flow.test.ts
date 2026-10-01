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
    expect(flow.take(2500)?.subarray(8)).toEqual(Buffer.alloc(300 * 1024, 20));
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

  it('uses fast first-frame feedback without retaining the conservative startup wait', () => {
    const flow = new SimulatorFrameFlow(true, 0);
    flow.recordRtt(30);
    flow.offer(Buffer.alloc(200000));
    flow.take(0);
    flow.acknowledge(1, 60);
    flow.offer(Buffer.alloc(50000));
    expect(flow.take(70)?.readUInt32BE(4)).toBe(2);
  });

  it('does not enlarge the queue when congested probes inflate RTT', () => {
    const flow = new SimulatorFrameFlow(true, 0);
    flow.recordRtt(400);
    const initial = flow.snapshot(0).windowBytes;
    flow.recordRtt(4500);
    expect(flow.snapshot(1)).toMatchObject({ rttMs: 4500, baseRttMs: 400, windowBytes: initial });
  });

  it('paces a synthetic 1 Mbps path, lowers resolution and drains the final frame', () => {
    const flow = new SimulatorFrameFlow(true, 0);
    flow.recordRtt(400);
    let scale = 2,
      wireFreeAt = 0,
      lastAcked = 0,
      lastSent = 0;
    const arrivals: Array<{ at: number; sequence: number; latency: number }> = [];
    const steadyLatencies: number[] = [];
    // A FIFO bottleneck plus 400 ms propagation/return/draw, driven by an injected
    // clock. Scale changes affect future JPEG sizes, as in the native encoder.
    for (let now = 0; now <= 32000; now += 10) {
      while (arrivals[0] && arrivals[0].at <= now) {
        const ack = arrivals.shift();
        if (!ack) throw new Error('missing scheduled ACK');
        expect(flow.acknowledge(ack.sequence, now)).toBe(true);
        lastAcked = ack.sequence;
        if (now >= 20000 && now < 30000) steadyLatencies.push(ack.latency);
      }
      if (now % 2000 === 0) flow.recordRtt(400 + Math.max(0, wireFreeAt - now));
      if (now % 1000 === 0) scale = flow.recommendedScale(2, scale);
      if (now < 30000 && now % 40 === 0) flow.offer(Buffer.alloc(Math.ceil(300000 / scale ** 2)));
      const packet = flow.take(now);
      if (packet) {
        lastSent = packet.readUInt32BE(4);
        wireFreeAt = Math.max(wireFreeAt, now) + (packet.length / 125000) * 1000;
        arrivals.push({
          at: wireFreeAt + 400,
          sequence: lastSent,
          latency: wireFreeAt + 400 - now,
        });
      }
    }
    expect(scale).toBe(4);
    expect(steadyLatencies.length).toBeGreaterThanOrEqual(30); // >=3 painted FPS
    expect(Math.max(...steadyLatencies)).toBeLessThan(1000);
    expect(lastAcked).toBe(lastSent);
    expect(flow.snapshot(32000).inFlightFrames).toBe(0);
  });

  it('excludes idle time from delivery estimates and preserves local full resolution', () => {
    const flow = new SimulatorFrameFlow(true, 0);
    flow.recordRtt(100);
    flow.offer(Buffer.alloc(50000));
    flow.take(0);
    flow.acknowledge(1, 200);
    const before = flow.snapshot(200).deliveryMbps;
    flow.offer(Buffer.alloc(50000));
    flow.take(60000);
    flow.acknowledge(2, 60200);
    expect(flow.snapshot(60200).deliveryMbps).toBe(before);
    expect(flow.recommendedScale(2, 2)).toBe(2);
    const local = new SimulatorFrameFlow(false, 0);
    local.offer(Buffer.alloc(50000));
    local.take(0);
    local.acknowledge(1, 5000);
    expect(local.recommendedScale(1, 1)).toBe(1);
  });

  it('recovers viewport quality after payload completion gets faster', () => {
    const flow = new SimulatorFrameFlow(true, 0);
    flow.recordRtt(400);
    flow.offer(Buffer.alloc(75000));
    flow.take(0);
    flow.acknowledge(1, 1400);
    expect(flow.recommendedScale(2, 2)).toBe(4);
    for (let sequence = 2; sequence < 30; sequence++) {
      const at = sequence * 2000;
      flow.offer(Buffer.alloc(19000));
      expect(flow.take(at)).toBeDefined();
      flow.acknowledge(sequence, at + 410);
    }
    expect(flow.recommendedScale(2, 4)).toBe(2);
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
