import type { MachineResourceHistory } from '@lody/shared';

type Sample = MachineResourceHistory['samples'][number];
const MAX_AGE_MS = 10 * 60 * 1000;

/** Observation-only history. Reading it never starts a process probe. */
export class ResourceHistory {
  private samples: Sample[] = [];

  constructor(
    private readonly machineId: string,
    private readonly instanceId: string
  ) {}

  append(sample: Sample): void {
    this.samples.push(
      structuredClone({
        ...sample,
        processes: sample.processes.slice(0, 256),
        processesTruncated: sample.processesTruncated || sample.processes.length > 256,
        sessions: sample.sessions.slice(0, 100),
        sessionsTruncated: sample.sessionsTruncated || sample.sessions.length > 100,
      })
    );
    this.trim(sample.sampledAtMs);
  }

  read(now = Date.now()): MachineResourceHistory {
    this.trim(now);
    return structuredClone({
      type: 'machine/resource-history',
      machineId: this.machineId,
      instanceId: this.instanceId,
      collectedWhileObserved: true,
      samples: this.samples,
    });
  }

  private trim(now: number): void {
    this.samples = this.samples
      .filter((sample) => sample.sampledAtMs >= now - MAX_AGE_MS)
      .slice(-120);
  }
}
