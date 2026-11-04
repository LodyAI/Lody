import { readCodeCollabFileGenerations, readCodeCollabFileIndexFromFlock } from '@lody/shared';
import { describe, expect, it, vi } from 'vitest';

import type { CodeCollabFileIndexWritableFlock } from '@lody/shared';
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
  const generations = new Map<string, unknown>();
  return {
    flock: {
      scan: () => [
        ...[...values].map(([key, value]) => ({ key: [key], value })),
        ...[...generations].map(([key, value]) => ({ key: [key, 'v'], value })),
      ],
      set: (keys, value) => {
        const key = keys[0];
        if (keys.length === 2) {
          generations.set(key, value);
          return;
        }
        events.push(`set:${key}`);
        values.set(key, value);
      },
      delete: (keys) => {
        const key = keys[0];
        if (keys.length === 2) {
          generations.delete(key);
          return;
        }
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
  it('bumps only changed paths and invalidates unchanged rows when the comparison base changes', async () => {
    const local = makeFlock({}, []);
    const repo = {
      openFlockDoc: async () => ({ flock: local.flock, syncOnce: async () => undefined }),
      flush: async () => undefined,
    };
    const files = {
      'a.ts': { kind: 'text' as const, change: { diff: [1, 0] as [number, number] } },
      'b.ts': { kind: 'text' as const, change: { diff: [2, 0] as [number, number] } },
    };
    const publish = (
      fileIndex: typeof files,
      resetDiffGenerations = false,
      bumpDiffPaths?: readonly string[]
    ) =>
      publishCodeCollabFileIndexFlock({
        repo,
        flockDocId: 'workspace:fi:owner',
        fileIndex,
        updatedAtMs: 1,
        reconcileRemote: false,
        resetDiffGenerations,
        bumpDiffPaths,
      });
    await publish(files);
    const first = readCodeCollabFileGenerations(local.flock);
    await publish({ ...files, 'a.ts': { ...files['a.ts'], change: { diff: [3, 0] } } });
    const second = readCodeCollabFileGenerations(local.flock);
    expect(second['a.ts']).not.toBe(first['a.ts']);
    expect(second['b.ts']).toBe(first['b.ts']);
    const current = readCodeCollabFileIndexFromFlock(local.flock);
    await publish(current as typeof files, false, ['a.ts']);
    const sameStats = readCodeCollabFileGenerations(local.flock);
    expect(sameStats['a.ts']).not.toBe(second['a.ts']);
    expect(sameStats['b.ts']).toBe(second['b.ts']);
    await publish(current as typeof files, true);
    const third = readCodeCollabFileGenerations(local.flock);
    expect(third['a.ts']).not.toBe(second['a.ts']);
    expect(third['b.ts']).not.toBe(second['b.ts']);
    expect(readCodeCollabFileIndexFromFlock(local.flock)).toEqual(current);
  });

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
});
