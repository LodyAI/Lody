// @vitest-environment jsdom

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  type CodeCollabV2FileDigest,
  type CodeCollabV2OpenTextOk,
  type CodeCollabV2RefreshTextResponse,
  type CodeCollabV2SaveTextResponse,
  type FilePreviewV3Response,
  getLodyMachinePresenceKey,
  getMachineRoomId,
  getServerNow,
  type LodyPresenceInstanceId,
  type MachineId,
  type MachineMeta,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Provider, createStore } from 'jotai';
import {
  SessionFileContentView,
  type SessionFileSaveViewState,
} from '../src/components/sessions/session-file-content-view';
import { createFakeSessionFileProvider } from '../src/lib/session-file-provider';
import {
  CodeCollabSessionFileProvider,
  createCodeCollabSessionFileProviderTextState,
  type CodeCollabSessionFileProviderRuntime,
} from '../src/lib/code-collab-session-file-provider';
import { machineMetaCacheAtom } from '../src/atoms/doc-meta';
import { lodyPresenceStatesAtom, lodyPresenceSyncStateAtom } from '../src/atoms/presence';
import { localProbeResultAtom } from '../src/atoms/local-probe';
import { SaveTextConflictError } from '../src/hooks/use-code-collab-save-text';
import { TooltipProvider } from '../src/ui/tooltip';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, defaultValue?: string) => defaultValue ?? _key,
    i18n: {
      language: 'en',
      resolvedLanguage: 'en',
      changeLanguage: () => Promise.resolve(),
    },
  }),
}));

const monacoMockState = vi.hoisted(() => ({
  mountCount: 0,
  unmountCount: 0,
  emitInitialContentChange: false,
  onContentChange: undefined as ((text: string) => void) | undefined,
  readOnly: undefined as boolean | undefined,
}));

vi.mock('../src/components/sessions/session-monaco-text-viewer', async () => {
  const React = await import('react');
  return {
    SessionMonacoTextViewer: (props: {
      readonly text: string;
      readonly onContentChange?: (text: string) => void;
      readonly readOnly?: boolean;
    }) => {
      monacoMockState.onContentChange = props.onContentChange;
      monacoMockState.readOnly = props.readOnly;
      React.useEffect(() => {
        monacoMockState.mountCount += 1;
        if (monacoMockState.emitInitialContentChange) {
          props.onContentChange?.(props.text);
        }
        return () => {
          monacoMockState.unmountCount += 1;
        };
        // This mock models Monaco's mount lifecycle. Tests toggle the
        // initial emission flag to catch accidental open-as-edit saves.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return React.createElement('div', {
        'data-testid': 'monaco-viewer',
        'data-text': props.text,
      });
    },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom does not implement object URLs; stub them for the image preview path.
let objectUrlSeq = 0;
if (typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = () => `blob:mock/${(objectUrlSeq += 1)}`;
}
if (typeof URL.revokeObjectURL !== 'function') {
  URL.revokeObjectURL = () => undefined;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let currentStore: ReturnType<typeof createStore> | null = null;

afterEach(() => {
  if (root && container) {
    act(() => {
      root?.unmount();
    });
  }
  root = null;
  currentStore = null;
  container?.remove();
  container = null;
  monacoMockState.mountCount = 0;
  monacoMockState.unmountCount = 0;
  monacoMockState.emitInitialContentChange = false;
  monacoMockState.onContentChange = undefined;
  monacoMockState.readOnly = undefined;
  sharedCodeCollabTextState = createCodeCollabSessionFileProviderTextState();
  delete window.__LODY_ELECTRON__;
  delete window.api;
  vi.useRealTimers();
});

type RenderOptions = {
  /** Machine liveness comes from ephemeral presence. Defaults to online. */
  readonly machineOnline?: boolean;
  readonly localMachine?: boolean;
};

function createMachineMeta(): MachineMeta {
  return {
    id: session.machineId,
    name: 'Test machine',
    cliVersion: '0.56.0',
    os: 'macOS',
    sessions: [],
    raceLimits: {},
    needToArchiveSessions: {},
    needToDeleteSessions: {},
  };
}

async function render(node: ReactNode, options: RenderOptions = {}): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const store = createStore();
  currentStore = store;
  store.set(machineMetaCacheAtom, {
    [getMachineRoomId(session.machineId)]: createMachineMeta(),
  });
  store.set(lodyPresenceSyncStateAtom, 'synced');
  if (options.localMachine === true) {
    store.set(localProbeResultAtom, { ok: true, machineId: session.machineId });
  }
  if (options.machineOnline ?? true) {
    store.set(lodyPresenceStatesAtom, {
      [getLodyMachinePresenceKey(session.machineId, 'test-instance' as LodyPresenceInstanceId)]: {
        kind: 'machine',
        machineId: session.machineId,
        instanceId: 'test-instance' as LodyPresenceInstanceId,
        updatedAt: getServerNow(),
      },
    });
  }
  await act(async () => {
    root?.render(createElement(Provider, { store }, createElement(TooltipProvider, null, node)));
  });
  return container;
}

async function rerender(node: ReactNode): Promise<void> {
  if (!currentStore) {
    throw new Error('Test render store is not initialized.');
  }
  await act(async () => {
    root?.render(
      createElement(Provider, { store: currentStore }, createElement(TooltipProvider, null, node))
    );
  });
}

async function flushMicrotasks(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function waitForRealTimer(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function clickSave(view: HTMLElement): Promise<void> {
  const saveButton = view.querySelector('button[aria-label="Save"]') as HTMLButtonElement | null;
  expect(saveButton).not.toBeNull();
  await act(async () => {
    saveButton?.click();
    await Promise.resolve();
  });
}

const session = {
  id: 'session-file-content-view-test' as SessionId,
  machineId: 'machine-1' as MachineId,
  userId: 'user-1',
  title: 'Session file content view test',
  status: { type: 'running' },
  createdAt: '2026-05-20T00:00:00.000Z',
  cliType: 'codex',
  agentType: 'codex',
} satisfies SessionMeta;

const DIGEST_1 = `sha256:${'1'.repeat(64)}` as CodeCollabV2FileDigest;
const DIGEST_2 = `sha256:${'2'.repeat(64)}` as CodeCollabV2FileDigest;

function codeCollabTextResult(
  status: 'ok' | 'updated',
  text: string,
  digest: CodeCollabV2FileDigest
): CodeCollabV2OpenTextOk | Extract<CodeCollabV2RefreshTextResponse, { status: 'updated' }> {
  return {
    status,
    path: 'src/live.ts',
    digest,
    text: {
      encoding: 'plain',
      text,
      rawBytes: new TextEncoder().encode(text).byteLength,
    },
    format: {
      encoding: 'utf8',
      eol: 'lf',
    },
  };
}

function filePreviewResult(
  text: string,
  digest: CodeCollabV2FileDigest
): FilePreviewV3Response {
  return {
    status: 'ok',
    v: 3,
    path: 'src/live.ts',
    digest,
    kind: 'text',
    content: {
      encoding: 'utf8-plain',
      text,
      rawBytes: new TextEncoder().encode(text).byteLength,
    },
    format: { eol: 'lf' },
    sizeBytes: new TextEncoder().encode(text).byteLength,
  };
}

function createCodeCollabRuntime(
  overrides: Partial<CodeCollabSessionFileProviderRuntime> = {}
): CodeCollabSessionFileProviderRuntime {
  return {
    sessionId: session.id,
    previewFile: vi.fn(async (path: string, knownDigest?: string) =>
      knownDigest === DIGEST_1
        ? ({
            status: 'unchanged',
            v: 3,
            path,
            digest: DIGEST_1,
            sizeBytes: 14,
          } satisfies FilePreviewV3Response)
        : filePreviewResult('let value = 1;', DIGEST_1)
    ),
    openText: vi.fn(async () => codeCollabTextResult('ok', 'let value = 1;', DIGEST_1)),
    refreshText: vi.fn(async () => ({
      status: 'up_to_date',
      path: 'src/live.ts',
      digest: DIGEST_1,
    })),
    saveText: vi.fn(async () => ({
      status: 'ok',
      path: 'src/live.ts',
      digest: DIGEST_2,
      rawBytes: 0,
    })),
    openCurrentDiff: vi.fn(async () => ({
      status: 'unavailable',
      path: 'src/live.ts',
      reason: 'base_unavailable',
    })),
    openTurnDiff: vi.fn(async (_path, turnId) => ({
      status: 'unavailable',
      path: 'src/live.ts',
      turnId,
      reason: 'turn_unavailable',
    })),
    lspDefinition: vi.fn(async () => ({ status: 'unsupported', code: 'lsp_not_wired' })),
    lspReferences: vi.fn(async () => ({ status: 'unsupported', code: 'lsp_not_wired' })),
    ...overrides,
  };
}

function createCodeCollabProvider(runtime: CodeCollabSessionFileProviderRuntime) {
  return new CodeCollabSessionFileProvider({
    runtime,
    role: 'write',
    fileTree: { 'src/live.ts': true },
    textState: sharedCodeCollabTextState,
  });
}

let sharedCodeCollabTextState = createCodeCollabSessionFileProviderTextState();

function createEditableProvider() {
  return createFakeSessionFileProvider({
    files: [
      {
        path: 'src/live.ts',
        fileId: 't:live',
        kind: 'text',
        sourceState: 'live-collaborative',
      },
    ],
    snapshots: {
      'src/live.ts': { kind: 'text', text: 'let value = 1;' },
    },
  });
}

async function renderEditableProviderFile(
  provider = createEditableProvider(),
  options: RenderOptions = {}
): Promise<HTMLDivElement> {
  const view = await render(
    createElement(SessionFileContentView, {
      sessionId: session.id,
      session,
      filePath: 'src/live.ts',
      fileId: 't:live',
      fileProvider: provider,
      fileProviderPending: false,
      fileProviderRole: 'write',
      active: true,
    }),
    options
  );
  await flushMicrotasks();
  return view;
}

async function renderCodeCollabProviderFile(
  provider: CodeCollabSessionFileProvider,
  options: RenderOptions = {}
): Promise<HTMLDivElement> {
  const view = await render(
    createElement(SessionFileContentView, {
      sessionId: session.id,
      session,
      filePath: 'src/live.ts',
      fileId: 'src/live.ts',
      fileProvider: provider,
      fileProviderPending: false,
      fileProviderRole: 'write',
      active: true,
    }),
    options
  );
  await flushMicrotasks();
  return view;
}

describe('SessionFileContentView', () => {
  it('falls back to an idle same-machine github worktree when Code Collab is unavailable', async () => {
    const readSessionWorktreeFile = vi.fn(async () => ({
      path: 'README.md',
      content: '# Local worktree',
      truncated: false,
    }));
    Object.defineProperty(window, '__LODY_ELECTRON__', {
      configurable: true,
      value: true,
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { readSessionWorktreeFile },
    });
    const githubSession = {
      ...session,
      status: { type: 'idle' },
      project: {
        kind: 'github',
        repoFullName: 'loro-dev/lody',
        branch: 'main',
      },
    } satisfies SessionMeta;

    const view = await render(
      createElement(SessionFileContentView, {
        sessionId: githubSession.id,
        session: githubSession,
        filePath: 'README.md',
        fileProvider: null,
        fileProviderPending: false,
        active: true,
      }),
      { localMachine: true }
    );
    await flushMicrotasks();

    expect(readSessionWorktreeFile).toHaveBeenCalledWith(
      'loro-dev/lody',
      githubSession.id,
      'README.md'
    );
    expect(view.textContent).toContain('Local worktree');
    expect(view.querySelector('[data-testid="monaco-viewer"]')).toBeNull();
    expect(view.textContent).not.toContain('Local project is unavailable');
  });

  it('renders opened provider files without duplicate top titles or provider strip text', async () => {
    const view = await renderEditableProviderFile();
    const statusBar = view.querySelector('[data-testid="session-file-realtime-status-bar"]');

    // A freshly opened collab file has never been saved, so it shows no
    // misleading "Saved" status. With nothing else to surface (machine
    // online, idle live sync, no SVG toggle) the status bar collapses away.
    expect(statusBar).toBeNull();
    expect(view.textContent).not.toContain('Saved');
    expect(view.textContent).not.toContain('Host online');
    expect(view.textContent).not.toContain('Host connecting');
    expect(view.textContent).not.toContain('Host offline');
    expect(view.textContent).not.toContain('Code Collab');
    expect(view.textContent).not.toContain('Live');
    expect(view.textContent).not.toContain('src/live.ts');
  });

  it('does not show host connecting while the provider is pending', async () => {
    const view = await render(
      createElement(SessionFileContentView, {
        sessionId: session.id,
        session,
        filePath: 'src/live.ts',
        fileProviderPending: true,
        active: true,
      })
    );
    await flushMicrotasks();

    expect(view.textContent).not.toContain('Host connecting');
    expect(view.textContent).not.toContain('Host online');
    expect(view.textContent).not.toContain('Code Collab');
  });

  it('shows machine offline icon from session machine presence', async () => {
    const view = await renderEditableProviderFile(createEditableProvider(), {
      machineOnline: false,
    });
    const statusBar = view.querySelector('[data-testid="session-file-realtime-status-bar"]');
    const offlineIcon = statusBar?.querySelector('svg');

    expect(offlineIcon).not.toBeNull();
    expect(offlineIcon?.className.baseVal).toContain('text-muted-foreground');
    expect(view.textContent).not.toContain('Host offline');
    // Freshly opened: the offline icon shows, but no misleading "Saved".
    expect(view.textContent).not.toContain('Saved');
  });

  it('shows unsaved dirty state without live sync in the bottom status bar', async () => {
    vi.useFakeTimers();
    const provider = createEditableProvider();
    provider.updateLiveText = vi.fn(() => new Promise<void>(() => undefined));
    const view = await renderEditableProviderFile(provider);

    await act(async () => {
      monacoMockState.onContentChange?.('let value = 2;');
    });
    await act(async () => {
      vi.advanceTimersByTime(8);
      await Promise.resolve();
    });

    expect(view.textContent).toContain('Unsaved');
    expect(view.textContent).not.toContain('Syncing live');
    expect(provider.updateLiveText).not.toHaveBeenCalled();
  });

  it('reports save state changes for the parent tab shell', async () => {
    const stateChanges: SessionFileSaveViewState[] = [];
    const view = await render(
      createElement(SessionFileContentView, {
        sessionId: session.id,
        session,
        filePath: 'src/live.ts',
        fileId: 't:live',
        fileProvider: createEditableProvider(),
        fileProviderPending: false,
        fileProviderRole: 'write',
        active: true,
        onSaveStateChange: (state) => stateChanges.push(state),
      })
    );
    await flushMicrotasks();

    expect(stateChanges.at(-1)).toMatchObject({ dirty: false, canSave: false });

    await act(async () => {
      monacoMockState.onContentChange?.('let value = 2;');
    });
    await flushMicrotasks();

    expect(view.textContent).toContain('Unsaved');
    expect(stateChanges.at(-1)).toMatchObject({
      dirty: true,
      canSave: true,
      saving: false,
      conflict: false,
      error: false,
    });
  });

  it('saves the editable provider text when the parent increments saveRequestSeq', async () => {
    const provider = createEditableProvider();
    const saveText = vi.spyOn(provider, 'saveText');

    await render(
      createElement(SessionFileContentView, {
        sessionId: session.id,
        session,
        filePath: 'src/live.ts',
        fileId: 't:live',
        fileProvider: provider,
        fileProviderPending: false,
        fileProviderRole: 'write',
        active: true,
        saveRequestSeq: 0,
      })
    );
    await flushMicrotasks();

    await act(async () => {
      monacoMockState.onContentChange?.('let value = 2;');
    });
    await rerender(
      createElement(SessionFileContentView, {
        sessionId: session.id,
        session,
        filePath: 'src/live.ts',
        fileId: 't:live',
        fileProvider: provider,
        fileProviderPending: false,
        fileProviderRole: 'write',
        active: true,
        saveRequestSeq: 1,
      })
    );
    await flushMicrotasks();

    expect(saveText).toHaveBeenCalledWith('t:live', 'let value = 2;');
  });

  it('does not replace dirty provider text or save base digest after provider rebuild', async () => {
    const firstRuntime = createCodeCollabRuntime();
    const saveText = vi
      .fn<CodeCollabSessionFileProviderRuntime['saveText']>()
      .mockResolvedValueOnce({
        status: 'ok',
        path: 'src/live.ts',
        digest: `sha256:${'3'.repeat(64)}` as CodeCollabV2FileDigest,
        rawBytes: 15,
      } satisfies CodeCollabV2SaveTextResponse);
    const secondRuntime = createCodeCollabRuntime({
      refreshText: vi.fn(async () => codeCollabTextResult('updated', 'let value = 2;', DIGEST_2)),
      saveText,
    });
    const firstProvider = createCodeCollabProvider(firstRuntime);
    const secondProvider = createCodeCollabProvider(secondRuntime);
    const view = await renderCodeCollabProviderFile(firstProvider);

    await act(async () => {
      monacoMockState.onContentChange?.('let value = 10;');
    });
    expect(view.textContent).toContain('Unsaved');
    await rerender(
      createElement(SessionFileContentView, {
        sessionId: session.id,
        session,
        filePath: 'src/live.ts',
        fileId: 'src/live.ts',
        fileProvider: secondProvider,
        fileProviderPending: false,
        fileProviderRole: 'write',
        active: true,
      })
    );
    await flushMicrotasks();

    // A dirty editor must not be re-read at all; only the change check runs.
    expect(secondRuntime.previewFile).not.toHaveBeenCalled();
    expect(secondRuntime.refreshText).toHaveBeenCalledWith('src/live.ts', DIGEST_1);
    expect(view.textContent).toContain('External change detected');

    await clickSave(view);
    await flushMicrotasks();

    expect(saveText).toHaveBeenCalledWith(
      'src/live.ts',
      DIGEST_1,
      { encoding: 'plain', text: 'let value = 10;', rawBytes: 15 },
      { encoding: 'utf8', eol: 'lf' }
    );
    expect(saveText).not.toHaveBeenCalledWith(
      'src/live.ts',
      DIGEST_2,
      expect.anything(),
      expect.anything()
    );
  });

  it('refreshes clean provider text after provider rebuild', async () => {
    const firstRuntime = createCodeCollabRuntime();
    const secondRuntime = createCodeCollabRuntime({
      previewFile: vi.fn(async () => filePreviewResult('let value = 2;', DIGEST_2)),
    });
    const firstProvider = createCodeCollabProvider(firstRuntime);
    const secondProvider = createCodeCollabProvider(secondRuntime);
    const view = await renderCodeCollabProviderFile(firstProvider);
    expect(view.querySelector('[data-testid="monaco-viewer"]')?.getAttribute('data-text')).toBe(
      'let value = 1;'
    );

    await rerender(
      createElement(SessionFileContentView, {
        sessionId: session.id,
        session,
        filePath: 'src/live.ts',
        fileId: 'src/live.ts',
        fileProvider: secondProvider,
        fileProviderPending: false,
        fileProviderRole: 'write',
        active: true,
      })
    );
    await flushMicrotasks();

    expect(secondRuntime.previewFile).toHaveBeenCalledWith('src/live.ts', DIGEST_1);
    expect(view.querySelector('[data-testid="monaco-viewer"]')?.getAttribute('data-text')).toBe(
      'let value = 2;'
    );
  });

  it('shows saving while an explicit disk save is in flight', async () => {
    vi.useFakeTimers();
    const provider = createEditableProvider();
    vi.spyOn(provider, 'saveText').mockImplementation(() => new Promise(() => undefined));
    const view = await renderEditableProviderFile(provider);

    await act(async () => {
      monacoMockState.onContentChange?.('let value = 2;');
    });
    await clickSave(view);

    expect(view.textContent).toContain('Saving');
  });

  it('shows save failures in the bottom status bar without adding a top banner', async () => {
    vi.useFakeTimers();
    const provider = createEditableProvider();
    vi.spyOn(provider, 'saveText').mockRejectedValue(new Error('disk denied'));
    const view = await renderEditableProviderFile(provider);

    await act(async () => {
      monacoMockState.onContentChange?.('let value = 2;');
    });
    await clickSave(view);
    await flushMicrotasks();

    expect(view.textContent).toContain('Save failed');
    expect(view.textContent).not.toContain('Save failed: disk denied');
  });

  it('shows save conflict in the bottom bar and keeps actions in a separate row', async () => {
    vi.useFakeTimers();
    const provider = createEditableProvider();
    vi.spyOn(provider, 'saveText').mockRejectedValue(
      new SaveTextConflictError('disk_changed', 'conflict-1', 'save_conflict: disk_changed')
    );
    const view = await renderEditableProviderFile(provider);

    await act(async () => {
      monacoMockState.onContentChange?.('let value = 2;');
    });
    await clickSave(view);
    await flushMicrotasks();

    expect(view.textContent).toContain('Save conflict');
    expect(view.textContent).toContain('Discard my edits');
    expect(view.textContent).toContain('Insert conflict markers');
    expect(view.textContent).toContain('Overwrite disk');
  });

  it('does not reopen provider files when the translation function identity changes', async () => {
    const provider = createFakeSessionFileProvider({
      files: [
        {
          path: 'assets/logo.bin',
          kind: 'binary',
          sourceState: 'live-collaborative',
        },
      ],
      snapshots: {
        'assets/logo.bin': { kind: 'binary', bytes: new Uint8Array([1, 2, 3]) },
      },
    });
    const openFile = vi.spyOn(provider, 'openFile');

    await render(
      createElement(SessionFileContentView, {
        sessionId: session.id,
        session,
        filePath: 'assets/logo.bin',
        fileProvider: provider,
        fileProviderPending: false,
      })
    );
    await flushMicrotasks();

    expect(openFile).toHaveBeenCalledTimes(1);
  });

  it('does not open an inactive provider tab until it becomes active', async () => {
    const provider = createFakeSessionFileProvider({
      files: [
        {
          path: 'src/main.ts',
          fileId: 't:main',
          kind: 'text',
          sourceState: 'live-collaborative',
        },
      ],
      snapshots: {
        'src/main.ts': { kind: 'text', text: 'console.log("ready");' },
      },
    });
    const openFile = vi.spyOn(provider, 'openFile');

    await render(
      createElement(SessionFileContentView, {
        sessionId: session.id,
        session,
        filePath: 'src/main.ts',
        fileId: 't:main',
        fileProvider: provider,
        fileProviderPending: false,
        active: false,
      })
    );
    await flushMicrotasks();

    expect(openFile).not.toHaveBeenCalled();

    await act(async () => {
      root?.render(
        createElement(SessionFileContentView, {
          sessionId: session.id,
          session,
          filePath: 'src/main.ts',
          fileId: 't:main',
          fileProvider: provider,
          fileProviderPending: false,
          active: true,
        })
      );
    });
    await flushMicrotasks();

    expect(openFile).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes provider live text when a provider tab becomes inactive', async () => {
    const provider = createFakeSessionFileProvider({
      files: [
        {
          path: 'src/live.ts',
          fileId: 't:live',
          kind: 'text',
          sourceState: 'live-collaborative',
        },
      ],
      snapshots: {
        'src/live.ts': { kind: 'text', text: 'let value = 1;' },
      },
    });
    const unsubscribe = vi.fn();
    const subscribeText = vi.fn(() => unsubscribe);
    provider.subscribeText = subscribeText;

    await render(
      createElement(SessionFileContentView, {
        sessionId: session.id,
        session,
        filePath: 'src/live.ts',
        fileId: 't:live',
        fileProvider: provider,
        fileProviderPending: false,
        active: true,
      })
    );
    await flushMicrotasks();

    expect(subscribeText).toHaveBeenCalledTimes(1);
    expect(subscribeText).toHaveBeenCalledWith('t:live', expect.any(Function));

    await act(async () => {
      root?.render(
        createElement(SessionFileContentView, {
          sessionId: session.id,
          session,
          filePath: 'src/live.ts',
          fileId: 't:live',
          fileProvider: provider,
          fileProviderPending: false,
          active: false,
        })
      );
    });
    await flushMicrotasks();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('does not treat Monaco initial content events as provider edits', async () => {
    monacoMockState.emitInitialContentChange = true;
    const provider = createFakeSessionFileProvider({
      files: [
        {
          path: 'src/live.ts',
          fileId: 't:live',
          kind: 'text',
          sourceState: 'live-collaborative',
        },
      ],
      snapshots: {
        'src/live.ts': { kind: 'text', text: 'let value = 1;' },
      },
    });
    provider.updateLiveText = vi.fn(async () => undefined);
    const saveText = vi.spyOn(provider, 'saveText');

    await render(
      createElement(SessionFileContentView, {
        sessionId: session.id,
        session,
        filePath: 'src/live.ts',
        fileId: 't:live',
        fileProvider: provider,
        fileProviderPending: false,
        active: true,
      })
    );
    await flushMicrotasks();
    await waitForRealTimer(50);

    expect(provider.updateLiveText).not.toHaveBeenCalled();
    expect(saveText).not.toHaveBeenCalled();
  });

  it('remounts the Monaco provider viewer when switching files', async () => {
    const provider = createFakeSessionFileProvider({
      files: [
        {
          path: 'src/one.ts',
          fileId: 't:one',
          kind: 'text',
          sourceState: 'live-collaborative',
        },
        {
          path: 'src/two.ts',
          fileId: 't:two',
          kind: 'text',
          sourceState: 'live-collaborative',
        },
      ],
      snapshots: {
        'src/one.ts': { kind: 'text', text: 'export const one = 1;' },
        'src/two.ts': { kind: 'text', text: 'export const two = 2;' },
      },
    });

    await render(
      createElement(SessionFileContentView, {
        sessionId: session.id,
        session,
        filePath: 'src/one.ts',
        fileId: 't:one',
        fileProvider: provider,
        fileProviderPending: false,
        active: true,
      })
    );
    await flushMicrotasks();
    expect(monacoMockState.mountCount).toBe(1);

    await act(async () => {
      root?.render(
        createElement(SessionFileContentView, {
          sessionId: session.id,
          session,
          filePath: 'src/two.ts',
          fileId: 't:two',
          fileProvider: provider,
          fileProviderPending: false,
          active: true,
        })
      );
    });
    await flushMicrotasks();

    expect(monacoMockState.mountCount).toBe(2);
    expect(monacoMockState.unmountCount).toBe(1);
  });

  it('renders Markdown files by default and can switch to the source editor', async () => {
    const markdown = '# Rendered by default';
    const provider = createFakeSessionFileProvider({
      files: [{ path: 'README.md', kind: 'text', sourceState: 'live-readonly' }],
      snapshots: { 'README.md': { kind: 'text', text: markdown } },
    });

    const view = await render(
      createElement(SessionFileContentView, {
        sessionId: session.id,
        session,
        filePath: 'README.md',
        fileProvider: provider,
        fileProviderPending: false,
      })
    );
    await flushMicrotasks();

    expect(view.textContent).toContain('Rendered by default');
    expect(view.querySelector('[data-testid="monaco-viewer"]')).toBeNull();

    const previewEye = Array.from(view.querySelectorAll('button')).find(
      (button) => button.getAttribute('aria-label') === 'Hide preview'
    );
    expect(previewEye).not.toBeUndefined();

    await act(async () => {
      previewEye?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushMicrotasks();

    expect(view.querySelector('[data-testid="monaco-viewer"]')?.getAttribute('data-text')).toBe(
      markdown
    );
    expect(view.querySelector('button[aria-label="Preview"]')).not.toBeNull();
  });

  it('renders SVG text files as an image by default with a preview eye toggle', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>';
    const provider = createFakeSessionFileProvider({
      files: [{ path: 'assets/icon.svg', kind: 'text', sourceState: 'live-readonly' }],
      snapshots: { 'assets/icon.svg': { kind: 'text', text: svg } },
    });

    const view = await render(
      createElement(SessionFileContentView, {
        sessionId: session.id,
        session,
        filePath: 'assets/icon.svg',
        fileProvider: provider,
        fileProviderPending: false,
      })
    );
    await flushMicrotasks();

    // Default = rendered: an <img> is shown and Monaco is not mounted.
    expect(view.querySelector('img')).not.toBeNull();
    expect(view.querySelector('[data-testid="monaco-viewer"]')).toBeNull();

    // The render-mode control is a single eye button. While the preview is the
    // committed view it offers "Hide preview"; the editor view offers "Preview".
    const previewEye = () =>
      Array.from(view.querySelectorAll('button')).find((b) => {
        const label = b.getAttribute('aria-label');
        return label === 'Preview' || label === 'Hide preview';
      });
    expect(previewEye()?.getAttribute('aria-label')).toBe('Hide preview');

    // Click the eye: switch to the editor, Monaco renders the source.
    await act(async () => {
      previewEye()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushMicrotasks();
    const monaco = view.querySelector('[data-testid="monaco-viewer"]');
    expect(monaco).not.toBeNull();
    expect(monaco?.getAttribute('data-text')).toBe(svg);
    expect(view.querySelector('img')).toBeNull();
    expect(previewEye()?.getAttribute('aria-label')).toBe('Preview');

    // Click the eye again: back to the rendered image.
    await act(async () => {
      previewEye()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushMicrotasks();
    expect(view.querySelector('img')).not.toBeNull();
    expect(view.querySelector('[data-testid="monaco-viewer"]')).toBeNull();
    expect(previewEye()?.getAttribute('aria-label')).toBe('Hide preview');
  });

  it('does not show the preview eye toggle for non-previewable text files', async () => {
    const provider = createFakeSessionFileProvider({
      files: [
        { path: 'src/main.ts', fileId: 't:main', kind: 'text', sourceState: 'live-readonly' },
      ],
      snapshots: { 'src/main.ts': { kind: 'text', text: 'const a = 1;' } },
    });

    const view = await render(
      createElement(SessionFileContentView, {
        sessionId: session.id,
        session,
        filePath: 'src/main.ts',
        fileId: 't:main',
        fileProvider: provider,
        fileProviderPending: false,
      })
    );
    await flushMicrotasks();

    const hasPreviewEye = Array.from(view.querySelectorAll('button')).some((b) => {
      const label = b.getAttribute('aria-label');
      return label === 'Preview' || label === 'Hide preview';
    });
    expect(hasPreviewEye).toBe(false);
    expect(view.querySelector('[data-testid="monaco-viewer"]')).not.toBeNull();
  });
});
