// @vitest-environment jsdom
import { act, useEffect, type ReactNode } from 'react';
import { Provider, createStore } from 'jotai';
import { useSessionDiffSummary } from '../src/components/sessions/use-session-diff-summary';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionId } from '@lody/shared';
import { useSessionConversationDiffData } from '../src/components/sessions/use-session-conversation-diff-data';
import type { SessionConversationDiffMode } from '../src/components/sessions/use-session-conversation-diff-data';
import type { SessionFileProvider } from '../src/lib/session-file-provider';
import {
  CodeCollabSessionFileProvider,
  type CodeCollabSessionFileProviderRuntime,
} from '../src/lib/code-collab-session-file-provider';
import { manifestEntryToDiff } from '../src/lib/diff-blob-client';
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
  it('updates the sidebar summary from a completed live Branch manifest without waiting for history', async () => {
    let current = ['live.ts'];
    const provider = new CodeCollabSessionFileProvider({
      allChanges: { 'stale-index.ts': true },
      runtime: {
        sessionId: 'summary-test' as SessionId,
        diffBlobTransportOptions: async () => ({
          supported: true,
          scope: 'synthetic',
          persist: false,
        }),
        openDiffManifest: async ({ scope }: { scope?: string }) => ({
          status: 'ok',
          base: 'base',
          entries: (scope === 'uncommitted' ? [] : current).map((path) => ({
            path,
            status: 'binary',
            base: null,
            head: null,
            add: 1,
            del: 0,
          })),
          nextCursor: null,
        }),
        readDiffBlob: async () => {
          throw new Error('Metadata needs no body.');
        },
      } as unknown as CodeCollabSessionFileProviderRuntime,
    });
    let state: ReturnType<typeof useSessionDiffSummary> | undefined;
    function Harness() {
      const result = useSessionDiffSummary('summary-test' as SessionId, { fileProvider: provider });
      useEffect(() => {
        state = result;
      }, [result]);
      return null;
    }
    render(
      <Provider store={createStore()}>
        <Harness />
      </Provider>
    );
    await flushMicrotasks();
    expect(state?.summary.changeFilePaths).toEqual(['stale-index.ts']);
    await act(async () => {
      await provider.getAllChangesDiff();
    });
    expect(state?.summary.changeFilePaths).toEqual(['live.ts']);
    await act(async () => {
      await provider.getAllChangesDiff(undefined, 'uncommitted');
    });
    expect(state?.summary.changeFilePaths).toEqual(['live.ts']);
    current = [];
    await act(async () => {
      await provider.getAllChangesDiff();
    });
    expect(state?.summary.changeFilePaths).toEqual([]);
  });

  it('retains the coherent old batch during refresh and reuses verified unchanged viewer data', async () => {
    const paths = ['a.ts', 'b.ts'];
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    let updated = false;
    const provider = createDiffProvider(async (path) => ({
      status: 'ready',
      path,
      contentKey: path,
      oldSnapshot: { kind: 'text', text: 'old' },
      newSnapshot: { kind: 'text', text: 'new' },
    }));
    provider.getAllChangesDiff = async () => {
      if (updated) {
        started();
        await next;
      }
      return {
        status: 'ready',
        base: updated ? 'new-base' : 'old-base',
        truncated: false,
        entries: paths.map((path) => ({ path, diff: { status: 'deferred', contentKey: path } })),
      };
    };
    let state: ReturnType<typeof useSessionAllChangesDiffData> | undefined;
    function Harness() {
      const result = useSessionAllChangesDiffData({
        sessionId: 'retain-test' as SessionId,
        filePaths: paths,
        loadFilePaths: paths,
        fileProvider: provider,
      });
      useEffect(() => {
        state = result;
      }, [result]);
      return null;
    }
    render(<Harness />);
    await flushMicrotasks();
    const first = state!.resolvedByPath['a.ts'];
    expect(first?.status).toBe('ready');
    updated = true;
    act(() => state!.reload());
    await entered;
    expect(state!.refreshing).toBe(true);
    expect(state!.base).toBe('old-base');
    expect(state!.resolvedByPath['a.ts']).toBe(first);
    await act(async () => {
      release();
      await next;
    });
    await flushMicrotasks();
    expect(state!.base).toBe('new-base');
    expect(state!.refreshing).toBe(false);
    expect(state!.resolvedByPath['a.ts']).toBe(first);
  });

  it('rebinds a historical partial diff to the current runtime after reopening a workspace', async () => {
    const paths = ['runtime-bound.ts'];
    const checkpoints = [
      {
        filePath: paths[0],
        add: 1,
        del: 1,
        cc: { v: 1 as const, fileId: 'runtime-bound', opId: '2:1', baseOpId: '1:1' },
      },
    ];
    let retired = false;
    const makeProvider = (old: boolean) =>
      createDiffProvider(async () =>
        manifestEntryToDiff(
          {
            path: paths[0],
            status: 'ok',
            base: { key: `sha256:${'1'.repeat(64)}`, rawBytes: 7, format: { encoding: 'utf8' } },
            head: { key: `sha256:${'2'.repeat(64)}`, rawBytes: 6, format: { encoding: 'utf8' } },
            hunks: '--- runtime-bound.ts\n+++ runtime-bound.ts\n@@ -1 +1 @@\n-before\n+after\n',
          },
          async (blob) => {
            if (old && retired) throw new Error('Retired workspace runtime');
            return new TextEncoder().encode(blob.key.includes('1111') ? 'before\n' : 'after\n');
          }
        )
      );
    let state: ReturnType<typeof useSessionConversationDiffData> | undefined;
    const props = {
      mode: 'conversation' as const,
      filePaths: paths,
      loadFilePaths: paths,
      fileDiffs: checkpoints,
      onUpdate: (next: ReturnType<typeof useSessionConversationDiffData>) => {
        state = next;
      },
    };
    render(<DiffDataHarness {...props} fileProvider={makeProvider(true)} />);
    await flushMicrotasks();
    const first = state?.resolvedByPath[paths[0]];
    expect(first?.status).toBe('ready-parsed');
    act(() => root!.unmount());
    root = null;
    container?.remove();
    container = null;
    retired = true;
    render(<DiffDataHarness {...props} fileProvider={makeProvider(false)} />);
    await flushMicrotasks();
    const current = state?.resolvedByPath[paths[0]];
    expect(current).not.toBe(first);
    if (current?.status !== 'ready-parsed' || !current.loadDiffFiles)
      throw new Error('Expected current loader.');
    expect(await current.loadDiffFiles(current.fileDiff)).toMatchObject({
      newFile: { contents: 'after\n' },
    });
  });
  it('keeps a legacy daemon result completed during scrolling instead of restarting it', async () => {
    const held = createDeferred<unknown>();
    const negotiated = createDeferred<{ supported: boolean; scope: string; persist: boolean }>();
    let opened = 0;
    const provider = new CodeCollabSessionFileProvider({
      runtime: {
        sessionId: 'session-1' as SessionId,
        diffBlobTransportOptions: () => negotiated.promise,
        openDiffManifest: async () => {
          throw new Error('Legacy manifest called.');
        },
        readDiffBlob: async () => {
          throw new Error('Legacy blob called.');
        },
        openCurrentDiff: async () => {
          opened++;
          return held.promise;
        },
      } as unknown as CodeCollabSessionFileProviderRuntime,
    });
    let state: ReturnType<typeof useSessionConversationDiffData> | undefined;
    const onUpdate = (next: ReturnType<typeof useSessionConversationDiffData>) => {
      state = next;
    };
    render(<DiffDataHarness fileProvider={provider} onUpdate={onUpdate} />);
    await flushMicrotasks();
    expect(provider.supportsCancellableDiffReads).toBe(true);
    rerender(<DiffDataHarness fileProvider={provider} loadPaused onUpdate={onUpdate} />);
    await flushMicrotasks();
    negotiated.resolve({ supported: false, scope: 'synthetic', persist: false });
    await flushMicrotasks();
    expect(provider.supportsCancellableDiffReads).toBe(false);
    held.resolve({
      status: 'ok',
      path: 'README.md',
      oldSnapshot: { kind: 'text', text: { encoding: 'plain', text: 'old\n', rawBytes: 4 } },
      newSnapshot: { kind: 'text', text: { encoding: 'plain', text: 'new\n', rawBytes: 4 } },
      add: 1,
      del: 1,
    });
    await flushMicrotasks();
    expect(state?.resolvedByPath['README.md']).toMatchObject({
      status: 'ready',
      newSnapshot: { text: 'new\n' },
    });
    rerender(<DiffDataHarness fileProvider={provider} onUpdate={onUpdate} />);
    await flushMicrotasks();
    expect(state?.resolvedByPath['README.md']).toMatchObject({
      status: 'ready',
      newSnapshot: { text: 'new\n' },
    });
    expect(opened).toBe(1);
  });

  it('cancels hidden page sequences without publishing their late result and permits reopening', async () => {
    const held = createDeferred<Awaited<ReturnType<SessionFileProvider['getDiff']>>>();
    let signal: AbortSignal | undefined;
    const provider = {
      ...createDiffProvider(async (_path, _turn, _file, options) => {
        signal = options?.signal;
        return held.promise;
      }),
      supportsCancellableDiffReads: true,
    };
    let state: ReturnType<typeof useSessionConversationDiffData> | undefined;
    const onUpdate = (next: ReturnType<typeof useSessionConversationDiffData>) => {
      state = next;
    };
    render(<DiffDataHarness fileProvider={provider} enabled onUpdate={onUpdate} />);
    await flushMicrotasks();
    expect(signal?.aborted).toBe(false);
    rerender(<DiffDataHarness fileProvider={provider} enabled={false} onUpdate={onUpdate} />);
    await flushMicrotasks();
    expect(signal?.aborted).toBe(true);
    held.resolve({
      status: 'ready',
      path: 'README.md',
      oldSnapshot: { kind: 'text', text: 'old' },
      newSnapshot: { kind: 'text', text: 'late' },
    });
    await flushMicrotasks();
    expect(state?.resolvedByPath['README.md']).toBeUndefined();
    const recovered = createDiffProvider(async (path) => ({
      status: 'ready',
      path,
      oldSnapshot: { kind: 'text', text: 'old' },
      newSnapshot: { kind: 'text', text: 'reopened' },
    }));
    rerender(<DiffDataHarness fileProvider={recovered} enabled onUpdate={onUpdate} />);
    await flushMicrotasks();
    expect(state?.resolvedByPath['README.md']).toMatchObject({
      status: 'ready',
      newSnapshot: { text: 'reopened' },
    });
  });

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
    expect(state?.normalizedPaths).toEqual(['deferred.ts', 'inline.ts']);
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
    const paths = ['stale-index.ts'];
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
    expect(state?.normalizedPaths).toEqual(['committed.ts', 'worktree.ts']);

    rerender(<Harness scope="uncommitted" />);
    await flushMicrotasks();
    expect(state?.base).toBe('head');
    expect(state?.normalizedPaths).toEqual(['worktree.ts']);
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
  enabled = true,
  mode = 'base',
  filePaths = README_PATHS,
  loadFilePaths = README_PATHS,
  priorityFilePath = 'README.md',
  loadPaused = false,
  fileDiffs,
  allChangesScope,
  onUpdate,
}: {
  readonly fileProvider: SessionFileProvider;
  readonly enabled?: boolean;
  readonly loadPaused?: boolean;
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
    loadPaused,
    priorityFilePath,
    fileDiffs,
    fileProvider,
    allChangesScope,
    enabled,
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
