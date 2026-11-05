import { Flock } from '@loro-dev/flock-wasm';
import { describe, expect, it } from 'vitest';

import {
  CODE_COLLAB_FILE_INDEX_LIMITS,
  buildCodeCollabFileIndexState,
  readCodeCollabFileIndexFromFlock,
  type CodeCollabFileIndexWritableFlock,
  type CodeCollabV2FileTreeState,
} from '@lody/shared';
import { publishCodeCollabFileIndexFlock } from './code-collab-flock-publish';

function makeFlock(
  initial: Record<string, unknown>,
  events: string[]
): {
  readonly flock: CodeCollabFileIndexWritableFlock;
  readonly replace: (next: Record<string, unknown>) => void;
  readonly snapshot: () => Record<string, unknown>;
} {
  const values = new Map(Object.entries(initial));
  return {
    flock: {
      scan: () => [...values].map(([key, value]) => ({ key: [key], value })),
      set: ([key], value) => {
        events.push(`set:${key}`);
        values.set(key, value);
      },
      delete: ([key]) => {
        events.push(`delete:${key}`);
        values.delete(key);
      },
      commit: () => {
        events.push('commit');
      },
    },
    replace: (next) => {
      values.clear();
      for (const [key, value] of Object.entries(next)) {
        values.set(key, value);
      }
    },
    snapshot: () => Object.fromEntries(values),
  };
}

describe('Code Collab Flock publication', () => {
  it('does not apply a stale file index when cancellation wins a pending pre-sync', async () => {
    const events: string[] = [];
    const local = makeFlock({ 'old.ts': true }, events);
    const controller = new AbortController();
    let release: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const work = publishCodeCollabFileIndexFlock({
      repo: {
        openFlockDoc: async () => ({
          flock: local.flock,
          syncOnce: async () => {
            ready();
            await pending;
          },
        }),
        flush: async () => {
          throw new Error('Cancelled pre-sync must not flush');
        },
      },
      signal: controller.signal,
      flockDocId: 'workspace:fi:owner',
      fileIndex: { 'stale.ts': true },
      updatedAtMs: 1,
      reconcileRemote: true,
    });
    const cancelled = expect(work).rejects.toThrow('cancelled');
    await started;
    controller.abort(new Error('cancelled'));
    await cancelled;
    release();
    await pending;
    expect(local.snapshot()).toEqual({ 'old.ts': true });
  });

  it('cleans an oversized legacy index in bounded commits and converges to the bounded state', async () => {
    const flock = new Flock();
    const legacy: CodeCollabV2FileTreeState = {};
    // Synthetic store-like paths: long, multi-byte and JSON-escaped segments.
    for (let index = 0; index < 4_000; index += 1) {
      legacy[`.pnpm-store/v10/index/${String(index).padStart(6, '0')}-缓存-"q"\\name@1.0.0.json`] =
        true;
    }
    for (const [key, value] of Object.entries(legacy)) flock.set([key], value);
    flock.commit();

    const tree: CodeCollabV2FileTreeState = { src: { kind: 'lazy' } };
    for (let index = 0; index < 1_200; index += 1) tree[`src/file-${index}.ts`] = true;
    const target = buildCodeCollabFileIndexState(tree, {
      'src/file-1.ts': { diff: [2, 1] },
      'src/removed.ts': { diff: [0, 4], del: true },
    });

    let exportedFrom = flock.version();
    const exportedBundleBytes: number[] = [];
    const recordExport = async () => {
      const bundle = flock.exportJson(exportedFrom);
      exportedFrom = flock.version();
      exportedBundleBytes.push(new TextEncoder().encode(JSON.stringify(bundle)).byteLength);
    };
    const result = await publishCodeCollabFileIndexFlock({
      repo: {
        openFlockDoc: async () => ({ flock, syncOnce: recordExport }),
        flush: async () => undefined,
      },
      flockDocId: 'workspace:fi:owner',
      fileIndex: target,
      updatedAtMs: 1_800_000_000_000,
      reconcileRemote: false,
    });

    expect(result.changed).toBe(true);
    expect(readCodeCollabFileIndexFromFlock(flock)).toEqual(target);
    expect(target['src/removed.ts']).toEqual({
      kind: 'deleted',
      change: { diff: [0, 4], del: true },
    });
    expect(exportedBundleBytes.length).toBeGreaterThan(1);
    for (const bytes of exportedBundleBytes) {
      expect(bytes).toBeLessThanOrEqual(CODE_COLLAB_FILE_INDEX_LIMITS.maxBytes);
    }
    // The complete published state also fits one bundle.
    const full = new TextEncoder().encode(JSON.stringify(flock.exportJson())).byteLength;
    expect(full - countTombstoneBytes(flock)).toBeLessThanOrEqual(
      CODE_COLLAB_FILE_INDEX_LIMITS.maxBytes
    );
  });
});

function countTombstoneBytes(flock: Flock): number {
  const bundle = flock.exportJson() as { entries: Record<string, { d?: unknown }> };
  let bytes = 0;
  for (const [key, record] of Object.entries(bundle.entries)) {
    if (record.d === undefined) {
      bytes += new TextEncoder().encode(
        `${JSON.stringify(key)}:${JSON.stringify(record)},`
      ).byteLength;
    }
  }
  return bytes;
}
