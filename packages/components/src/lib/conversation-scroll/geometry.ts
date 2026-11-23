import { createListLayout, type ListLayout } from './keyed-layout/list';
import { UNCACHED } from './keyed-layout/cache';
import type { EngineRow, SavedSizes } from './types';

export type { SavedSizes };

/**
 * Row sizes and offsets in item space (0 = the top of the rows container).
 *
 * Sizes follow row keys, so restored or pre-hide sizes warm initial estimates
 * and survive in `snapshot()` while layoutVersion matches, but count as
 * measured only after a live DOM read in the current epoch.
 */
export class Geometry {
  private readonly layout: ListLayout;
  private keys: string[] = [];
  private estimates: number[] = [];
  private readonly records = new Map<string, { version: string; epoch: number }>();
  private version: string;
  private epoch = 1;
  /** Changes whenever any row's offset or size may have changed. */
  revision = 0;

  constructor(layoutVersion: string, saved?: SavedSizes | null) {
    this.version = layoutVersion;
    const snapshot =
      saved && saved.keys.length === saved.sizes.length
        ? ([saved.sizes.slice(), undefined, saved.keys.slice()] as [number[], undefined, string[]])
        : undefined;
    this.layout = createListLayout(0, undefined, snapshot, [], (index) =>
      Math.max(0, this.estimates[index] ?? 0)
    );
    if (snapshot && saved) {
      saved.keys.forEach((key, index) => {
        if ((saved.sizes[index] ?? UNCACHED) !== UNCACHED) {
          this.records.set(key, { version: saved.layoutVersion, epoch: 0 });
        }
      });
    }
  }

  get length(): number {
    return this.keys.length;
  }

  get layoutVersion(): string {
    return this.version;
  }

  keyAt(index: number): string | undefined {
    return this.keys[index];
  }

  indexOfKey(key: string): number {
    return this.keys.indexOf(key);
  }

  /** Replace the row list. Returns true if any offset may have changed. */
  setRows(rows: readonly EngineRow[]): boolean {
    const keys = rows.map((row) => row.key);
    const estimates = rows.map((row) => row.estimate);
    const keysChanged = this.layout.$setKeys(keys);
    let estimatesChanged = false;
    if (!keysChanged) {
      for (let index = 0; index < estimates.length; index += 1) {
        if (estimates[index] !== this.estimates[index] && !this.hasCachedSize(index)) {
          estimatesChanged = true;
          break;
        }
      }
    }
    this.keys = keys;
    this.estimates = estimates;
    if (estimatesChanged) this.layout.$invalidate();
    if (keysChanged || estimatesChanged) {
      this.revision += 1;
      return true;
    }
    return false;
  }

  setLayoutVersion(version: string): boolean {
    if (version === this.version) return false;
    this.version = version;
    this.epoch += 1;
    return true;
  }

  invalidateLiveMeasurements(): void {
    this.epoch += 1;
  }

  offset(index: number): number {
    if (this.keys.length === 0) return 0;
    return this.layout.$getItemOffset(Math.max(0, Math.min(index, this.keys.length)));
  }

  size(index: number): number {
    if (index < 0 || index >= this.keys.length) return 0;
    return this.layout.$getItemSize(index);
  }

  total(): number {
    return this.keys.length === 0 ? 0 : this.layout.$getTotalSize();
  }

  /** The row containing item-space offset `y`, clamped to the list. -1 when empty. */
  findIndex(y: number): number {
    if (this.keys.length === 0) return -1;
    return this.layout.$findIndex(y);
  }

  isMeasured(index: number): boolean {
    const key = this.keys[index];
    return key !== undefined && this.records.get(key)?.epoch === this.epoch;
  }

  /** Record a read size. Returns true if the stored size changed. */
  setMeasured(index: number, size: number): boolean {
    const key = this.keys[index];
    if (key === undefined || !Number.isFinite(size) || size < 0) return false;
    this.records.set(key, { version: this.version, epoch: this.epoch });
    if (this.layout.$isSizeEqual(index, size)) return false;
    this.layout.$setItemSize(index, size);
    this.revision += 1;
    return true;
  }

  snapshot(): SavedSizes {
    const sizes = this.keys.map((key, index) =>
      this.records.get(key)?.version === this.version ? this.layout.$getItemSize(index) : UNCACHED
    );
    return { layoutVersion: this.version, keys: this.keys.slice(), sizes };
  }

  private hasCachedSize(index: number): boolean {
    return !this.layout.$isSizeEqual(index);
  }
}
