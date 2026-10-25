import { describe, expect, it, vi } from 'vitest';

import type { CodeCollabFileIndexWritableFlock } from '@lody/shared';
import {
  CodeCollabFileIndexChangedPublishError,
  publishCodeCollabFileIndexFlock,
  publishCodeCollabFileIndexSignalFlock,
} from './code-collab-flock-publish';

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

function makeTransportRepo(
  events: string[],
  initial: {
    readonly local?: Record<string, unknown>;
    readonly remote?: Record<string, unknown>;
  } = {}
) {
  const local = makeFlock(initial.local ?? {}, events);
  let remote = { ...(initial.remote ?? {}) };
  let flushed = false;
  return {
    repo: {
      openFlockDoc: vi.fn(async () => {
        let syncCount = 0;
        flushed = false;
        events.push('open');
        return {
          flock: local.flock,
          syncOnce: async () => {
            syncCount += 1;
            events.push(`sync:${syncCount}`);
            if (flushed) {
              remote = local.snapshot();
            } else {
              local.replace(remote);
            }
          },
        };
      }),
      flush: vi.fn(async () => {
        events.push('flush');
        flushed = true;
      }),
    },
    resetRemote: (next: Record<string, unknown>) => {
      remote = { ...next };
    },
    localSnapshot: local.snapshot,
    remoteSnapshot: () => remote,
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

  it('pre-syncs reconnect repair and skips write, flush, and post-sync when unchanged', async () => {
    const events: string[] = [];
    const { repo, remoteSnapshot } = makeTransportRepo(events);
    await publishCodeCollabFileIndexFlock({
      repo,
      flockDocId: 'workspace:fi:owner',
      fileIndex: { 'src/a.ts': true },
      updatedAtMs: 1,
      reconcileRemote: false,
    });
    expect(remoteSnapshot()).toEqual({ 'src/a.ts': true });
    events.length = 0;

    const result = await publishCodeCollabFileIndexFlock({
      repo,
      flockDocId: 'workspace:fi:owner',
      fileIndex: { 'src/a.ts': true },
      updatedAtMs: 1,
      reconcileRemote: true,
    });

    expect(result).toEqual({ changed: false });
    expect(events).toEqual(['open', 'sync:1']);
  });

  it('repairs missing remote state in pre-sync, write, flush, post-sync order', async () => {
    const events: string[] = [];
    const { repo, localSnapshot, remoteSnapshot, resetRemote } = makeTransportRepo(events);
    await publishCodeCollabFileIndexFlock({
      repo,
      flockDocId: 'workspace:fi:owner',
      fileIndex: { 'src/a.ts': true },
      updatedAtMs: 1,
      reconcileRemote: false,
    });
    expect(localSnapshot()).toEqual({ 'src/a.ts': true });
    expect(remoteSnapshot()).toEqual({ 'src/a.ts': true });
    resetRemote({});
    events.length = 0;

    const result = await publishCodeCollabFileIndexFlock({
      repo,
      flockDocId: 'workspace:fi:owner',
      fileIndex: { 'src/a.ts': true },
      updatedAtMs: 1,
      reconcileRemote: true,
    });

    expect(result).toEqual({ changed: true });
    expect(events).toEqual(['open', 'sync:1', 'set:src/a.ts', 'commit', 'flush', 'sync:2']);
    expect(localSnapshot()).toEqual({ 'src/a.ts': true });
    expect(remoteSnapshot()).toEqual({ 'src/a.ts': true });
  });

  it('advances the synced signal revision before flush and post-sync', async () => {
    const events: string[] = [];
    const { repo } = makeTransportRepo(events, {
      local: { s: { v: 1, r: 7 } },
      remote: { s: { v: 1, r: 7 } },
    });

    const result = await publishCodeCollabFileIndexSignalFlock({
      repo,
      flockDocId: 'workspace:fis:owner',
      updatedAtMs: 1,
    });

    expect(result).toEqual({ changed: true, revision: 8 });
    expect(events).toEqual(['open', 'sync:1', 'set:s', 'commit', 'flush', 'sync:2']);
  });

  it('does not post-sync after a flush failure', async () => {
    const events: string[] = [];
    const { repo } = makeTransportRepo(events);
    repo.flush.mockImplementationOnce(async () => {
      events.push('flush');
      throw new Error('flush failed');
    });

    const publication = publishCodeCollabFileIndexFlock({
      repo,
      flockDocId: 'workspace:fi:owner',
      fileIndex: { 'src/a.ts': true },
      updatedAtMs: 1,
      reconcileRemote: true,
    });
    await expect(publication).rejects.toBeInstanceOf(CodeCollabFileIndexChangedPublishError);
    await expect(publication).rejects.toMatchObject({
      cause: expect.objectContaining({ message: 'flush failed' }),
    });
    expect(events).toEqual(['open', 'sync:1', 'set:src/a.ts', 'commit', 'flush']);
  });
});
