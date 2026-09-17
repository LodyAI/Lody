import type { LoroRepo } from 'loro-repo';
import type { FlockVersionVector } from './local-loro-data-plane';

export type FlockChangeBatch = {
  source?: string;
  events?: readonly { key: readonly unknown[] }[];
};

export type FlockRecordSource = {
  exportJson(from: FlockVersionVector): unknown | Promise<unknown>;
  getEntry?: ReturnType<LoroRepo['getMeta']>['getEntry'];
};

type Bundle = { version: number; entries: Record<string, unknown> };

/** Per-link exact records, never a maximum-clock claim of completeness.
 * Rejoin creates a fresh instance and reconciles all records in both directions.
 * Live Wasm events point-read changed keys; older structural adapters fall back
 * to a full export. Backpressure coalesces keys instead of buffering payloads.
 */
export class LocalFlockPeerState {
  private readonly known = new Map<string, string>();
  private readonly pending = new Set<string>();
  private full = true;

  retry(): void {
    this.full = true;
  }

  changed(batch: FlockChangeBatch): void {
    if (!batch.events) this.full = true;
    else for (const event of batch.events) this.pending.add(JSON.stringify(event.key));
  }

  remember(bundle: unknown): void {
    const entries = (bundle as Bundle | undefined)?.entries;
    for (const [key, value] of Object.entries(entries ?? {})) {
      this.known.set(key, JSON.stringify(value));
    }
  }

  async export(flock: FlockRecordSource): Promise<Bundle> {
    const full = this.full || !flock.getEntry;
    const keys = [...this.pending];
    this.full = false;
    this.pending.clear();
    try {
      let bundle: Bundle;
      if (full) bundle = (await flock.exportJson({})) as Bundle;
      else {
        bundle = { version: 0, entries: {} };
        for (const key of keys) {
          const entry = flock.getEntry!(JSON.parse(key));
          if (!entry) {
            bundle = (await flock.exportJson({})) as Bundle;
            break;
          }
          const { physicalTime, logicalCounter, peerId } = entry.clock;
          bundle.entries[key] = {
            c: `${physicalTime},${logicalCounter},${peerId}`,
            ...(entry.data === undefined ? {} : { d: entry.data }),
            ...(Object.keys(entry.metadata).length ? { m: entry.metadata } : {}),
          };
        }
      }
      return {
        version: bundle.version,
        entries: Object.fromEntries(
          Object.entries(bundle.entries).filter(
            ([key, value]) => this.known.get(key) !== JSON.stringify(value)
          )
        ),
      };
    } catch (error) {
      this.full = true;
      throw error;
    }
  }
}
