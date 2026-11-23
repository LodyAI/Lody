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
  });
  it('allows reference number wrap and rejects mislabeled IDRs', () => {
    const { f } = flow(false);
    for (let i = 0; i < 18; i++) {
      f.offer(frame(i % 16, i === 0), i);
      expect(f.take(i)).toBeDefined();
    }
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
  it('keeps bounded byte credit without treating one slow keyframe as sustained congestion', () => {
    const { f } = flow();
    f.recordRtt(400);
    f.offer(frame(0, true, 100_000), 0);
    expect(f.take(0)).toBeDefined();
    f.offer(frame(1), 10);
    expect(f.take(100)).toBeUndefined();
    expect(f.acknowledge(1, 2500)).toBe(true);
    expect(f.targetBitrate()).toBe(600_000);
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
  it('recovers a broken chain with available credit without waiting another full RTT', () => {
    const { f, requests } = flow();
    f.recordRtt(600);
    f.offer(frame(0, true, 1000), 0);
    expect(f.take(0)?.readUInt32BE(4)).toBe(1);
    // A lost native delta invalidates the chain while the first picture is in flight.
    f.offer(frame(2), 100);
    expect(requests).toHaveLength(1);
    f.offer(frame(0, true, 1000), 110);
    const fresh = f.take(110);
    expect(fresh?.[8]).toBe(2);
    expect(fresh?.readUInt32BE(4)).toBe(2);
    expect(f.snapshot(110).inFlightFrames).toBe(2);
    expect(f.acknowledge(2, 710)).toBe(true);
    expect(f.snapshot(710).inFlightFrames).toBe(0);
  });
  it('replaces a stale pre-input backlog with a fresh keyframe without replaying deltas', () => {
    const { f, requests } = flow();
    f.recordRtt(600);
    f.offer(frame(0), 0);
    f.take(0);
    f.offer(frame(1), 40);
    f.offer(frame(2), 80);
    f.prioritizeInteraction(200);
    expect(requests).toHaveLength(1);
    f.offer(frame(3), 210);
    expect(f.take(210)).toBeUndefined();
    f.offer(frame(0), 220);
    expect(f.take(220)?.[8]).toBe(2);
    expect(f.snapshot(220)).toMatchObject({
      queuedFrames: 0,
    });
    // The new IDR still consumes ordinary receiver credit.
    expect(f.snapshot(220).inFlightFrames).toBe(2);
  });
  it('preserves fresh remote frames and local queues on interaction', () => {
    for (const remote of [false, true]) {
      const { f, requests } = flow(remote);
      f.offer(frame(0), 0);
      f.prioritizeInteraction(remote ? 100 : 500);
      expect(requests).toHaveLength(0);
      expect(f.take(500)?.[8]).toBe(2);
    }
  });
  it('preserves a replacement chain when a quick release falls inside the IDR cooldown', () => {
    const { f, requests } = flow();
    f.recordRtt(600);
    f.offer(frame(0), 0);
    f.take(0);
    f.offer(frame(1), 40);
    f.prioritizeInteraction(200);
    f.offer(frame(0), 210);
    f.take(210);
    f.offer(frame(1), 220);
    f.prioritizeInteraction(350);
    expect(f.take(350)?.[8]).toBe(3);
    expect(requests).toHaveLength(1);
  });
  it('preserves pre-input frames while pacing or receiver credit prevents replacement', () => {
    const { f, requests } = flow();
    f.offer(frame(0, true, 100_000), 0);
    f.take(0);
    f.offer(frame(1), 10);
    f.prioritizeInteraction(200);
    expect(requests).toHaveLength(0);
    expect(f.snapshot(200)).toMatchObject({ queuedFrames: 1 });
    f.acknowledge(1, 250);
    // Pacing debt still blocks optional replacement even after receiver credit arrives.
    f.prioritizeInteraction(300);
    expect(f.snapshot(300)).toMatchObject({ queuedFrames: 1 });
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
  it('does not collapse bitrate on recurring short ACK bursts with a healthy baseline', () => {
    const { f } = flow();
    f.recordRtt(350);
    const pending: Array<{ sequence: number; at: number }> = [];
    let deliveredAt = 0;
    for (let now = 0; now <= 30000; now += 10) {
      while (pending[0] && pending[0].at <= now) {
        const ack = pending.shift();
        if (ack) expect(f.acknowledge(ack.sequence, now)).toBe(true);
      }
      if (now % 50) continue;
      f.offer(frame(0, true, 1000), now);
      const packet = f.take(now);
      if (packet) {
        // Ordered delivery with a short stall every two seconds, then a burst.
        const stalled = now % 2000 >= 1500 ? 800 : 350;
        deliveredAt = Math.max(deliveredAt, now + stalled);
        pending.push({ sequence: packet.readUInt32BE(4), at: deliveredAt });
      }
    }
    expect(f.targetBitrate()).toBeGreaterThanOrEqual(600_000);
  });
  it('reduces bitrate for sustained delayed ACKs and raises it only with healthy payload demand', () => {
    const { f } = flow();
    f.recordRtt(350);
    const pending: Array<{ sequence: number; at: number }> = [];
    let low = 600_000;
    for (let now = 0; now <= 20000; now += 10) {
      while (pending[0] && pending[0].at <= now) {
        const ack = pending.shift();
        if (ack) expect(f.acknowledge(ack.sequence, now)).toBe(true);
      }
      if (now === 10000) low = f.targetBitrate();
      if (now % 50) continue;
      f.offer(frame(0, true, 3000), now);
      const packet = f.take(now);
      if (packet)
        pending.push({ sequence: packet.readUInt32BE(4), at: now + (now < 10000 ? 850 : 360) });
    }
    expect(low).toBeLessThan(600_000);
    expect(f.targetBitrate()).toBeGreaterThan(low);
    expect(f.snapshot(20000).inFlightBytes).toBeLessThanOrEqual(65536);
  });
});
