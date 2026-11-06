import type { CodeCollabDiffBlobKey } from '@lody/shared';

export type DiffBlobSource =
  | { readonly kind: 'disk'; readonly absolutePath: string }
  | { readonly kind: 'git'; readonly repository: string; readonly oid: string }
  | {
      readonly kind: 'turn';
      readonly path: string;
      readonly turnId?: string;
      readonly side: 'old' | 'new';
      readonly hash: string;
    };

export type DiffBlobHandle = {
  readonly ownerSessionId: string;
  readonly workspaceRoot: string;
  readonly rawBytes: number;
  readonly source: DiffBlobSource;
};

/** Bounded, passive tables owned and cleared by CodeCollabV2Service. No timers or I/O. */
export class DiffBlobRegistry {
  private readonly handles = new Map<string, { handle: DiffBlobHandle; at: number }>();
  private readonly buffers = new Map<string, { bytes: Buffer; at: number }>();
  private bufferBytes = 0;
  private readonly counts = new Map<string, number>();

  constructor(private readonly now: () => number) {}

  issue(sessionId: string, key: CodeCollabDiffBlobKey, handle: DiffBlobHandle): void {
    const id = this.id(sessionId, key);
    if (!this.handles.has(id)) this.counts.set(sessionId, (this.counts.get(sessionId) ?? 0) + 1);
    this.handles.delete(id);
    this.handles.set(id, { handle, at: this.now() });
    let ownerCount = this.counts.get(sessionId) ?? 0;
    for (const existing of this.handles.keys()) {
      if (ownerCount <= 8192) break;
      if (existing.startsWith(`${sessionId}\0`)) {
        this.drop(existing);
        ownerCount--;
      }
    }
    while (this.handles.size > 65536) {
      const oldest = this.handles.keys().next().value;
      if (oldest === undefined) break;
      this.drop(oldest);
    }
  }

  get(sessionId: string, key: CodeCollabDiffBlobKey): DiffBlobHandle | undefined {
    const id = this.id(sessionId, key);
    const entry = this.handles.get(id);
    if (!entry) return undefined;
    if (this.now() - entry.at >= 600_000) {
      this.drop(id);
      return undefined;
    }
    this.handles.delete(id);
    this.handles.set(id, { ...entry, at: this.now() });
    return entry.handle;
  }

  getBuffer(sessionId: string, key: CodeCollabDiffBlobKey): Buffer | undefined {
    const id = this.id(sessionId, key);
    const entry = this.buffers.get(id);
    if (!entry) return undefined;
    this.buffers.delete(id);
    this.bufferBytes -= entry.bytes.length;
    if (this.now() - entry.at >= 60_000) return undefined;
    this.buffers.set(id, { ...entry, at: this.now() });
    this.bufferBytes += entry.bytes.length;
    return entry.bytes;
  }

  putBuffer(sessionId: string, key: CodeCollabDiffBlobKey, bytes: Buffer): void {
    const id = this.id(sessionId, key);
    const old = this.buffers.get(id);
    if (old) this.bufferBytes -= old.bytes.length;
    this.buffers.delete(id);
    this.buffers.set(id, { bytes, at: this.now() });
    this.bufferBytes += bytes.length;
    while (this.bufferBytes > 64 * 1024 * 1024 || this.buffers.size > 8192) {
      const oldest = this.buffers.entries().next().value;
      if (!oldest) break;
      this.buffers.delete(oldest[0]);
      this.bufferBytes -= oldest[1].bytes.length;
    }
  }

  clear(): void {
    this.handles.clear();
    this.buffers.clear();
    this.counts.clear();
    this.bufferBytes = 0;
  }
  private drop(id: string): void {
    if (this.handles.delete(id)) {
      const owner = id.slice(0, id.lastIndexOf('\0'));
      const count = (this.counts.get(owner) ?? 1) - 1;
      if (count) this.counts.set(owner, count);
      else this.counts.delete(owner);
    }
  }
  private id(sessionId: string, key: string): string {
    return `${sessionId}\0${key}`;
  }
}
