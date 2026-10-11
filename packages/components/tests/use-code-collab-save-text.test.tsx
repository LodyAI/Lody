// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SaveTextConflictError,
  useCodeCollabSaveText,
  type UseCodeCollabSaveTextResult,
} from '../src/hooks/use-code-collab-save-text';
import type { SessionFileOpenResult, SessionFileProvider } from '../src/lib/session-file-provider';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

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

describe('useCodeCollabSaveText', () => {
  it('clears pending edits and leave protection on undo, and restores both on redo', async () => {
    let disk = 'A';
    const provider = createProvider(async (_id, text) => {
      disk = text;
      return readyResult(text);
    });
    const hook = mountSaveHook(provider);
    act(() => hook.current.onExternalTextApplied('A'));
    act(() => hook.current.onContentChange('B'));
    expect(hook.current.status.kind).toBe('pending');
    expect(unloadProtected()).toBe(true);
    act(() => hook.current.onContentChange('A'));
    expect(hook.current.status.kind).toBe('idle');
    expect(unloadProtected()).toBe(false);
    await act(async () => hook.current.flush());
    expect(disk).toBe('A');
    act(() => hook.current.onContentChange('B'));
    expect(hook.current.status.kind).toBe('pending');
    expect(unloadProtected()).toBe(true);
    await act(async () => hook.current.flush());
    expect(disk).toBe('B');
    expect(unloadProtected()).toBe(false);
    act(() => hook.current.onContentChange('A'));
    expect(hook.current.status.kind).toBe('pending');
    act(() => hook.current.onContentChange('B'));
    expect(hook.current.status.kind).toBe('idle');
  });

  it.each(['success', 'failure'] as const)(
    'retains undo to the old baseline while a save ends in %s',
    async (outcome) => {
      let disk = 'A';
      const saving = createDeferred<SessionFileOpenResult>();
      const provider = createProvider(async (_id, text) => {
        if (text === 'B') {
          const result = await saving.promise;
          disk = text;
          return result;
        }
        disk = text;
        return readyResult(text);
      });
      const hook = mountSaveHook(provider);
      act(() => hook.current.onExternalTextApplied('A'));
      act(() => hook.current.onContentChange('B'));
      let flush!: Promise<void>;
      await act(async () => {
        flush = hook.current.flush();
        await flushMicrotasks();
      });
      act(() => hook.current.onContentChange('A'));
      expect(unloadProtected()).toBe(true);
      await act(async () => {
        if (outcome === 'success') saving.resolve(readyResult('B'));
        else saving.reject(new Error('disk denied'));
        await flush;
      });
      expect(disk).toBe('A');
      expect(hook.current.status.kind).toBe(outcome === 'success' ? 'saved' : 'pending');
      if (outcome === 'failure') {
        expect(unloadProtected()).toBe(true);
        await act(async () => hook.current.flush());
      }
      expect(unloadProtected()).toBe(false);
    }
  );

  it('coalesces edits that return to the text being saved', async () => {
    let disk = 'A';
    const saving = createDeferred<SessionFileOpenResult>();
    const provider = createProvider(async (_id, text) => {
      const result = await saving.promise;
      disk = text;
      return result;
    });
    const hook = mountSaveHook(provider);
    act(() => hook.current.onExternalTextApplied('A'));
    act(() => hook.current.onContentChange('B'));
    let flush!: Promise<void>;
    await act(async () => {
      flush = hook.current.flush();
      await flushMicrotasks();
    });
    act(() => {
      hook.current.onContentChange('C');
      hook.current.onContentChange('B');
    });
    await act(async () => {
      saving.resolve(readyResult('B'));
      await flush;
    });
    expect(disk).toBe('B');
    expect(hook.current.status.kind).toBe('saved');
    expect(unloadProtected()).toBe(false);
  });

  it('does not advance the baseline or release protection after a failed save', async () => {
    let disk = 'A';
    let denySave = true;
    const provider = createProvider(async (_id, text) => {
      if (denySave) throw new Error('disk denied');
      disk = text;
      return readyResult(text);
    });
    const hook = mountSaveHook(provider);
    act(() => hook.current.onExternalTextApplied('A'));
    act(() => hook.current.onContentChange('B'));
    await act(async () => hook.current.flush());
    expect(hook.current.status.kind).toBe('error');
    expect(disk).toBe('A');
    expect(unloadProtected()).toBe(true);
    act(() => hook.current.onContentChange('A'));
    expect(hook.current.status.kind).toBe('idle');
    expect(unloadProtected()).toBe(false);
    act(() => hook.current.onContentChange('B'));
    expect(hook.current.status.kind).toBe('pending');
    denySave = false;
    await act(async () => hook.current.flush());
    expect(disk).toBe('B');
    expect(unloadProtected()).toBe(false);
  });

  it.each(['external', 'file-switch'] as const)(
    'ignores an old save completion after %s establishes a new baseline',
    async (change) => {
      const saving = createDeferred<SessionFileOpenResult>();
      const provider = createProvider(() => saving.promise);
      const hook = mountSaveHook(provider);
      act(() => hook.current.onExternalTextApplied('A'));
      act(() => hook.current.onContentChange('B'));
      let flush!: Promise<void>;
      await act(async () => {
        flush = hook.current.flush();
        await flushMicrotasks();
      });
      if (change === 'file-switch') {
        hook.render('t:file-2');
        hook.render('t:file-1');
      }
      act(() => hook.current.onExternalTextApplied('C'));
      await act(async () => {
        saving.resolve(readyResult('B'));
        await flush;
      });
      act(() => hook.current.onContentChange('B'));
      expect(hook.current.status.kind).toBe('pending');
      act(() => hook.current.onContentChange('C'));
      expect(hook.current.status.kind).toBe('idle');
      expect(unloadProtected()).toBe(false);
    }
  );

  it('keeps conflicts protected when undo matches a stale baseline', async () => {
    const provider = createProvider(async () => {
      throw new SaveTextConflictError('disk_changed', 'conflict-1');
    });
    const hook = mountSaveHook(provider);
    act(() => hook.current.onExternalTextApplied('A'));
    act(() => hook.current.onContentChange('B'));
    act(() => hook.current.markConflictPending());
    act(() => hook.current.onContentChange('A'));
    expect(hook.current.status.kind).toBe('conflict_pending');
    expect(unloadProtected()).toBe(true);
    await act(async () => hook.current.flush());
    act(() => hook.current.onContentChange('A'));
    expect(hook.current.status.kind).toBe('conflict');
    expect(unloadProtected()).toBe(true);
    act(() => hook.current.onExternalTextApplied('C'));
    act(() => hook.current.onContentChange('A'));
    expect(hook.current.status.kind).toBe('pending');
    act(() => hook.current.onContentChange('C'));
    expect(unloadProtected()).toBe(false);
  });

  it('preserves newer drafts while overriding a conflict and uses the resolved text as baseline', async () => {
    let disk = 'external';
    let conflict = true;
    const resolving = createDeferred<void>();
    const provider = createProvider(
      async (_id, text) => {
        if (conflict) throw new SaveTextConflictError('disk_changed', 'conflict-1');
        disk = text;
        return readyResult(text);
      },
      {
        resolveSaveConflict: async () => {
          await resolving.promise;
          disk = 'B';
          conflict = false;
        },
      }
    );
    const hook = mountSaveHook(provider);
    act(() => hook.current.onExternalTextApplied('A'));
    act(() => hook.current.onContentChange('B'));
    await act(async () => hook.current.flush());
    let resolve!: Promise<void>;
    await act(async () => {
      resolve = hook.current.resolveConflict('override');
      await flushMicrotasks();
    });
    act(() => hook.current.onContentChange('C'));
    await act(async () => {
      resolving.resolve();
      await resolve;
    });
    expect(disk).toBe('B');
    expect(hook.current.status.kind).toBe('pending');
    expect(unloadProtected()).toBe(true);
    act(() => hook.current.onContentChange('B'));
    expect(hook.current.status.kind).toBe('idle');
    act(() => hook.current.onContentChange('C'));
    await act(async () => hook.current.flush());
    expect(disk).toBe('C');
    expect(unloadProtected()).toBe(false);
  });

  it('keeps edits dirty in memory until flush explicitly saves them', async () => {
    vi.useFakeTimers();
    const saveText = vi.fn(async (_pathOrFileId: string, text: string) => readyResult(text));
    const provider = createProvider(saveText);
    let hook: UseCodeCollabSaveTextResult | undefined;

    render(
      <SaveTextHarness
        provider={provider}
        onReady={(value) => {
          hook = value;
        }}
      />
    );

    act(() => {
      hook?.onContentChange('draft');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(saveText).not.toHaveBeenCalled();
    expect(hook?.status.kind).toBe('pending');

    await act(async () => {
      await hook?.flush();
    });
    expect(saveText).toHaveBeenCalledTimes(1);
    expect(saveText).toHaveBeenLastCalledWith('t:file-1', 'draft');
    expect(hook?.status.kind).toBe('saved');
  });

  it('flush waits for an in-flight explicit save before saving newer pending text', async () => {
    const firstSave = createDeferred<SessionFileOpenResult>();
    const secondSave = createDeferred<SessionFileOpenResult>();
    const saveText = vi.fn((pathOrFileId: string, text: string) => {
      if (text === 'first') return firstSave.promise;
      if (text === 'second') return secondSave.promise;
      throw new Error(`unexpected save ${pathOrFileId}: ${text}`);
    });
    const provider = createProvider(saveText);
    let hook: UseCodeCollabSaveTextResult | undefined;

    render(
      <SaveTextHarness
        provider={provider}
        onReady={(value) => {
          hook = value;
        }}
      />
    );

    act(() => {
      hook?.onContentChange('first');
    });
    let firstFlush: Promise<void> | undefined;
    await act(async () => {
      firstFlush = hook?.flush();
      await flushMicrotasks();
    });
    expect(saveText).toHaveBeenCalledTimes(1);
    expect(saveText).toHaveBeenLastCalledWith('t:file-1', 'first');

    act(() => {
      hook?.onContentChange('second');
    });
    let secondFlush: Promise<void> | undefined;
    await act(async () => {
      secondFlush = hook?.flush();
      await flushMicrotasks();
    });
    expect(saveText).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstSave.resolve(readyResult('first'));
      await flushMicrotasks();
    });
    expect(saveText).toHaveBeenCalledTimes(2);
    expect(saveText).toHaveBeenLastCalledWith('t:file-1', 'second');

    await act(async () => {
      secondSave.resolve(readyResult('second'));
      await firstFlush;
      await secondFlush;
    });
    expect(hook?.status.kind).toBe('saved');
  });

  it('does not save pending text when switching files or unmounting', async () => {
    vi.useFakeTimers();
    const saveText = vi.fn(async (_pathOrFileId: string, text: string) => readyResult(text));
    const provider = createProvider(saveText);
    let hook: UseCodeCollabSaveTextResult | undefined;

    render(
      <SaveTextHarness
        provider={provider}
        fileId="t:file-1"
        onReady={(value) => {
          hook = value;
        }}
      />
    );
    act(() => {
      hook?.onContentChange('old file draft');
    });

    render(
      <SaveTextHarness
        provider={provider}
        fileId="t:file-2"
        onReady={(value) => {
          hook = value;
        }}
      />
    );
    act(() => {
      root?.unmount();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(saveText).not.toHaveBeenCalled();
  });

  it('warns before unloading while edits are dirty', () => {
    const saveText = vi.fn(async (_pathOrFileId: string, text: string) => readyResult(text));
    const provider = createProvider(saveText);
    let hook: UseCodeCollabSaveTextResult | undefined;

    render(
      <SaveTextHarness
        provider={provider}
        onReady={(value) => {
          hook = value;
        }}
      />
    );

    act(() => {
      hook?.onContentChange('draft');
    });
    const event = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it('keeps failed saves dirty and lets the next explicit flush retry', async () => {
    const saveText = vi
      .fn<SessionFileProvider['saveText']>()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce(readyResult('draft'));
    const provider = createProvider(saveText);
    let hook: UseCodeCollabSaveTextResult | undefined;

    render(
      <SaveTextHarness
        provider={provider}
        onReady={(value) => {
          hook = value;
        }}
      />
    );

    act(() => {
      hook?.onContentChange('draft');
    });
    await act(async () => {
      await hook?.flush();
    });
    expect(hook?.status.kind).toBe('error');

    await act(async () => {
      await hook?.flush();
    });
    expect(saveText).toHaveBeenCalledTimes(2);
    expect(hook?.status.kind).toBe('saved');
  });

  it('resolves save conflicts with the host conflict id', async () => {
    const saveText = vi.fn(async () => {
      throw new SaveTextConflictError('disk_changed', 'conflict-1', 'save_conflict: disk_changed');
    });
    const resolveSaveConflict = vi.fn(async () => {});
    const provider = createProvider(saveText, { resolveSaveConflict });
    let hook: UseCodeCollabSaveTextResult | undefined;

    render(
      <SaveTextHarness
        provider={provider}
        onReady={(value) => {
          hook = value;
        }}
      />
    );

    act(() => {
      hook?.onContentChange('draft');
    });
    await act(async () => {
      await hook?.flush();
    });
    expect(hook?.status).toMatchObject({
      kind: 'conflict',
      conflict: 'disk_changed',
      conflictId: 'conflict-1',
    });

    await act(async () => {
      await hook?.resolveConflict('override');
    });
    expect(resolveSaveConflict).toHaveBeenCalledWith('t:file-1', {
      conflictId: 'conflict-1',
      resolution: 'override',
    });
    expect(hook?.status.kind).toBe('saved');
  });

  it('keeps the editor pending after loading conflict markers', async () => {
    const saveText = vi.fn(async () => {
      throw new SaveTextConflictError('disk_changed', 'conflict-1', 'save_conflict: disk_changed');
    });
    const resolveSaveConflict = vi.fn(async () => {});
    const provider = createProvider(saveText, { resolveSaveConflict });
    let hook: UseCodeCollabSaveTextResult | undefined;

    render(
      <SaveTextHarness
        provider={provider}
        onReady={(value) => {
          hook = value;
        }}
      />
    );

    act(() => {
      hook?.onContentChange('draft');
    });
    await act(async () => {
      await hook?.flush();
    });

    await act(async () => {
      await hook?.resolveConflict('load_with_conflicts');
    });
    expect(resolveSaveConflict).toHaveBeenCalledWith('t:file-1', {
      conflictId: 'conflict-1',
      resolution: 'load_with_conflicts',
    });
    expect(hook?.status.kind).toBe('pending');
  });
});

function SaveTextHarness(input: {
  readonly provider: SessionFileProvider;
  readonly fileId?: string;
  readonly enabled?: boolean;
  readonly onReady: (value: UseCodeCollabSaveTextResult) => void;
}): null {
  const hook = useCodeCollabSaveText({
    provider: input.provider,
    fileId: input.fileId ?? 't:file-1',
    enabled: input.enabled ?? true,
  });
  input.onReady(hook);
  return null;
}

function render(node: ReactNode): void {
  if (!container) {
    container = document.createElement('div');
    document.body.appendChild(container);
  }
  if (!root) {
    root = createRoot(container);
  }
  act(() => {
    root?.render(node);
  });
}

function createProvider(
  saveText: SessionFileProvider['saveText'],
  options: {
    readonly resolveSaveConflict?: SessionFileProvider['resolveSaveConflict'];
  } = {}
): SessionFileProvider {
  return {
    kind: 'code-collab',
    getState: () => ({ kind: 'code-collab', ready: true, sourceState: 'live-collaborative' }),
    listFiles: async () => [],
    searchFiles: async () => [],
    getFile: async () => null,
    openFile: async () => readyResult(''),
    saveText,
    ...(options.resolveSaveConflict === undefined
      ? {}
      : { resolveSaveConflict: options.resolveSaveConflict }),
    getDiff: async () => ({
      status: 'unavailable',
      path: 't:file-1',
      reason: 'metadata-only',
    }),
    listChangedFiles: async () => ({ status: 'ready', files: [] }),
  };
}

function readyResult(text: string): SessionFileOpenResult {
  return {
    status: 'ready',
    entry: {
      fileId: 't:file-1',
      path: 'README.md',
      kind: 'text',
      sourceState: 'live-collaborative',
    },
    snapshot: { kind: 'text', text },
  };
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function unloadProtected(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

function mountSaveHook(provider: SessionFileProvider) {
  let current!: UseCodeCollabSaveTextResult;
  const harness = {
    get current() {
      return current;
    },
    render(fileId = 't:file-1') {
      render(
        <SaveTextHarness
          provider={provider}
          fileId={fileId}
          onReady={(value) => {
            current = value;
          }}
        />
      );
    },
  };
  harness.render();
  return harness;
}
