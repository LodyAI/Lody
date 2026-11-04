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
});
