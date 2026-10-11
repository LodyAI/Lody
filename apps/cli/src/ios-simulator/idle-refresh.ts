import { jpegDimensions } from './frame-flow';

/** One sharp frame per quiet period. Source/input activity fences asynchronous
 * capture so an old still never replaces a newer live frame. No lease renewal.
 */
export class SimulatorIdleRefresh {
  private revision = 0;
  private attempted = -1;
  private lastActivity = Infinity;
  private closed = false;
  private abort?: AbortController;
  private pending?: Promise<void>;

  constructor(
    private readonly capture: (scale: number, signal: AbortSignal) => Promise<Buffer>,
    private readonly publish: (frame: Buffer) => void,
    private readonly discard: () => void
  ) {}

  activity(now: number) {
    this.lastActivity = now;
    this.revision++;
    this.abort?.abort();
    this.discard();
  }

  tick(now: number, scale: number, drained: boolean) {
    if (
      this.closed ||
      this.pending ||
      !drained ||
      this.attempted === this.revision ||
      now - this.lastActivity < 2000
    )
      return;
    const revision = this.revision;
    this.attempted = revision;
    const abort = new AbortController();
    this.abort = abort;
    this.pending = this.capture(scale, abort.signal)
      .then((frame) => {
        if (!this.closed && !abort.signal.aborted && revision === this.revision)
          this.publish(frame);
      })
      .catch(() => {
        // Keep the last live image. Retry only after new activity, never poll a still.
      })
      .finally(() => {
        this.pending = undefined;
      });
  }

  async close() {
    this.closed = true;
    this.abort?.abort();
    this.discard();
    await this.pending;
  }
}

/** Fixed loopback route only; no browser-supplied paths, options, or redirects. */
export async function readSimulatorStill(options: {
  port: number;
  udid: string;
  scale: number;
  signal: AbortSignal;
  active(): boolean;
  fetch?: typeof fetch;
}) {
  if (!options.active()) throw new Error('Simulator unavailable.');
  const scale = Math.max(1, Math.min(4, Math.round(options.scale)));
  const response = await (options.fetch ?? fetch)(
    `http://127.0.0.1:${options.port}/simulators/${encodeURIComponent(options.udid)}/screenshot.jpg?scale=${scale}&quality=0.85`,
    { redirect: 'error', signal: AbortSignal.any([options.signal, AbortSignal.timeout(5000)]) }
  );
  if (!response.ok || !response.body) throw new Error('Simulator still unavailable.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 512 * 1024) throw new Error('Simulator still too large.');
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
  }
  if (!options.active() || options.signal.aborted) throw new Error('Simulator unavailable.');
  const frame = Buffer.concat(chunks);
  if (!jpegDimensions(frame)) throw new Error('Invalid simulator still.');
  return frame;
}
