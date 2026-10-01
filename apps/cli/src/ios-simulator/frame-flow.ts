/** A private media protocol, owned by the fixed gateway/viewer pair, not Machine RPC.
 * JPEG packets: big-endian uint32 magic `LODY`, uint32 sequence, then JPEG bytes.
 * A cumulative ACK means painted OR deliberately superseded by a newer painted frame.
 */
export const SIMULATOR_FRAME_MAGIC = 0x4c4f4459;

export class SimulatorFrameFlow {
  private pending?: Buffer;
  private sequence = 0;
  private acknowledged = 0;
  private lastSent = -Infinity;
  private inFlight = new Map<number, { bytes: number; at: number }>();
  private rttMs = 100;
  private measuredRtt = false;
  private ackMs = 0;
  private lastAck = 0;
  private received = 0;
  private receivedBytes = 0;
  private sent = 0;
  private sentBytes = 0;
  private dropped = 0;
  private sample = { at: 0, received: 0, receivedBytes: 0, sent: 0, sentBytes: 0 };
  readonly targetFps: number;

  constructor(
    private readonly remote: boolean,
    now: number
  ) {
    this.sample.at = now;
    this.targetFps = remote ? 30 : 60;
  }

  offer(frame: Buffer) {
    this.received++;
    this.receivedBytes += frame.length;
    if (this.pending) this.dropped++;
    this.pending = frame;
  }

  /** One frame may exceed the byte budget, but never alongside another frame. */
  take(now: number): Buffer | undefined {
    const frame = this.pending;
    if (!frame || now - this.lastSent < 1000 / this.targetFps) return undefined;
    const bytes = this.inFlightBytes();
    const window = Math.min(8, Math.max(2, Math.ceil((this.rttMs * this.targetFps) / 1000) + 2));
    const budget = this.remote ? 512 * 1024 : 2 * 1024 * 1024;
    if (this.inFlight.size >= window || (bytes > 0 && bytes + frame.length > budget))
      return undefined;
    if (this.oldestAge(now) > Math.max(500, this.rttMs * 3)) return undefined;
    // An operation cannot realistically send 2^32 frames. Fail closed at wrap.
    if (this.sequence === 0xffffffff) return undefined;
    const sequence = ++this.sequence;
    const packet = Buffer.allocUnsafe(8 + frame.length);
    packet.writeUInt32BE(SIMULATOR_FRAME_MAGIC, 0);
    packet.writeUInt32BE(sequence, 4);
    frame.copy(packet, 8);
    this.pending = undefined;
    this.inFlight.set(sequence, { bytes: frame.length, at: now });
    this.lastSent = now;
    this.sent++;
    this.sentBytes += packet.length;
    return packet;
  }

  acknowledge(sequence: number, now: number): boolean {
    if (sequence <= this.acknowledged) return true; // delayed duplicate
    const frame = this.inFlight.get(sequence);
    if (!frame) return false; // never grant credit for a frame we did not send
    this.ackMs = Math.max(0, now - frame.at);
    this.lastAck = now;
    this.acknowledged = sequence;
    for (const id of this.inFlight.keys()) if (id <= sequence) this.inFlight.delete(id);
    return true;
  }

  recordRtt(ms: number) {
    this.measuredRtt = true;
    this.rttMs = Math.max(1, Math.min(10000, ms));
  }

  private inFlightBytes() {
    let bytes = 0;
    for (const frame of this.inFlight.values()) bytes += frame.bytes;
    return bytes;
  }

  oldestAge(now: number) {
    const first = this.inFlight.values().next().value;
    return first ? Math.max(0, now - first.at) : 0;
  }

  snapshot(now: number) {
    const seconds = Math.max(0.001, (now - this.sample.at) / 1000);
    const result = {
      sourceFps: (this.received - this.sample.received) / seconds,
      sentFps: (this.sent - this.sample.sent) / seconds,
      sourceMbps: ((this.receivedBytes - this.sample.receivedBytes) * 8) / seconds / 1e6,
      sentMbps: ((this.sentBytes - this.sample.sentBytes) * 8) / seconds / 1e6,
      sentFrames: this.sent,
      droppedFrames: this.dropped,
      inFlightFrames: this.inFlight.size,
      inFlightBytes: this.inFlightBytes(),
      oldestFrameMs: this.oldestAge(now),
      ackMs: this.ackMs,
      ackIdleMs: this.lastAck ? now - this.lastAck : 0,
      rttMs: this.measuredRtt ? this.rttMs : 0,
      targetFps: this.targetFps,
    };
    this.sample = {
      at: now,
      received: this.received,
      receivedBytes: this.receivedBytes,
      sent: this.sent,
      sentBytes: this.sentBytes,
    };
    return result;
  }
}

/** Read SOF dimensions without decoding or allocating another full frame. */
export function jpegDimensions(data: Buffer): { width: number; height: number } | undefined {
  if (data.length < 4 || data.readUInt16BE(0) !== 0xffd8) return undefined;
  let offset = 2;
  while (offset + 4 <= data.length) {
    if (data[offset] !== 0xff) return undefined;
    const marker = data[offset + 1];
    if (marker === 0xff) {
      offset++;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return undefined;
    const length = data.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > data.length) return undefined;
    if (marker !== undefined && [0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
      const height = data.readUInt16BE(offset + 5),
        width = data.readUInt16BE(offset + 7);
      if (width > 0 && height > 0 && width <= 16384 && height <= 16384) return { width, height };
      return undefined;
    }
    offset += 2 + length;
  }
  return undefined;
}

/** Integer downsampling supported by the pinned runtime; never upscale. */
export function simulatorScale(
  native: { width: number; height: number },
  viewport: {
    width: number;
    height: number;
    dpr: number;
  },
  remote: boolean
): number {
  if (!remote) return 1;
  // Compare sorted edges so rotating the exterior cannot request the wrong shape.
  const nativeLong = Math.max(native.width, native.height),
    nativeShort = Math.min(native.width, native.height);
  const long = Math.max(viewport.width, viewport.height),
    short = Math.min(viewport.width, viewport.height);
  const ratio = Math.min(nativeLong / (long * viewport.dpr), nativeShort / (short * viewport.dpr));
  return Math.min(4, Math.max(1, Math.round(ratio)));
}
