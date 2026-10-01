import { describe, expect, it } from 'vitest';
import { SimulatorH264Flow, SIMULATOR_AVC_MAGIC } from './h264-flow';
import { avcFrameInfo, parseAvcDescription } from './h264-codec';

import { description, frame } from './h264.test-fixtures';
function flow(remote = true) {
  const requests: number[] = [];
  const f = new SimulatorH264Flow(remote, 0, () => requests.push(1));
  f.offer(Buffer.concat([Buffer.from([1]), description]), 0);
  return { f, requests };
}
describe('AVC private stream', () => {
  it('validates SPS/PPS, rejects truncated lengths, and reads native reference numbers', () => {
    const config = parseAvcDescription(description);
    // VideoToolbox SPS/PPS use nal_ref_idc=1, not always 3. No screen pixels.
    expect(
      parseAvcDescription(
        Buffer.from(
          '01640033ffe1001627640033ac13141001280507bb9a81010103c201084201000428ee3cb0',
          'hex'
        )
      ).frameBits
    ).toBeGreaterThanOrEqual(4);
    expect(config).toMatchObject({ frameBits: 4, ppsId: 0 });
    expect(avcFrameInfo(frame(7).subarray(1), config)).toEqual({
      key: false,
      reference: true,
      frameNum: 7,
    });
    expect(() => parseAvcDescription(description.subarray(0, 10))).toThrow();
    expect(() => avcFrameInfo(Buffer.from([0, 0, 1, 0, 0x41]), config)).toThrow();
    expect(() => avcFrameInfo(frame(2, true).subarray(1), config)).toThrow();
  });
  it('preserves dependent packets in order and pipelines beyond one RTT without JPEG replacement', () => {
    const { f } = flow();
    f.recordRtt(500);
    for (let i = 0; i < 16; i++) f.offer(frame(i), i);
    const packets: Buffer[] = [];
    for (let i = 0; i < 16; i++) {
      const p = f.take(20 + i * 2);
      if (p) packets.push(p);
    }
    expect(packets).toHaveLength(16);
    expect(packets[0]?.readUInt32BE(0)).toBe(SIMULATOR_AVC_MAGIC);
    expect(packets.map((p) => p.readUInt32BE(4))).toEqual(
      Array.from({ length: 16 }, (_, i) => i + 1)
    );
    expect(packets[0]?.subarray(11, 11 + description.length)).toEqual(description);
    expect(packets[1]?.readUInt16BE(9)).toBe(0);
    expect(f.acknowledge(17, 550)).toBe(false);
    expect(f.acknowledge(16, 550)).toBe(true);
    expect(f.snapshot(550).inFlightFrames).toBe(0);
  });
  it('discards the whole affected chain after native frame loss, then recovers on IDR', () => {
    const { f, requests } = flow();
    f.offer(frame(0), 0);
    f.take(0);
    f.acknowledge(1, 5);
    f.offer(frame(2), 10);
    f.offer(frame(3), 20);
    expect(f.take(100)).toBeUndefined();
    expect(requests).toHaveLength(1);
    f.offer(frame(0), 150);
    f.offer(frame(1), 160);
    expect(f.take(170)?.[8]).toBe(2);
    expect(f.take(180)?.[8]).toBe(3);
    expect(f.snapshot(200).upstreamGaps).toBe(1);
  });
  it('allows reference number wrap and rejects mislabeled IDRs', () => {
    const { f } = flow(false);
    for (let i = 0; i < 18; i++) {
      f.offer(frame(i % 16, i === 0), i);
      expect(f.take(i)).toBeDefined();
    }
    expect(f.snapshot(20).upstreamGaps).toBe(0);
    const wrong = frame(1);
    wrong[0] = 2;
    expect(() => f.offer(wrong, 21)).toThrow();
  });
  it('bounds stale unsent chains, rate limits key requests and needs a fresh IDR', () => {
    const { f, requests } = flow();
    f.offer(frame(0), 0);
    f.offer(frame(1), 1);
    expect(f.take(1300)).toBeUndefined();
    for (let i = 0; i < 10; i++) f.recover(1301 + i);
    expect(requests).toHaveLength(1);
    expect(f.snapshot(1320).queuedFrames).toBe(0);
    f.offer(frame(2), 1330);
    expect(f.take(1331)).toBeUndefined();
    f.offer(frame(0), 1340);
    expect(f.take(1340)?.[8]).toBe(2);
  });
  it('keeps bounded byte credit and reduces encoder bitrate on sustained queue delay', () => {
    const { f } = flow();
    f.recordRtt(400);
    f.offer(frame(0, true, 100_000), 0);
    expect(f.take(0)).toBeDefined();
    f.offer(frame(1), 10);
    expect(f.take(100)).toBeUndefined();
    expect(f.acknowledge(1, 2500)).toBe(true);
    expect(f.targetBitrate()).toBe(450_000);
    f.recordRtt(4000);
    expect(f.snapshot(2500).windowBytes).toBe(64 * 1024);
    f.offer(frame(0), 2600);
    expect(f.take(2600)).toBeDefined();
  });
  it('does not request repeated IDRs while a large prior picture still occupies the link', () => {
    const { f, requests } = flow();
    f.offer(frame(0, true, 100_000), 0);
    f.take(0);
    f.recover(1200);
    f.recover(2200);
    expect(requests).toHaveLength(0);
    f.acknowledge(1, 2300);
    f.take(2300);
    expect(requests).toHaveLength(1);
    expect(f.take(2400)).toBeUndefined();
    f.offer(frame(0), 2500);
    expect(f.take(2500)?.[8]).toBe(2);
  });
  it('does not mistake tiny idle deltas for spare link capacity', () => {
    const { f } = flow();
    f.recordRtt(500);
    for (let i = 0; i < 12; i++) {
      f.offer(frame(0), i * 1000);
      const packet = f.take(i * 1000);
      if (!packet) throw Error('packet');
      f.acknowledge(packet.readUInt32BE(4), i * 1000 + 510);
    }
    expect(f.targetBitrate()).toBe(600_000);
  });
});
