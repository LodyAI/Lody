import { createListLayout, type ListLayout } from './keyed-layout/list';
import { UNCACHED } from './keyed-layout/cache';
import type { EngineRow } from './types';

export interface SavedSizes {
  layoutVersion: string;
  keys: string[];
  sizes: number[];
}

/**
 * Row sizes and offsets in item space (0 = the top of the rows container).
 *
 * Sizes follow row keys, so a placeholder that becomes several rows, or a row
 * that comes back, starts at a size seen before. A size counts as measured
 * only under the layout version it was measured in (width, font size, font
 * load, conversation font setting); under any other version it is an estimate
 * until the row is read again.
 */
export class Geometry {
  private readonly layout: ListLayout;
  private keys: string[] = [];
  private estimates: number[] = [];
  private readonly measuredIn = new Map<string, string>();
  private version: string;
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
    if (saved) {
      saved.keys.forEach((key, index) => {
        if ((saved.sizes[index] ?? UNCACHED) !== UNCACHED) {
          this.measuredIn.set(key, saved.layoutVersion);
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
        if (estimates[index] !== this.estimates[index] && !this.isMeasuredSize(index)) {
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
    return true;
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

  /** Measured under the current layout version. */
  isMeasured(index: number): boolean {
    const key = this.keys[index];
    return key !== undefined && this.measuredIn.get(key) === this.version;
  }

  /** Record a read size. Returns true if the stored size changed. */
  setMeasured(index: number, size: number): boolean {
    const key = this.keys[index];
    if (key === undefined || !Number.isFinite(size) || size < 0) return false;
    this.measuredIn.set(key, this.version);
    if (this.layout.$isSizeEqual(index, size)) return false;
    this.layout.$setItemSize(index, size);
    this.revision += 1;
    return true;
  }

  snapshot(): SavedSizes {
    const sizes = this.keys.map((key, index) =>
      this.measuredIn.get(key) === this.version ? this.layout.$getItemSize(index) : UNCACHED
    );
    return { layoutVersion: this.version, keys: this.keys.slice(), sizes };
  }

  private isMeasuredSize(index: number): boolean {
    return !this.layout.$isSizeEqual(index);
  }
}
