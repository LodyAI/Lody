import { avcFrameInfo, parseAvcDescription, type AvcDescription } from './h264-codec';

/** Private packet: LAVC uint32, sequence uint32, key=2/delta=3 uint8,
 * avcC length uint16 (key only), avcC bytes, then length-prefixed NAL units.
 * Unlike JPEG, encoded deltas MUST remain ordered. Only decoded pictures may be
 * superseded. Breaking any unsent chain discards it through the next IDR.
 */
export const SIMULATOR_AVC_MAGIC = 0x4c415643;
export class SimulatorH264Flow {
  readonly targetFps = 60;
  private description?: AvcDescription;
  private reference?: number;
  private waiting = true;
  private queue: Array<{ payload: Buffer; key: boolean; at: number }> = [];
  private queuedBytes = 0;
  private inFlight = new Map<number, { bytes: number; at: number }>();
  private sequence = 0;
  private acknowledged = 0;
  private baseRtt = 400;
  private rtt = 0;
  private lastAck = 0;
  private nextSend = 0;
  private lastTune = 0;
  private feedbackAt: number | undefined;
  private feedbackCount = 0;
  private slowFeedback = 0;
  private feedbackBytes = 0;
  private minFeedback = Infinity;
  private lastRecovery = -Infinity;
  private bitrate: number;
  constructor(
    private readonly remote: boolean,
    now: number,
    private readonly requestKeyframe: () => void
  ) {
    this.bitrate = remote ? 600_000 : 4_000_000;
    this.lastTune = now;
  }
  private reset() {
    this.queue = [];
    this.queuedBytes = 0;
    this.waiting = true;
  }
  recover(now: number) {
    this.reset();
    // A bad viewer or overloaded source cannot turn recovery into an IDR flood.
    // An IDR can follow older in-flight pictures on the ordered stream. Waiting
    // for every ACK adds a whole return trip even when there is usable credit.
    if (this.canRequestKeyframe(now)) {
      this.lastRecovery = now;
      this.requestKeyframe();
    }
  }
  private canRequestKeyframe(now: number) {
    return (
      this.inFlight.size < 64 &&
      this.inFlightBytes() < this.budget() &&
      this.oldestAge(now) <= this.baseRtt + 500 &&
      now >= this.nextSend &&
      now - this.lastRecovery >= 1000
    );
  }
  prioritizeInteraction(now: number) {
    // Do not replay a pre-input backlog before showing the user's next action.
    // Discard the whole dependent chain; never skip a delta inside a valid chain.
    if (
      this.remote &&
      this.queue[0] &&
      now - this.queue[0].at > 100 &&
      this.canRequestKeyframe(now)
    ) {
      this.recover(now);
    }
  }
  offer(message: Buffer, now: number) {
    const tag = message[0],
      payload = message.subarray(1);
    if (tag === 4) return; // Native JPEG seed is large and unnecessary for a video decoder.
    if (tag === 1) {
      this.description = parseAvcDescription(payload);
      this.reference = undefined;
      this.reset();
      return;
    }
    if ((tag !== 2 && tag !== 3) || !this.description || payload.length > 2 * 1024 * 1024)
      throw Error('AVC packet');
    const info = avcFrameInfo(payload, this.description);
    if (info.key !== (tag === 2)) throw Error('AVC key tag');
    if (
      !info.key &&
      (this.reference === undefined ||
        info.frameNum !== (this.reference + 1) % 2 ** this.description.frameBits)
    ) {
      this.recover(now);
    }
    if (info.reference) this.reference = info.frameNum;
    if (info.key) {
      this.queue = [];
      this.queuedBytes = 0;
      this.waiting = false;
    }
    if (this.waiting) {
      this.recover(now);
      return;
    }
    if (
      this.queue.length >= 64 ||
      this.queuedBytes + payload.length > 2 * 1024 * 1024 ||
      (this.queue[0] && now - this.queue[0].at > 1000)
    ) {
      this.recover(now);
      return;
    }
    this.queue.push({ payload, key: info.key, at: now });
    this.queuedBytes += payload.length;
  }
  take(now: number): Buffer | undefined {
    if (this.waiting) {
      this.recover(now);
      return undefined;
    }
    const next = this.queue[0];
    if (!next) return undefined;
    if (now - next.at > 1000) {
      this.recover(now);
      return undefined;
    }
    const description = next.key ? this.description?.bytes : undefined;
    if (next.key && !description) return undefined;
    const size = 11 + (description?.length ?? 0) + next.payload.length;
    const bytes = this.inFlightBytes();
    if (
      now < this.nextSend ||
      this.inFlight.size >= 64 ||
      (bytes > 0 && bytes + size > this.budget()) ||
      this.oldestAge(now) > this.baseRtt + 500 ||
      this.sequence === 0xffffffff
    )
      return undefined;
    const packet = Buffer.allocUnsafe(size),
      sequence = ++this.sequence;
    packet.writeUInt32BE(SIMULATOR_AVC_MAGIC, 0);
    packet.writeUInt32BE(sequence, 4);
    packet[8] = next.key ? 2 : 3;
    packet.writeUInt16BE(description?.length ?? 0, 9);
    description?.copy(packet, 11);
    next.payload.copy(packet, 11 + (description?.length ?? 0));
    this.queue.shift();
    this.queuedBytes -= next.payload.length;
    this.inFlight.set(sequence, { bytes: size, at: now });
    // Native bitrate is a long-term target, not a hard per-frame size limit.
    this.nextSend = now + (this.remote ? (size * 8 * 1000) / (this.bitrate * 1.3) : 0);
    return packet;
  }
  acknowledge(sequence: number, now: number) {
    if (sequence <= this.acknowledged) return true;
    const frame = this.inFlight.get(sequence);
    if (!frame) return false;
    const ackMs = Math.max(0, now - frame.at);
    if (!this.feedbackCount || now - this.lastAck >= 2000) {
      this.feedbackAt = now;
      this.feedbackCount = this.slowFeedback = this.feedbackBytes = 0;
      this.minFeedback = Infinity;
    }
    this.lastAck = now;
    this.feedbackCount++;
    if (ackMs > this.baseRtt + 350) this.slowFeedback++;
    this.minFeedback = Math.min(this.minFeedback, ackMs);
    this.acknowledged = sequence;
    for (const [id, entry] of this.inFlight)
      if (id <= sequence) {
        this.feedbackBytes += entry.bytes;
        this.inFlight.delete(id);
      }
    // One slow ACK after a healthy interval is jitter, not sustained congestion.
    // Use a complete feedback window; idle gaps begin a fresh observation instead
    // of turning one large keyframe into evidence about the whole link.
    const elapsed = now - (this.feedbackAt ?? now);
    if (elapsed >= 2000) {
      const enough = this.feedbackCount >= 8;
      const slowFraction = this.slowFeedback / this.feedbackCount;
      if (this.remote && enough && slowFraction >= 0.75) {
        this.bitrate = Math.max(150_000, Math.round(this.bitrate * 0.75));
        this.lastTune = now;
      } else if (
        this.remote &&
        enough &&
        slowFraction <= 0.1 &&
        now - this.lastTune >= 5000 &&
        this.minFeedback < this.baseRtt + 150 &&
        (this.feedbackBytes * 8000) / elapsed > this.bitrate * 0.4
      ) {
        // Tiny static deltas are not a bandwidth probe. Raise only with demand.
        this.bitrate = Math.min(2_000_000, Math.round(this.bitrate * 1.15));
        this.lastTune = now;
      }
      this.feedbackCount = this.slowFeedback = this.feedbackBytes = 0;
      this.feedbackAt = undefined;
      this.minFeedback = Infinity;
    }
    return true;
  }
  recordRtt(ms: number) {
    const bounded = Math.max(1, Math.min(10000, ms));
    this.baseRtt = this.rtt ? Math.min(this.baseRtt, bounded) : bounded;
    this.rtt = bounded;
  }
  targetBitrate() {
    return this.bitrate;
  }
  private budget() {
    return this.remote
      ? Math.min(
          256 * 1024,
          Math.max(64 * 1024, ((this.bitrate / 8) * (Math.min(1000, this.baseRtt) + 200)) / 1000)
        )
      : 2 * 1024 * 1024;
  }
  private inFlightBytes() {
    let n = 0;
    for (const f of this.inFlight.values()) n += f.bytes;
    return n;
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
      windowBytes: this.budget(),
      queuedFrames: this.queue.length,
    };
    return result;
  }
}
