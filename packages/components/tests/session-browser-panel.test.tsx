// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MachineMeta,
  MachineId,
  PreviewConnection,
  PreviewTarget,
  SessionId,
  SessionMeta,
  SessionPreviewDocState,
  SessionPreviewCreateResponse,
  SessionPreviewEndpoint,
  WorkspaceId,
} from '@lody/shared';
import { getMachineRoomId } from '@lody/shared';

import { runtimeAtom, userAtom, type WorkspaceRuntime } from '../src/atoms';
import { machineMetaCacheAtom } from '../src/atoms/doc-meta';
import { SessionBrowserPanel } from '../src/components/sessions/session-browser-panel';
import { clearSessionBrowserResumeState } from '../src/components/sessions/session-browser-resume-state';

const publicBrowserSurfaceRender = vi.hoisted(() => vi.fn());

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

vi.mock('../src/components/sessions/public-browser-surface', () => ({
  PublicBrowserSurface: (props: { url: string; navigationRequestId: number | null }) => {
    publicBrowserSurfaceRender(props);
    return createElement('div', {
      'data-testid': 'public-browser',
      'data-url': props.url,
      'data-navigation-request-id': props.navigationRequestId ?? 'restore',
    });
  },
}));

vi.mock('../src/components/sessions/managed-preview-surface', () => ({
  ManagedPreviewSurface: ({
    viewerUrl,
    logicalUrl,
    onNavigationRequest,
  }: {
    viewerUrl: string;
    logicalUrl: string;
    onNavigationRequest: (url: string) => void;
  }) => {
    // The real surface calls this when the agent-authored page inside the preview posts
    // a navigation request up. Capturing it lets a test drive that path directly.
    lastManagedNavigationRequest = onNavigationRequest;
    return createElement('div', {
      'data-testid': 'managed-preview',
      'data-viewer-url': viewerUrl,
      'data-logical-url': logicalUrl,
    });
  },
}));

let lastManagedNavigationRequest: ((url: string) => void) | null = null;

vi.mock('../src/lib/clipboard', () => ({
  writeTextToClipboard: vi.fn(async () => true),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const session: SessionMeta = {
  id: 'session-browser-controller' as SessionId,
  machineId: 'machine-browser-controller' as MachineId,
  createdAt: '2026-07-20T00:00:00.000Z',
  userId: 'user-1',
  status: { type: 'idle' },
  cliType: 'builtin',
  agentType: 'codex',
};

const secondSession: SessionMeta = {
  ...session,
  id: 'session-browser-controller-2' as SessionId,
};

const localTarget: PreviewTarget = {
  protocol: 'http',
  host: '127.0.0.1',
  port: 5173,
  path: '/dashboard?mode=dev',
};

const localEndpoint: SessionPreviewEndpoint = {
  endpointId: 'endpoint-local-browser',
  kind: 'local-proxy',
  viewerUrl: 'http://127.0.0.1:61234/dashboard?mode=dev&__lody_local_preview_token=local-token',
  target: localTarget,
  capabilities: { visualAnnotation: true, shareable: false },
  createdAt: 1,
};

const remoteConnection: PreviewConnection = {
  status: 'active',
  grantId: 'grant-browser',
  tunnelId: 'tunnel-browser',
  publicUrl: 'https://browser-preview.mylody.app/?__lody_preview_token=remote-token',
  target: localTarget,
  updatedAt: 1,
};

const createSessionStore = (sessionId: SessionId, preview?: SessionPreviewDocState) => ({
  sessionId,
  roomId: `session:${sessionId}`,
  doc: null,
  firstSynced: Promise.resolve(),
  acquireSync: () => () => {},
  getSyncState: () => 'synced' as const,
  subscribeSyncState: () => () => {},
  getState: () => ({ session: { id: sessionId }, history: [], mq: [], preview }),
  setState: () => {},
  subscribe: () => () => {},
  dispose: () => {},
  waitUntilSynced: async () => {},
});

/**
 * A store that starts out still catching up with no preview state, so a test can
 * deliver the candidate the way the machine does: doc write first, sync state
 * after.
 */
const createCatchingUpSessionStore = (sessionId: SessionId) => {
  let state: Record<string, unknown> = { session: { id: sessionId }, history: [], mq: [] };
  let syncState: 'syncing' | 'synced' = 'syncing';
  const stateListeners = new Set<(next: Record<string, unknown>) => void>();
  const syncListeners = new Set<(next: 'syncing' | 'synced') => void>();
  return {
    store: {
      sessionId,
      roomId: `session:${sessionId}`,
      doc: null,
      firstSynced: Promise.resolve(),
      acquireSync: () => () => {},
      getSyncState: () => syncState,
      subscribeSyncState: (listener: (next: 'syncing' | 'synced') => void) => {
        syncListeners.add(listener);
        return () => syncListeners.delete(listener);
      },
      getState: () => state,
      setState: () => {},
      subscribe: (listener: (next: Record<string, unknown>) => void) => {
        stateListeners.add(listener);
        return () => stateListeners.delete(listener);
      },
      dispose: () => {},
      waitUntilSynced: async () => {},
    },
    deliverPreview: (preview: SessionPreviewDocState) => {
      state = { ...state, preview };
      for (const listener of stateListeners) listener(state);
    },
    finishSync: () => {
      syncState = 'synced';
      for (const listener of syncListeners) listener(syncState);
    },
  };
};

const createRuntime = (options?: {
  plane?: 'local' | 'cloud';
  endpoint?: SessionPreviewEndpoint;
  connection?: PreviewConnection;
  preview?: SessionPreviewDocState;
  sessionStore?: unknown;
  createPreview?: () => Promise<SessionPreviewCreateResponse | null>;
}) => {
  const requestSessionPreviewCreate = vi.fn(
    options?.createPreview ??
      (async () => ({
        type: 'session/preview-create_response' as const,
        sessionId: session.id,
        success: true as const,
        connection: options?.connection ?? remoteConnection,
      }))
  );
  const requestSessionPreviewEndpointAcquire = vi.fn(async () => ({
    type: 'session/preview-endpoint-acquire_response' as const,
    sessionId: session.id,
    success: true as const,
    endpoint: options?.endpoint ?? localEndpoint,
  }));
  const requestSessionPreviewEndpointRelease = vi.fn(
    async (_machineId, _sessionId, endpointId) => ({
      type: 'session/preview-endpoint-release_response' as const,
      sessionId: session.id,
      endpointId,
      success: true as const,
    })
  );
  const runtime = {
    workspaceSlug: 'workspace-browser',
    workspaceId: 'workspace-browser-id' as WorkspaceId,
    acquireSessionStore: vi.fn(
      async (sessionId: SessionId) =>
        options?.sessionStore ?? createSessionStore(sessionId, options?.preview)
    ),
    releaseSessionStoreRef: vi.fn(),
    resolveMachineTargetPlane: vi.fn(async () => options?.plane ?? 'cloud'),
    requestSessionPreviewCreate,
    requestSessionPreviewEndpointAcquire,
    requestSessionPreviewEndpointRelease,
    requestSessionPreviewRevoke: vi.fn(async () => null),
  } as unknown as WorkspaceRuntime;
  return {
    runtime,
    requestSessionPreviewCreate,
    requestSessionPreviewEndpointAcquire,
    requestSessionPreviewEndpointRelease,
  };
};

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('SessionBrowserPanel controller', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = undefined;
    container?.remove();
    container = undefined;
    delete window.__LODY_ELECTRON__;
    clearSessionBrowserResumeState(session.id);
    clearSessionBrowserResumeState(secondSession.id);
    vi.restoreAllMocks();
  });

  const renderPanel = async (
    runtime: WorkspaceRuntime,
    options?: {
      candidateNavigationRequestId?: number;
      machineName?: string;
      panelSession?: SessionMeta;
      onCandidateNavigationRequestHandled?: (requestId: number) => void;
    }
  ) => {
    const store = createStore();
    store.set(userAtom, { id: 'user-1', name: 'Browser User', email: 'browser@example.com' });
    store.set(runtimeAtom, runtime);
    if (options?.machineName) {
      store.set(machineMetaCacheAtom, {
        [getMachineRoomId(session.machineId)]: {
          id: session.machineId,
          name: options.machineName,
        } as MachineMeta,
      });
    }
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(
          Provider,
          { store },
          createElement(SessionBrowserPanel, {
            session: options?.panelSession ?? session,
            candidateNavigationRequestId: options?.candidateNavigationRequestId,
            onCandidateNavigationRequestHandled: options?.onCandidateNavigationRequestHandled,
          })
        )
      );
      await flushMicrotasks();
    });
    return container;
  };

  const enterAddress = async (host: HTMLElement, value: string) => {
    const input = host.querySelector('input[aria-label="Address"]') as HTMLInputElement | null;
    if (!input) throw new Error('Expected Browser address input');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input
        .closest('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await flushMicrotasks();
    });
  };

  const clickButton = async (host: ParentNode, label: string) => {
    const button = host.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;
    if (!button) throw new Error(`Expected button: ${label}`);
    await act(async () => {
      button.click();
      await flushMicrotasks();
    });
  };

  const confirmDialog = async () => {
    const button = Array.from(document.body.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === 'Confirm'
    );
    if (!button) throw new Error('Expected remote preview confirmation');
    await act(async () => {
      button.click();
      await flushMicrotasks();
    });
  };

  it('opens public URLs without sending them to the session runtime', async () => {
    const testRuntime = createRuntime();
    const rendered = await renderPanel(testRuntime.runtime);

    await enterAddress(rendered, 'example.com/docs');

    const surface = rendered.querySelector('[data-testid="public-browser"]');
    expect(surface?.getAttribute('data-url')).toBe('https://example.com/docs');
    expect(testRuntime.requestSessionPreviewCreate).not.toHaveBeenCalled();
    expect(testRuntime.requestSessionPreviewEndpointAcquire).not.toHaveBeenCalled();
    const annotationButton = rendered.querySelector(
      'button[aria-label="Annotation is available only for local and private-network pages"]'
    ) as HTMLButtonElement | null;
    expect(annotationButton?.disabled).toBe(true);
  });

  it('reattaches a public browser without navigating again after remount', async () => {
    const testRuntime = createRuntime();
    const rendered = await renderPanel(testRuntime.runtime);

    await enterAddress(rendered, 'example.com/docs');
    expect(
      rendered
        .querySelector('[data-testid="public-browser"]')
        ?.getAttribute('data-navigation-request-id')
    ).toBe('1');

    await act(async () => root?.unmount());
    root = undefined;
    container?.remove();
    container = undefined;

    const resumed = await renderPanel(testRuntime.runtime);

    expect(
      resumed
        .querySelector('[data-testid="public-browser"]')
        ?.getAttribute('data-navigation-request-id')
    ).toBe('restore');
  });

  it('isolates browser state when the mounted panel switches sessions in place', async () => {
    const testRuntime = createRuntime();
    const store = createStore();
    store.set(userAtom, { id: 'user-1', name: 'Browser User', email: 'browser@example.com' });
    store.set(runtimeAtom, testRuntime.runtime);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    const renderSession = async (nextSession: SessionMeta) => {
      await act(async () => {
        root?.render(
          createElement(
            Provider,
            { store },
            createElement(SessionBrowserPanel, { session: nextSession })
          )
        );
        await flushMicrotasks();
      });
    };

    await renderSession(session);
    await enterAddress(container, 'example.com/docs');
    expect(container.querySelector('[data-testid="public-browser"]')).not.toBeNull();

    publicBrowserSurfaceRender.mockClear();
    await renderSession(secondSession);

    expect(publicBrowserSurfaceRender).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="public-browser"]')).toBeNull();
    expect((container.querySelector('input[aria-label="Address"]') as HTMLInputElement).value).toBe(
      ''
    );

    await act(async () => root?.unmount());
    root = createRoot(container);
    await renderSession(secondSession);

    expect(container.querySelector('[data-testid="public-browser"]')).toBeNull();
    expect((container.querySelector('input[aria-label="Address"]') as HTMLInputElement).value).toBe(
      ''
    );
  });

  it('requires confirmation before a remote private target has any tunnel side effect', async () => {
    const testRuntime = createRuntime({ plane: 'cloud' });
    const rendered = await renderPanel(testRuntime.runtime);

    await enterAddress(rendered, '127.0.0.1:5173/dashboard?mode=dev');

    expect(testRuntime.requestSessionPreviewCreate).not.toHaveBeenCalled();
    expect(testRuntime.requestSessionPreviewEndpointAcquire).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Open a remote preview?');

    await confirmDialog();

    expect(testRuntime.requestSessionPreviewCreate).toHaveBeenCalledWith(
      session.machineId,
      session.id,
      'user-1',
      localTarget,
      expect.objectContaining({
        source: 'browser_address',
        targetClass: 'loopback',
        target: localTarget,
        confirmedByUserId: 'user-1',
      }),
      expect.objectContaining({ replaceExisting: false })
    );
    expect(rendered.querySelector('[data-testid="managed-preview"]')).not.toBeNull();
  });

  it('refuses a private-LAN destination requested by the page, but not one the user types', async () => {
    const testRuntime = createRuntime({ plane: 'cloud' });
    const rendered = await renderPanel(testRuntime.runtime);
    lastManagedNavigationRequest = null;

    await enterAddress(rendered, '127.0.0.1:5173');
    await confirmDialog();
    expect(lastManagedNavigationRequest).not.toBeNull();
    publicBrowserSurfaceRender.mockClear();

    // The page inside the preview is served by the agent machine, so this request is
    // agent-authored. A LAN address would otherwise open silently on the USER's network.
    await act(async () => {
      lastManagedNavigationRequest?.('http://192.168.1.10:3000/admin');
      await flushMicrotasks();
    });

    expect(document.body.textContent).toContain('The page asked to open a private network');
    expect(publicBrowserSurfaceRender).not.toHaveBeenCalled();
    expect(rendered.querySelector('[data-testid="public-browser"]')).toBeNull();

    // A public destination from the same source is an ordinary external link.
    await act(async () => {
      lastManagedNavigationRequest?.('https://example.com/docs');
      await flushMicrotasks();
    });
    expect(rendered.querySelector('[data-testid="public-browser"]')?.getAttribute('data-url')).toBe(
      'https://example.com/docs'
    );

    // The person typing the same LAN address is still allowed.
    await enterAddress(rendered, '192.168.1.10:3000/admin');
    expect(rendered.querySelector('[data-testid="public-browser"]')?.getAttribute('data-url')).toBe(
      'http://192.168.1.10:3000/admin'
    );
  });

  it('opens a reported candidate from the composer bar and creates its tunnel directly', async () => {
    const onCandidateNavigationRequestHandled = vi.fn();
    const testRuntime = createRuntime({
      plane: 'cloud',
      preview: {
        candidate: {
          status: 'available',
          candidateId: 'candidate-browser',
          target: localTarget,
          updatedAt: 1,
        },
      },
    });
    const rendered = await renderPanel(testRuntime.runtime, {
      candidateNavigationRequestId: 1,
      onCandidateNavigationRequestHandled,
    });

    expect(onCandidateNavigationRequestHandled).toHaveBeenCalledWith(1);
    expect(document.body.textContent).not.toContain('Open a remote preview?');
    expect(testRuntime.requestSessionPreviewCreate).toHaveBeenCalledWith(
      session.machineId,
      session.id,
      'user-1',
      localTarget,
      expect.objectContaining({
        source: 'browser_address',
        targetClass: 'loopback',
        target: localTarget,
        confirmedByUserId: 'user-1',
      }),
      expect.objectContaining({ replaceExisting: false })
    );
    expect(testRuntime.requestSessionPreviewCreate).toHaveBeenCalledOnce();
    expect(rendered.querySelector('[data-testid="managed-preview"]')).not.toBeNull();

    await act(async () => root?.unmount());
    root = undefined;
    container?.remove();
    container = undefined;

    await renderPanel(testRuntime.runtime, { candidateNavigationRequestId: 0 });

    expect(document.body.textContent).not.toContain('Open a remote preview?');
    expect(testRuntime.requestSessionPreviewCreate).toHaveBeenCalledOnce();
  });

  it('keeps a composer bar request pending until a reported candidate reaches the session doc', async () => {
    const onCandidateNavigationRequestHandled = vi.fn();
    const catchingUp = createCatchingUpSessionStore(session.id);
    const testRuntime = createRuntime({ plane: 'cloud', sessionStore: catchingUp.store });
    const rendered = await renderPanel(testRuntime.runtime, {
      candidateNavigationRequestId: 1,
      onCandidateNavigationRequestHandled,
      // Meta says a candidate exists; its target has not synced yet.
      panelSession: { ...session, previewCandidate: { status: 'available', updatedAt: 1 } },
    });

    expect(onCandidateNavigationRequestHandled).not.toHaveBeenCalled();
    expect(testRuntime.requestSessionPreviewCreate).not.toHaveBeenCalled();

    await act(async () => {
      catchingUp.deliverPreview({
        candidate: {
          status: 'available',
          candidateId: 'candidate-late',
          target: localTarget,
          updatedAt: 2,
        },
      });
      await flushMicrotasks();
    });

    expect(onCandidateNavigationRequestHandled).toHaveBeenCalledWith(1);
    expect(testRuntime.requestSessionPreviewCreate).toHaveBeenCalledOnce();
    expect(rendered.querySelector('[data-testid="managed-preview"]')).not.toBeNull();
  });

  it('stops waiting for a candidate once the session doc has caught up without one', async () => {
    const onCandidateNavigationRequestHandled = vi.fn();
    const catchingUp = createCatchingUpSessionStore(session.id);
    const testRuntime = createRuntime({ plane: 'cloud', sessionStore: catchingUp.store });
    await renderPanel(testRuntime.runtime, {
      candidateNavigationRequestId: 1,
      onCandidateNavigationRequestHandled,
      panelSession: { ...session, previewCandidate: { status: 'available', updatedAt: 1 } },
    });

    expect(onCandidateNavigationRequestHandled).not.toHaveBeenCalled();

    await act(async () => {
      catchingUp.finishSync();
      await flushMicrotasks();
    });

    expect(onCandidateNavigationRequestHandled).toHaveBeenCalledWith(1);
    expect(testRuntime.requestSessionPreviewCreate).not.toHaveBeenCalled();
  });

  it('explains an empty browser instead of showing a bare globe', async () => {
    const catchingUp = createCatchingUpSessionStore(session.id);
    const testRuntime = createRuntime({ plane: 'cloud', sessionStore: catchingUp.store });
    const rendered = await renderPanel(testRuntime.runtime, {
      candidateNavigationRequestId: 1,
      panelSession: { ...session, previewCandidate: { status: 'available', updatedAt: 1 } },
    });

    await act(async () => {
      catchingUp.finishSync();
      await flushMicrotasks();
    });

    // Nothing was ever reported: say so rather than leaving the user guessing.
    expect(rendered.textContent).toContain('No preview address reported yet');

    await act(async () => {
      catchingUp.deliverPreview({
        candidate: {
          status: 'available',
          candidateId: 'candidate-hint',
          target: localTarget,
          updatedAt: 2,
        },
      });
      await flushMicrotasks();
    });

    expect(rendered.textContent).not.toContain('No preview address reported yet');
  });

  it('reuses an active session tunnel when the browser panel mounts again', async () => {
    const testRuntime = createRuntime({
      plane: 'cloud',
      preview: { connection: remoteConnection },
    });
    const rendered = await renderPanel(testRuntime.runtime, {
      machineName: 'Remote workstation',
    });

    expect(testRuntime.requestSessionPreviewCreate).not.toHaveBeenCalled();
    expect(
      rendered.querySelector('[data-testid="managed-preview"]')?.getAttribute('data-viewer-url')
    ).toBe(
      'https://browser-preview.mylody.app/dashboard?mode=dev&__lody_preview_token=remote-token'
    );
    expect(
      rendered.querySelector('[aria-label="Remote machine: Remote workstation"]')
    ).not.toBeNull();
    expect((rendered.querySelector('input[aria-label="Address"]') as HTMLInputElement).value).toBe(
      'http://127.0.0.1:5173/dashboard?mode=dev'
    );
  });

  it('shows remote connection progress until the tunnel viewer URL is ready', async () => {
    let resolveCreate: ((response: SessionPreviewCreateResponse) => void) | undefined;
    const createPreview = () =>
      new Promise<SessionPreviewCreateResponse>((resolve) => {
        resolveCreate = resolve;
      });
    const testRuntime = createRuntime({ plane: 'cloud', createPreview });
    const rendered = await renderPanel(testRuntime.runtime);

    await enterAddress(rendered, '127.0.0.1:5173/dashboard?mode=dev');
    await confirmDialog();

    expect(rendered.querySelector('[role="status"]')?.textContent).toContain(
      'Establishing a secure preview connection'
    );
    expect(
      (rendered.querySelector('input[aria-label="Address"]') as HTMLInputElement).disabled
    ).toBe(true);
    expect(rendered.querySelector('[data-testid="managed-preview"]')).toBeNull();

    await act(async () => {
      resolveCreate?.({
        type: 'session/preview-create_response',
        sessionId: session.id,
        success: true,
        connection: remoteConnection,
      });
      await flushMicrotasks();
    });

    const surface = rendered.querySelector('[data-testid="managed-preview"]');
    expect(surface?.getAttribute('data-viewer-url')).toBe(
      'https://browser-preview.mylody.app/dashboard?mode=dev&__lody_preview_token=remote-token'
    );
    expect(surface?.getAttribute('data-logical-url')).toBe(
      'http://127.0.0.1:5173/dashboard?mode=dev'
    );
    expect(rendered.querySelector('[role="status"]')).toBeNull();
  });

  it('surfaces an unexpected remote navigation failure instead of rejecting silently', async () => {
    const testRuntime = createRuntime({
      plane: 'cloud',
      createPreview: async () => {
        throw new Error('preview transport disconnected');
      },
    });
    const rendered = await renderPanel(testRuntime.runtime);

    await enterAddress(rendered, '127.0.0.1:5173/dashboard?mode=dev');
    await confirmDialog();

    expect(rendered.querySelector('[role="alert"]')?.textContent).toContain(
      'Page could not be opened: preview transport disconnected'
    );
    expect(rendered.querySelector('[role="status"]')).toBeNull();
  });

  it('uses the exact local endpoint for a local Electron session without creating a tunnel', async () => {
    window.__LODY_ELECTRON__ = true;
    const testRuntime = createRuntime({ plane: 'local' });
    const rendered = await renderPanel(testRuntime.runtime);

    await enterAddress(rendered, '127.0.0.1:5173/dashboard?mode=dev');

    expect(testRuntime.requestSessionPreviewEndpointAcquire).toHaveBeenCalledWith(
      session.machineId,
      session.id,
      'user-1',
      localTarget
    );
    expect(testRuntime.requestSessionPreviewCreate).not.toHaveBeenCalled();
    expect(
      rendered.querySelector('[data-testid="managed-preview"]')?.getAttribute('data-viewer-url')
    ).toBe(localEndpoint.viewerUrl);
  });

  it('keeps a local session endpoint alive across panel unmount and resumes it on remount', async () => {
    window.__LODY_ELECTRON__ = true;
    const testRuntime = createRuntime({ plane: 'local' });
    const rendered = await renderPanel(testRuntime.runtime);

    await enterAddress(rendered, '127.0.0.1:5173/dashboard?mode=dev');
    await act(async () => root?.unmount());
    root = undefined;
    container?.remove();
    container = undefined;

    expect(testRuntime.requestSessionPreviewEndpointRelease).not.toHaveBeenCalled();

    const resumed = await renderPanel(testRuntime.runtime);

    expect(testRuntime.requestSessionPreviewEndpointAcquire).toHaveBeenCalledTimes(2);
    expect(testRuntime.requestSessionPreviewEndpointRelease).not.toHaveBeenCalled();
    expect(
      resumed.querySelector('[data-testid="managed-preview"]')?.getAttribute('data-viewer-url')
    ).toBe(localEndpoint.viewerUrl);
  });

  it('creates a share tunnel for a local preview without replacing its local viewer', async () => {
    window.__LODY_ELECTRON__ = true;
    const testRuntime = createRuntime({ plane: 'local' });
    const rendered = await renderPanel(testRuntime.runtime);
    await enterAddress(rendered, '127.0.0.1:5173/dashboard?mode=dev');

    await clickButton(rendered, 'Share preview');
    expect(testRuntime.requestSessionPreviewCreate).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Create a shareable preview?');

    await confirmDialog();

    expect(testRuntime.requestSessionPreviewCreate).toHaveBeenCalledWith(
      session.machineId,
      session.id,
      'user-1',
      localTarget,
      expect.objectContaining({ source: 'share_action', target: localTarget }),
      expect.objectContaining({ replaceExisting: false })
    );
    expect(
      rendered.querySelector('[data-testid="managed-preview"]')?.getAttribute('data-viewer-url')
    ).toBe(localEndpoint.viewerUrl);
  });
});
