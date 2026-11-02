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
