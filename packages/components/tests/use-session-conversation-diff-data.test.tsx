// @vitest-environment jsdom

import { act, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionId } from '@lody/shared';
import { useSessionConversationDiffData } from '../src/components/sessions/use-session-conversation-diff-data';
import type { SessionConversationDiffMode } from '../src/components/sessions/use-session-conversation-diff-data';
import type { SessionFileProvider } from '../src/lib/session-file-provider';
import { useSessionAllChangesDiffData } from '../src/components/sessions/use-session-all-changes-diff-data';

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const README_PATHS = ['README.md'];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  vi.useRealTimers();
  if (root && container) {
    act(() => {
      root?.unmount();
    });
  }
  root = null;
  container?.remove();
  container = null;
});

describe('useSessionConversationDiffData', () => {
  it('retains an immutable turn snapshot while its provider is rebuilt', async () => {
    const paths = ['immutable.ts'];
    const checkpoint = {
      filePath: paths[0],
      add: 1,
      del: 1,
      cc: { v: 1 as const, fileId: 'immutable-file', opId: '2:9', baseOpId: '1:9' },
    };
    const provider = createDiffProvider(async (path) => ({
      status: 'ready',
      path,
      oldSnapshot: { kind: 'text', text: 'old' },
      newSnapshot: { kind: 'text', text: 'saved turn' },
    }));
    let state: ReturnType<typeof useSessionConversationDiffData> | undefined;
    const onUpdate = (result: ReturnType<typeof useSessionConversationDiffData>) => {
      state = result;
    };
    const props = {
      mode: 'conversation' as const,
      filePaths: paths,
      loadFilePaths: paths,
      fileDiffs: [checkpoint],
      onUpdate,
    };
    render(<DiffDataHarness {...props} fileProvider={provider} />);
    await flushMicrotasks();
    expect(state?.resolvedByPath[paths[0]]).toMatchObject({
      status: 'ready',
      newSnapshot: { text: 'saved turn' },
    });
    const rebuilt = createDiffProvider(() => new Promise(() => {}));
    rerender(<DiffDataHarness {...props} fileProvider={rebuilt} />);
    await flushMicrotasks();
    expect(state?.resolvedByPath[paths[0]]).toMatchObject({
      status: 'ready',
      newSnapshot: { text: 'saved turn' },
    });
  });
  it('loads All Changes deferred content on visibility and invalidates it for a new live batch', async () => {
    const paths = ['inline.ts', 'deferred.ts'];
    let version = 'first';
    const provider = createDiffProvider(async (path) => ({
      status: 'ready',
      path,
      oldSnapshot: { kind: 'text', text: 'old' },
      newSnapshot: { kind: 'text', text: version },
    }));
    provider.getAllChangesDiff = async () => ({
      status: 'ready',
      base: 'base',
      truncated: false,
      entries: [
        {
          path: paths[0],
          diff: {
            status: 'ready',
            path: paths[0],
            oldSnapshot: { kind: 'text', text: 'old' },
            newSnapshot: { kind: 'text', text: 'inline' },
          },
        },
        { path: paths[1], diff: { status: 'deferred' } },
      ],
    });
    let state: ReturnType<typeof useSessionAllChangesDiffData> | undefined;
    function Harness({ visible, active = true }: { visible: string[]; active?: boolean }) {
      const result = useSessionAllChangesDiffData({
        sessionId: 'all-changes-test' as SessionId,
        filePaths: paths,
        loadFilePaths: visible,
        fileProvider: provider,
        enabled: active,
      });
      useEffect(() => {
        state = result;
      }, [result]);
      return null;
    }
    render(<Harness visible={[paths[0]]} />);
    await flushMicrotasks();
    expect(state?.resolvedByPath[paths[0]]).toMatchObject({
      status: 'ready',
      newSnapshot: { text: 'inline' },
    });
    expect(state?.resolvedByPath[paths[1]]).toBeUndefined();
    rerender(<Harness visible={[paths[1]]} />);
    await flushMicrotasks();
    expect(state?.resolvedByPath[paths[1]]).toMatchObject({
      status: 'ready',
      newSnapshot: { text: 'first' },
    });
    rerender(<Harness visible={[paths[1]]} active={false} />);
    version = 'other';
    rerender(<Harness visible={[paths[1]]} />);
    await flushMicrotasks(8);
    expect(state?.resolvedByPath[paths[1]]).toMatchObject({
      status: 'ready',
      newSnapshot: { text: 'other' },
    });
  });
  it('refetches when the All Changes scope changes and renders the returned uncommitted file set', async () => {
    const paths = ['committed.ts', 'worktree.ts'];
    const provider = createDiffProvider(async (path) => ({
      status: 'ready',
      path,
      oldSnapshot: { kind: 'text', text: 'old' },
      newSnapshot: { kind: 'text', text: 'new' },
    }));
    provider.getAllChangesDiff = async (_focusPath, scope) => {
      const entry = (path: string) => ({
        path,
        diff: { status: 'unavailable' as const, path, reason: 'metadata-only' as const },
      });
      return {
        status: 'ready',
        base: scope === 'uncommitted' ? 'head' : 'base',
        truncated: false,
        entries:
          scope === 'uncommitted'
            ? [entry('worktree.ts')]
            : [entry('committed.ts'), entry('worktree.ts')],
      };
    };
    let state: ReturnType<typeof useSessionAllChangesDiffData> | undefined;
    function Harness({ scope }: { scope: 'branch' | 'uncommitted' }) {
      const result = useSessionAllChangesDiffData({
        sessionId: 'all-changes-scope-test' as SessionId,
        filePaths: paths,
        fileProvider: provider,
        scope,
      });
      useEffect(() => {
        state = result;
      }, [result]);
      return null;
    }

    render(<Harness scope="branch" />);
    await flushMicrotasks();
    expect(state?.base).toBe('base');

    rerender(<Harness scope="uncommitted" />);
    await flushMicrotasks();
    expect(state?.base).toBe('head');
    expect(state?.normalizedPaths).toEqual(['worktree.ts']);
  });
  it('does not read All Changes from an offline owner and reloads when it returns', async () => {
    const paths = ['worktree.ts'];
    let reads = 0;
    const provider = createDiffProvider(async (path) => ({
      status: 'ready',
      path,
      oldSnapshot: { kind: 'text', text: 'old' },
      newSnapshot: { kind: 'text', text: 'new' },
    }));
    provider.getAllChangesDiff = async () => {
      reads += 1;
      return {
        status: 'ready',
        base: 'head',
        truncated: false,
        entries: [
          {
            path: 'worktree.ts',
            diff: {
              status: 'ready',
              path: 'worktree.ts',
              oldSnapshot: { kind: 'text', text: 'old' },
              newSnapshot: { kind: 'text', text: `read ${reads}` },
            },
          },
        ],
      };
    };
    let state: ReturnType<typeof useSessionAllChangesDiffData> | undefined;
    function Harness({ ownerOffline }: { ownerOffline: boolean }) {
      const result = useSessionAllChangesDiffData({
        sessionId: 'all-changes-owner-offline-test' as SessionId,
        filePaths: paths,
        fileProvider: provider,
        scope: 'uncommitted',
        ownerOffline,
      });
      useEffect(() => {
        state = result;
      }, [result]);
      return null;
    }

    render(<Harness ownerOffline />);
    await flushMicrotasks();
    expect(state).toMatchObject({ ownerOffline: true, isPanelLoading: false, batchReady: false });
    expect(state?.resolvedByPath).toEqual({});

    rerender(<Harness ownerOffline={false} />);
    await flushMicrotasks();
    expect(state?.ownerOffline).toBe(false);
    expect(state?.resolvedByPath['worktree.ts']).toMatchObject({
      status: 'ready',
      newSnapshot: { text: 'read 1' },
    });

    // A batch read before the owner went offline is not presented as current state.
    rerender(<Harness ownerOffline />);
    await flushMicrotasks();
    expect(state).toMatchObject({ ownerOffline: true, base: null, isPanelLoading: false });
    expect(state?.resolvedByPath).toEqual({});

    rerender(<Harness ownerOffline={false} />);
    await flushMicrotasks();
    expect(state?.resolvedByPath['worktree.ts']).toMatchObject({
      newSnapshot: { text: 'read 2' },
    });
  });
  it('accepts started reads across viewport changes and loads the newly visible file after settlement', async () => {
    type DiffResult = Awaited<ReturnType<SessionFileProvider['getDiff']>>;
    const pending = new Map<string, ReturnType<typeof createDeferred<DiffResult>>>();
    const getDiff: SessionFileProvider['getDiff'] = (path) => {
      if (pending.has(path)) throw new Error(`Duplicate read: ${path}`);
      const deferred = createDeferred<DiffResult>();
      pending.set(path, deferred);
      return deferred.promise;
    };
    const provider = createDiffProvider(getDiff);
    const paths = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'];
    let state: ReturnType<typeof useSessionConversationDiffData> | undefined;
    const onUpdate = (value: ReturnType<typeof useSessionConversationDiffData>) => {
      state = value;
    };
    render(
      <DiffDataHarness
        mode="base"
        filePaths={paths}
        loadFilePaths={paths.slice(0, 4)}
        fileProvider={provider}
        onUpdate={onUpdate}
      />
    );
    await flushMicrotasks();
    rerender(
      <DiffDataHarness
        mode="base"
        filePaths={paths}
        loadFilePaths={[paths[4]]}
        fileProvider={provider}
        onUpdate={onUpdate}
      />
    );
    await flushMicrotasks();
    expect(state?.resolvedByPath).toEqual({});
    await act(async () =>
      pending.get('a.ts')!.resolve({
        status: 'ready',
        path: 'a.ts',
        oldSnapshot: { kind: 'text', text: 'old-a' },
        newSnapshot: { kind: 'text', text: 'new-a' },
      })
    );
    await flushMicrotasks();
    expect(state?.resolvedByPath['a.ts']).toMatchObject({
      status: 'ready',
      newSnapshot: { text: 'new-a' },
    });
    await act(async () =>
      pending.get('e.ts')!.resolve({
        status: 'ready',
        path: 'e.ts',
        oldSnapshot: { kind: 'text', text: 'old-e' },
        newSnapshot: { kind: 'text', text: 'new-e' },
      })
    );
    await flushMicrotasks();
    expect(state?.resolvedByPath['e.ts']).toMatchObject({
      status: 'ready',
      newSnapshot: { text: 'new-e' },
    });
  });
  it('matches conversation fileDiff checkpoints by normalized path', async () => {
    vi.useFakeTimers();
    const checkpoint = {
      filePath: 'README.md',
      add: 1,
      del: 0,
      cc: {
        v: 1 as const,
        fileId: 't:000014',
        opId: '2:5',
        baseOpId: '1:5',
      },
    };
    const getDiff = vi.fn<SessionFileProvider['getDiff']>(async (pathOrFileId) => ({
      status: 'unavailable',
      path: pathOrFileId,
      reason: 'missing-text-frontiers',
    }));

    render(
      <DiffDataHarness
        mode="conversation"
        filePaths={['./README.md']}
        loadFilePaths={['./README.md']}
        priorityFilePath="./README.md"
        fileDiffs={[checkpoint]}
        fileProvider={createDiffProvider(getDiff)}
        onUpdate={() => undefined}
      />
    );

    await flushMicrotasks();

    expect(getDiff).toHaveBeenCalledWith('./README.md', 'turn-1', checkpoint);
  });

  it('ignores fileDiff checkpoints in All Changes mode', async () => {
    vi.useFakeTimers();
    const checkpoint = {
      filePath: 'README.md',
      add: 1,
      del: 0,
      cc: {
        v: 1 as const,
        fileId: 't:000014',
        opId: '2:5',
        baseOpId: '1:5',
      },
    };
    const getDiff = vi.fn<SessionFileProvider['getDiff']>(async (pathOrFileId) => ({
      status: 'unavailable',
      path: pathOrFileId,
      reason: 'missing-text-frontiers',
    }));

    render(
      <DiffDataHarness
        mode="base"
        filePaths={['./README.md']}
        loadFilePaths={['./README.md']}
        priorityFilePath="./README.md"
        fileDiffs={[checkpoint]}
        fileProvider={createDiffProvider(getDiff)}
        onUpdate={() => undefined}
      />
    );

    await flushMicrotasks();

    expect(getDiff).toHaveBeenCalledWith('./README.md', undefined, undefined);
  });

  it('passes the uncommitted All Changes scope to per-file reads', async () => {
    const getDiff = vi.fn<SessionFileProvider['getDiff']>(async (pathOrFileId) => ({
      status: 'unavailable',
      path: pathOrFileId,
      reason: 'not_changed',
    }));

    render(
      <DiffDataHarness
        mode="base"
        allChangesScope="uncommitted"
        fileProvider={createDiffProvider(getDiff)}
        onUpdate={() => undefined}
      />
    );

    await flushMicrotasks();

    expect(getDiff).toHaveBeenCalledWith('README.md', undefined, undefined, {
      allChangesScope: 'uncommitted',
    });
  });

  it('keeps loaded All Changes data when equivalent checkpoints rerender', async () => {
    vi.useFakeTimers();
    const checkpoint = {
      filePath: 'README.md',
      add: 1,
      del: 0,
      cc: {
        v: 1 as const,
        fileId: 't:000014',
        opId: '2:5',
        baseOpId: '1:5',
      },
    };
    const getDiff = vi.fn<SessionFileProvider['getDiff']>(async (pathOrFileId) => ({
      status: 'ready',
      path: pathOrFileId,
      oldSnapshot: { kind: 'text', text: 'base\n' },
      newSnapshot: { kind: 'text', text: 'base\nhello\n' },
    }));
    const onUpdate = vi.fn();
    const provider = createDiffProvider(getDiff);

    render(
      <DiffDataHarness
        mode="base"
        filePaths={['./README.md']}
        loadFilePaths={['./README.md']}
        priorityFilePath="./README.md"
        fileDiffs={[checkpoint]}
        fileProvider={provider}
        onUpdate={onUpdate}
      />
    );

    await flushMicrotasks();
    expect(getDiff).toHaveBeenCalledTimes(1);
    expect(getDiff).toHaveBeenCalledWith('./README.md', undefined, undefined);

    rerender(
      <DiffDataHarness
        mode="base"
        filePaths={['./README.md']}
        loadFilePaths={['./README.md']}
        priorityFilePath="./README.md"
        fileDiffs={[{ ...checkpoint, cc: { ...checkpoint.cc } }]}
        fileProvider={provider}
        onUpdate={onUpdate}
      />
    );

    await flushMicrotasks();
    expect(getDiff).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls.at(-1)?.[0].resolvedByPath['./README.md']).toMatchObject({
      status: 'ready',
      oldSnapshot: { kind: 'text', text: 'base\n' },
      newSnapshot: { kind: 'text', text: 'base\nhello\n' },
    });
  });

  it('does not auto-retry provider-declared unavailable diff states', async () => {
    vi.useFakeTimers();
    const getDiff = vi.fn<SessionFileProvider['getDiff']>(async (pathOrFileId) => ({
      status: 'unavailable',
      path: pathOrFileId,
      reason: 'missing-text-frontiers',
    }));

    render(
      <DiffDataHarness fileProvider={createDiffProvider(getDiff)} onUpdate={() => undefined} />
    );

    await flushMicrotasks();
    expect(getDiff.mock.calls.length).toBeGreaterThan(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    await flushMicrotasks();
    const stableCalls = getDiff.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await flushMicrotasks();

    expect(getDiff).toHaveBeenCalledTimes(stableCalls);
  });

  it('retries thrown diff read failures only up to the configured retry limit', async () => {
    vi.useFakeTimers();
    const getDiff = vi.fn<SessionFileProvider['getDiff']>(async () => {
      throw new Error('temporary diff read failure');
    });

    render(
      <DiffDataHarness fileProvider={createDiffProvider(getDiff)} onUpdate={() => undefined} />
    );

    await flushMicrotasks();
    expect(getDiff).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    await flushMicrotasks();
    expect(getDiff).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    await flushMicrotasks();
    expect(getDiff).toHaveBeenCalledTimes(3);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await flushMicrotasks();
    expect(getDiff).toHaveBeenCalledTimes(3);
  });

  it('keeps provider diff RPC concurrency bounded across resolved state updates', async () => {
    vi.useFakeTimers();
    const paths = Array.from({ length: 20 }, (_, index) => `src/file-${index}.ts`);
    type DiffResult = Awaited<ReturnType<SessionFileProvider['getDiff']>>;
    const pending = new Map<string, ReturnType<typeof createDeferred<DiffResult>>>();
    const getDiff = vi.fn<SessionFileProvider['getDiff']>((pathOrFileId) => {
      const deferred = createDeferred<DiffResult>();
      pending.set(pathOrFileId, deferred);
      return deferred.promise;
    });

    render(
      <DiffDataHarness
        mode="base"
        filePaths={paths}
        loadFilePaths={paths}
        priorityFilePath={paths[0]}
        fileProvider={createDiffProvider(getDiff)}
        onUpdate={() => undefined}
      />
    );

    await flushMicrotasks();
    expect(getDiff.mock.calls.map(([path]) => path)).toEqual([paths[0]]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_300);
    });
    await flushMicrotasks();
    expect(getDiff).toHaveBeenCalledTimes(4);

    await act(async () => {
      pending.get(paths[0])?.resolve({
        status: 'ready',
        path: paths[0],
        oldSnapshot: { kind: 'text', text: 'old\n' },
        newSnapshot: { kind: 'text', text: 'new\n' },
      });
      await Promise.resolve();
    });
    await flushMicrotasks();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_300);
    });
    await flushMicrotasks();

    expect(getDiff).toHaveBeenCalledTimes(5);
  });
});

function render(node: ReactNode): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  rerender(node);
}

function rerender(node: ReactNode): void {
  act(() => {
    root?.render(node);
  });
}

async function flushMicrotasks(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  if (!resolve || !reject) {
    throw new Error('Failed to create deferred promise');
  }
  return { promise, resolve, reject };
}

function DiffDataHarness({
  fileProvider,
  mode = 'base',
  filePaths = README_PATHS,
  loadFilePaths = README_PATHS,
  priorityFilePath = 'README.md',
  fileDiffs,
  allChangesScope,
  onUpdate,
}: {
  readonly fileProvider: SessionFileProvider;
  readonly mode?: SessionConversationDiffMode;
  readonly filePaths?: string[];
  readonly loadFilePaths?: string[];
  readonly priorityFilePath?: string;
  readonly fileDiffs?: Parameters<typeof useSessionConversationDiffData>[0]['fileDiffs'];
  readonly allChangesScope?: 'branch' | 'uncommitted';
  readonly onUpdate: (result: ReturnType<typeof useSessionConversationDiffData>) => void;
}) {
  const result = useSessionConversationDiffData({
    sessionId: 'session-1' as SessionId,
    turnId: mode === 'base' ? 'all-changes' : 'turn-1',
    mode,
    filePaths,
    loadFilePaths,
    priorityFilePath,
    fileDiffs,
    fileProvider,
    allChangesScope,
  });

  useEffect(() => {
    onUpdate(result);
  }, [onUpdate, result]);

  return null;
}

function createDiffProvider(getDiff: SessionFileProvider['getDiff']): SessionFileProvider {
  return {
    kind: 'code-collab',
    getDiff,
  } as SessionFileProvider;
}
