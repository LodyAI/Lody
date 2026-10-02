/** A private media protocol, owned by the fixed gateway/viewer pair, not Machine RPC.
 * JPEG packets: big-endian uint32 magic `LODY`, uint32 sequence, then JPEG bytes.
 * A cumulative ACK means painted OR deliberately superseded by a newer painted frame.
 */
export const SIMULATOR_FRAME_MAGIC = 0x4c4f4459;

export class SimulatorFrameFlow {
  private pending?: Buffer;
  private pendingStill = false;
  private sequence = 0;
  private acknowledged = 0;
  private lastSent = -Infinity;
  private inFlight = new Map<number, { bytes: number; at: number }>();
  private rttMs = 100;
  private measuredRtt = false;
  private baseRttMs = 400;
  private deliveryBytesPerSecond = 0;
  private lastSentBytes = 0;
  private latestFrameBytes = 0;
  readonly targetFps: number;

  constructor(private readonly remote: boolean) {
    this.targetFps = remote ? 30 : 60;
  }

  offer(frame: Buffer, still = false) {
    this.latestFrameBytes = frame.length;
    this.pending = frame;
    this.pendingStill = still;
  }

  drained() {
    return this.inFlight.size === 0 && !this.pending;
  }

  discardStill() {
    if (!this.pendingStill || !this.pending) return;
    this.pending = undefined;
    this.pendingStill = false;
  }

  /** One frame may exceed the byte budget, but never alongside another frame. */
  take(now: number): Buffer | undefined {
    const frame = this.pending;
    const interval = this.remote
      ? Math.max(1000 / this.targetFps, (this.lastSentBytes / this.sendRate()) * 1000)
      : 1000 / this.targetFps;
    if (!frame || now - this.lastSent < interval) return undefined;
    const bytes = this.inFlightBytes();
    const window = Math.min(
      8,
      Math.max(2, Math.ceil((this.baseRttMs * this.targetFps) / 1000) + 2)
    );
    const budget = this.byteBudget();
    if (this.inFlight.size >= window || (bytes > 0 && bytes + frame.length > budget))
      return undefined;
    if (this.oldestAge(now) > Math.max(500, this.baseRttMs + 300)) return undefined;
    // An operation cannot realistically send 2^32 frames. Fail closed at wrap.
    if (this.sequence === 0xffffffff) return undefined;
    const sequence = ++this.sequence;
    const packet = Buffer.allocUnsafe(8 + frame.length);
    packet.writeUInt32BE(SIMULATOR_FRAME_MAGIC, 0);
    packet.writeUInt32BE(sequence, 4);
    frame.copy(packet, 8);
    this.pending = undefined;
    this.pendingStill = false;
    this.inFlight.set(sequence, { bytes: frame.length, at: now });
    this.lastSent = now;
    // No saved-up tokens: idle time must not buy a burst of stale frames.
    this.lastSentBytes = packet.length;
    return packet;
  }

  acknowledge(sequence: number, now: number): boolean {
    if (sequence <= this.acknowledged) return true; // delayed duplicate
    const frame = this.inFlight.get(sequence);
    if (!frame) return false; // never grant credit for a frame we did not send
    // Estimate usable payload rate from this frame's completion time minus the
    // minimum measured propagation RTT. ACK spacing alone is application-limited
    // by our own pacer: multiplying that rate by headroom repeatedly would collapse
    // throughput even on an uncongested link. Queue/decode delay stays conservative.
    const elapsed = now - frame.at - (this.measuredRtt ? this.baseRttMs : 0);
    const rate = Math.min(
      8 * 1024 * 1024,
      Math.max(8 * 1024, (frame.bytes * 1000) / Math.max(10, elapsed))
    );
    this.deliveryBytesPerSecond =
      this.deliveryBytesPerSecond === 0
        ? rate
        : Math.min(
            this.deliveryBytesPerSecond * 1.2,
            this.deliveryBytesPerSecond * 0.5 + rate * 0.5
          );
    this.acknowledged = sequence;
    for (const id of this.inFlight.keys()) if (id <= sequence) this.inFlight.delete(id);
    return true;
  }

  recordRtt(ms: number) {
    this.rttMs = Math.max(1, Math.min(10000, ms));
    this.baseRttMs = this.measuredRtt ? Math.min(this.baseRttMs, this.rttMs) : this.rttMs;
    this.measuredRtt = true;
  }

  private sendRate() {
    return this.deliveryBytesPerSecond ? this.deliveryBytesPerSecond * 0.85 : 128 * 1024;
  }

  private byteBudget() {
    if (!this.remote) return 2 * 1024 * 1024;
    // At most one base RTT plus 150 ms of estimated delivery. The hard cap also
    // protects startup and ACK compression; an oversized frame travels alone.
    return Math.min(
      128 * 1024,
      Math.max(8 * 1024, (this.sendRate() * (Math.min(1000, this.baseRttMs) + 150)) / 1000)
    );
  }

  /** Trade remote sharpness for ~8 delivered FPS; native scale is bounded to 1..4.
   * Use the SOF-observed scale, not a reconfiguration still in flight upstream.
   */
  recommendedScale(viewportScale: number, observedScale: number) {
    if (!this.remote || !this.deliveryBytesPerSecond) return viewportScale;
    const targetBytes = this.sendRate() / 8;
    return Math.min(
      4,
      Math.max(
        viewportScale,
        Math.ceil(observedScale * Math.sqrt(this.latestFrameBytes / targetBytes))
      )
    );
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
    const result = {
      inFlightFrames: this.inFlight.size,
      inFlightBytes: this.inFlightBytes(),
      oldestFrameMs: this.oldestAge(now),
      rttMs: this.measuredRtt ? this.rttMs : 0,
      targetFps: this.targetFps,
      baseRttMs: this.measuredRtt ? this.baseRttMs : 0,
      deliveryMbps: (this.deliveryBytesPerSecond * 8) / 1e6,
      pacingMbps: this.remote ? (this.sendRate() * 8) / 1e6 : 0,
      windowBytes: this.byteBudget(),
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
