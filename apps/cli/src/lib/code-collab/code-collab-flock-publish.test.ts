import { Flock } from '@loro-dev/flock-wasm';
import { describe, expect, it } from 'vitest';

import {
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
      staleRows: { allChanges: null, findMissingPaths: async () => new Set() },
    });
    const cancelled = expect(work).rejects.toThrow('cancelled');
    await started;
    controller.abort(new Error('cancelled'));
    await cancelled;
    release();
    await pending;
    expect(local.snapshot()).toEqual({ 'old.ts': true });
  });

  it('writes no tombstones for rows that still exist, so a legacy index costs nothing extra', async () => {
    const flock = new Flock();
    // Synthetic legacy index: cache residue plus ordinary files beyond the budget.
    for (let index = 0; index < 2_000; index += 1) {
      flock.set([`.pnpm-store/v10/index/${String(index).padStart(6, '0')}.json`], true);
      flock.set([`src/legacy-${index}.ts`], true);
    }
    flock.set(['src/removed.ts'], true);
    flock.commit();

    const target = buildCodeCollabFileIndexState({ 'README.md': true, src: { kind: 'lazy' } }, {});
    let exportedFrom = flock.version();
    const exportedKeys: string[][] = [];
    const checkedPaths: string[] = [];
    const result = await publishCodeCollabFileIndexFlock({
      repo: {
        openFlockDoc: async () => ({
          flock,
          syncOnce: async () => {
            const bundle = flock.exportJson(exportedFrom) as { entries: Record<string, unknown> };
            exportedFrom = flock.version();
            exportedKeys.push(
              Object.keys(bundle.entries)
                .map((key) => (JSON.parse(key) as string[])[0] ?? '')
                .sort()
            );
          },
        }),
        flush: async () => undefined,
      },
      flockDocId: 'workspace:fi:owner',
      fileIndex: target,
      updatedAtMs: 1_800_000_000_000,
      reconcileRemote: false,
      staleRows: {
        allChanges: {},
        findMissingPaths: async (paths) => {
          checkedPaths.push(...paths);
          return new Set(paths.filter((file) => file === 'src/removed.ts'));
        },
      },
    });

    expect(result.changed).toBe(true);
    // One small append: the new rows and the one real deletion.
    expect(exportedKeys).toEqual([['README.md', 'src', 'src/removed.ts'].sort()]);
    // Residue is not even checked against the disk.
    expect(checkedPaths.some((file) => file.startsWith('.pnpm-store/'))).toBe(false);
    const rows = readCodeCollabFileIndexFromFlock(flock);
    expect(rows['src/removed.ts']).toBeUndefined();
    expect(rows['src/legacy-0.ts']).toBe(true);
    expect(rows['.pnpm-store/v10/index/000000.json']).toBe(true);
  });
});
