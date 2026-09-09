import type { AcpCapabilitySources } from '@lody/shared';

type Options = {
  epoch: string;
  resolveVersions: () => Promise<Record<string, string>>;
  /** Check isCurrent immediately before the durable write, after any asynchronous open. */
  publish: (snapshot: AcpCapabilitySources, isCurrent: () => boolean) => Promise<void>;
  onError: (error: unknown) => void;
};

/** One owner, one coalesced scan, and a serialized write lane independent of slow scans. */
export class AcpCapabilitySourcePublisher {
  private started = false;
  private stopped = false;
  private generation = 0;
  private scannedGeneration = 0;
  private scan: Promise<void> | undefined;
  private writes = Promise.resolve();

  constructor(private readonly options: Options) {}

  start(): Promise<void> {
    if (!this.started && !this.stopped) {
      this.started = true;
      this.refresh();
    }
    // Registration waits only for invalidation, never for a runtime probe or installation.
    return this.writes;
  }

  refresh(): void {
    if (!this.started || this.stopped) return;
    const generation = ++this.generation;
    this.enqueue({}, generation);
    this.ensureScan();
  }

  private enqueue(versions: Record<string, string>, generation: number): void {
    const isCurrent = () => !this.stopped && generation === this.generation;
    this.writes = this.writes
      .then(async () => {
        if (isCurrent()) {
          await this.options.publish({ epoch: this.options.epoch, versions }, isCurrent);
        }
      })
      .catch(this.options.onError);
  }

  private ensureScan(): void {
    if (this.scan) return;
    this.scan = this.runScans().finally(() => {
      this.scan = undefined;
      if (!this.stopped && this.scannedGeneration !== this.generation) this.ensureScan();
    });
  }

  private async runScans(): Promise<void> {
    let generation: number;
    do {
      generation = this.generation;
      this.scannedGeneration = generation;
      try {
        const versions = await this.options.resolveVersions();
        if (!this.stopped && generation === this.generation) {
          this.enqueue(versions, generation);
          await this.writes;
        }
      } catch (error) {
        this.options.onError(error);
      }
    } while (!this.stopped && generation !== this.generation);
  }

  /** Late resolutions are fenced; drain durable writes before the repo closes. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.writes;
  }
}
