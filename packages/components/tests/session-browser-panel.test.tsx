// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MachineId,
  ElectronPublicBrowserState,
  PreviewConnection,
  PreviewTarget,
  SessionId,
  SessionMeta,
  SessionPreviewDocState,
  SessionPreviewCreateResponse,
  SessionPreviewStatusResponse,
  SessionPreviewEndpoint,
  WorkspaceId,
} from '@lody/shared';

import { runtimeAtom, userAtom, type WorkspaceRuntime } from '../src/atoms';
import { SessionBrowserPanel } from '../src/components/sessions/session-browser-panel';
import { clearSessionBrowserResumeState } from '../src/components/sessions/session-browser-resume-state';

const publicBrowserSurfaceRender = vi.hoisted(() => vi.fn());

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string, values?: Record<string, string>) =>
      (fallback ?? _key).replace(
        /\{\{(\w+)\}\}/g,
        (placeholder, key: string) => values?.[key] ?? placeholder
      ),
  }),
}));

vi.mock('../src/components/sessions/public-browser-surface', () => ({
  PublicBrowserSurface: (props: {
    navigationRequest: { id: number; url: string } | null;
    onStateChange: (state: ElectronPublicBrowserState) => void;
    onNavigationRequestConsumed: (request: { id: number; url: string }) => void;
  }) => {
    publicBrowserSurfaceRender(props);
    return createElement('div', {
      'data-testid': 'public-browser',
      'data-url': props.navigationRequest?.url ?? '',
      'data-navigation-request-id': props.navigationRequest?.id ?? 'restore',
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

vi.mock('@/lib/toast', () => ({
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
  viewerUrl: 'http://127.0.0.1:61234/dashboard?mode=dev&__lody_preview_token=local-token',
  target: localTarget,
  capabilities: { visualAnnotation: true, shareable: false },
  createdAt: 1,
};

const remoteConnection: PreviewConnection = {
  status: 'active',
  endpointId: 'endpoint-browser',
  publicUrl: 'https://browser-preview.trycloudflare.com/?__lody_preview_token=remote-token',
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
  let observedConnection = options?.preview?.connection;
  const requestSessionPreviewCreate = vi.fn(
    options?.createPreview ??
      (async () => {
        observedConnection = options?.connection ?? remoteConnection;
        return {
          type: 'session/preview-create_response' as const,
          sessionId: session.id,
          success: true as const,
          connection: observedConnection,
        };
      })
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
  const requestSessionPreviewStatus = vi.fn(async (): Promise<SessionPreviewStatusResponse> => ({
    type: 'session/preview-status_response' as const,
    sessionId: session.id,
    success: true,
    connection: observedConnection,
  }));
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
    requestSessionPreviewStatus,
    requestSessionPreviewRevoke: vi.fn(async () => null),
  } as unknown as WorkspaceRuntime;
  return {
    runtime,
    observeConnection: (connection: PreviewConnection) => {
      observedConnection = connection;
    },
    requestSessionPreviewStatus,
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
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
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
    vi.useRealTimers();
  });

  const renderPanel = async (
    runtime: WorkspaceRuntime,
    options?: {
      candidateNavigationRequestId?: number;
      panelSession?: SessionMeta;
      onCandidateNavigationRequestHandled?: (requestId: number) => void;
    }
  ) => {
    const store = createStore();
    store.set(userAtom, { id: 'user-1', name: 'Browser User', email: 'browser@example.com' });
    store.set(runtimeAtom, runtime);
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

  const clickRestore = async (host: ParentNode) => {
    const button = [...host.querySelectorAll('button')].find(
      (node) => node.textContent === 'Restore preview'
    );
    if (!button) throw new Error('Expected restore action');
    await act(async () => {
      button.click();
      await flushMicrotasks();
    });
  };

  const nextStatus = async () => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
  };

  it('keeps the persisted target but never loads its old URL when status cannot be verified', async () => {
    const testRuntime = createRuntime({ preview: { connection: remoteConnection } });
    testRuntime.requestSessionPreviewStatus.mockRejectedValue(
      new Error('Session machine is unreachable')
    );
    const rendered = await renderPanel(testRuntime.runtime);
    expect(rendered.querySelector('[data-testid="managed-preview"]')).toBeNull();
    expect(rendered.textContent).toContain('Session machine is unreachable');
    expect((rendered.querySelector('input') as HTMLInputElement).value).toBe(
      'http://127.0.0.1:5173/dashboard?mode=dev'
    );
    expect(testRuntime.requestSessionPreviewCreate).not.toHaveBeenCalled();
  });

  it('expires visibly and restores the exact page with a new share capability', async () => {
    vi.useFakeTimers();
    const replacement = {
      ...remoteConnection,
      endpointId: 'restored',
      publicUrl: 'https://restored.trycloudflare.com/?__lody_preview_token=new-token',
    };
    const testRuntime = createRuntime({
      preview: { connection: remoteConnection },
      connection: replacement,
    });
    const rendered = await renderPanel(testRuntime.runtime);
    expect(testRuntime.requestSessionPreviewCreate).not.toHaveBeenCalled();
    expect(
      rendered.querySelector('[data-testid="managed-preview"]')?.getAttribute('data-viewer-url')
    ).toBe(
      'https://browser-preview.trycloudflare.com/dashboard?mode=dev&__lody_preview_token=remote-token'
    );
    testRuntime.observeConnection({
      ...remoteConnection,
      status: 'closed',
      closedReason: 'idle_timeout',
      publicUrl: undefined,
    });
    await nextStatus();
    expect(rendered.querySelector('[data-testid="managed-preview"]')).toBeNull();
    expect(rendered.textContent).toContain('Preview link expired');
    expect((rendered.querySelector('input') as HTMLInputElement).value).toBe(
      'http://127.0.0.1:5173/dashboard?mode=dev'
    );
    await clickRestore(rendered);
    expect(testRuntime.requestSessionPreviewCreate).toHaveBeenLastCalledWith(
      session.machineId,
      session.id,
      'user-1',
      localTarget,
      expect.objectContaining({ target: localTarget }),
      { restart: true }
    );
    expect(
      rendered.querySelector('[data-testid="managed-preview"]')?.getAttribute('data-viewer-url')
    ).toBe('https://restored.trycloudflare.com/dashboard?mode=dev&__lody_preview_token=new-token');
  });

  it('renews only the foreground remote endpoint and rechecks without renewal on return', async () => {
    vi.useFakeTimers();
    const testRuntime = createRuntime({ preview: { connection: remoteConnection } });
    const rendered = await renderPanel(testRuntime.runtime);
    await nextStatus();
    expect(testRuntime.requestSessionPreviewStatus).toHaveBeenLastCalledWith(
      session.machineId,
      session.id,
      'user-1',
      { renewEndpointId: remoteConnection.endpointId }
    );
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    testRuntime.requestSessionPreviewStatus.mockClear();
    testRuntime.observeConnection({
      ...remoteConnection,
      status: 'closed',
      closedReason: 'idle_timeout',
      publicUrl: undefined,
    });
    await nextStatus();
    expect(testRuntime.requestSessionPreviewStatus).not.toHaveBeenCalled();
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await flushMicrotasks();
    });
    expect(testRuntime.requestSessionPreviewStatus).toHaveBeenLastCalledWith(
      session.machineId,
      session.id,
      'user-1',
      { renewEndpointId: undefined }
    );
    expect(rendered.querySelector('[data-testid="managed-preview"]')).toBeNull();
    expect(testRuntime.requestSessionPreviewCreate).not.toHaveBeenCalled();
  });

  it('keeps local viewing intact without renewing expired remote sharing', async () => {
    vi.useFakeTimers();
    window.__LODY_ELECTRON__ = true;
    const testRuntime = createRuntime({
      plane: 'local',
      preview: { connection: remoteConnection },
    });
    const rendered = await renderPanel(testRuntime.runtime);
    testRuntime.observeConnection({
      ...remoteConnection,
      status: 'closed',
      closedReason: 'idle_timeout',
      publicUrl: undefined,
    });
    await nextStatus();
    expect(testRuntime.requestSessionPreviewStatus).toHaveBeenLastCalledWith(
      session.machineId,
      session.id,
      'user-1',
      { renewEndpointId: undefined }
    );
    expect(
      rendered.querySelector('[data-testid="managed-preview"]')?.getAttribute('data-viewer-url')
    ).toBe(localEndpoint.viewerUrl);
    expect(testRuntime.requestSessionPreviewEndpointRelease).not.toHaveBeenCalled();
  });

  it('ignores a stale status response after an explicit restore', async () => {
    vi.useFakeTimers();
    const expired: PreviewConnection = {
      ...remoteConnection,
      status: 'closed',
      closedReason: 'idle_timeout',
      publicUrl: undefined,
    };
    const testRuntime = createRuntime({ preview: { connection: expired } });
    const rendered = await renderPanel(testRuntime.runtime);
    let resolveStatus!: (response: SessionPreviewStatusResponse) => void;
    testRuntime.requestSessionPreviewStatus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve;
        })
    );
    await nextStatus();
    await clickRestore(rendered);
    await act(async () => {
      resolveStatus({
        type: 'session/preview-status_response',
        sessionId: session.id,
        success: true,
        connection: expired,
      });
      await flushMicrotasks();
    });
    expect(rendered.querySelector('[data-testid="managed-preview"]')).not.toBeNull();
  });

  it('shows restore failure without losing the requested page or retrying automatically', async () => {
    vi.useFakeTimers();
    const testRuntime = createRuntime({
      preview: {
        connection: {
          ...remoteConnection,
          status: 'closed',
          closedReason: 'idle_timeout',
          publicUrl: undefined,
        },
      },
      createPreview: async () => {
        throw new Error('Development server is not listening on port 5173');
      },
    });
    const rendered = await renderPanel(testRuntime.runtime);
    await clickRestore(rendered);
    expect(rendered.textContent).toContain('Development server is not listening on port 5173');
    expect(rendered.querySelector('[data-testid="managed-preview"]')).toBeNull();
    expect((rendered.querySelector('input') as HTMLInputElement).value).toBe(
      'http://127.0.0.1:5173/dashboard?mode=dev'
    );
    await nextStatus();
    expect(testRuntime.requestSessionPreviewCreate).toHaveBeenCalledTimes(1);
  });

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

  it('does not turn an observed public URL into a new navigation request', async () => {
    const testRuntime = createRuntime();
    const rendered = await renderPanel(testRuntime.runtime);

    await enterAddress(rendered, 'example.com/docs');

    const firstProps = publicBrowserSurfaceRender.mock.calls.at(-1)?.[0] as {
      navigationRequest: { id: number; url: string } | null;
      onStateChange: (state: ElectronPublicBrowserState) => void;
    };
    expect(firstProps.navigationRequest).toEqual({ id: 1, url: 'https://example.com/docs' });

    await act(async () => {
      firstProps.onStateChange({
        browserId: 'session-browser-session-browser-controller',
        phase: 'ready',
        url: 'https://example.com/redirected',
        canGoBack: true,
        canGoForward: false,
      });
      await flushMicrotasks();
    });

    const latestProps = publicBrowserSurfaceRender.mock.calls.at(-1)?.[0] as typeof firstProps;
    expect(latestProps.navigationRequest).toBe(firstProps.navigationRequest);
    expect(latestProps.navigationRequest).toEqual({ id: 1, url: 'https://example.com/docs' });
    expect((rendered.querySelector('input[aria-label="Address"]') as HTMLInputElement).value).toBe(
      'https://example.com/redirected'
    );
  });

  it('clears only a public navigation request that the surface has dispatched', async () => {
    const testRuntime = createRuntime();
    const rendered = await renderPanel(testRuntime.runtime);

    await enterAddress(rendered, 'example.com/docs');

    const firstProps = publicBrowserSurfaceRender.mock.calls.at(-1)?.[0] as {
      navigationRequest: { id: number; url: string } | null;
      onNavigationRequestConsumed: (request: { id: number; url: string }) => void;
    };
    expect(firstProps.navigationRequest).toEqual({ id: 1, url: 'https://example.com/docs' });

    await act(async () => {
      firstProps.onNavigationRequestConsumed({ id: 999, url: 'https://example.com/other' });
      await flushMicrotasks();
    });
    expect(publicBrowserSurfaceRender.mock.calls.at(-1)?.[0].navigationRequest).toBe(
      firstProps.navigationRequest
    );

    await act(async () => {
      firstProps.onNavigationRequestConsumed(firstProps.navigationRequest!);
      await flushMicrotasks();
    });
    expect(publicBrowserSurfaceRender.mock.calls.at(-1)?.[0].navigationRequest).toBeNull();
  });

  it('assigns a new request id when retrying a consumed public navigation', async () => {
    const testRuntime = createRuntime();
    const rendered = await renderPanel(testRuntime.runtime);

    await enterAddress(rendered, 'example.com/docs');

    const firstProps = publicBrowserSurfaceRender.mock.calls.at(-1)?.[0] as {
      navigationRequest: { id: number; url: string } | null;
      onStateChange: (state: ElectronPublicBrowserState) => void;
      onNavigationRequestConsumed: (request: { id: number; url: string }) => void;
    };
    const firstRequest = firstProps.navigationRequest!;
    expect(firstRequest).toEqual({ id: 1, url: 'https://example.com/docs' });

    await act(async () => {
      firstProps.onNavigationRequestConsumed(firstRequest);
      firstProps.onStateChange({
        browserId: 'session-browser-session-browser-controller',
        phase: 'error',
        url: firstRequest.url,
        canGoBack: false,
        canGoForward: false,
        error: 'load failed',
      });
      await flushMicrotasks();
    });

    await enterAddress(rendered, 'example.com/docs');

    expect(publicBrowserSurfaceRender.mock.calls.at(-1)?.[0].navigationRequest).toEqual({
      id: 2,
      url: 'https://example.com/docs',
    });
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

  it('treats Enter as exact-target authorization with no confirmation dialog', async () => {
    const testRuntime = createRuntime({ plane: 'cloud' });
    const rendered = await renderPanel(testRuntime.runtime);

    await enterAddress(rendered, '127.0.0.1:5173/dashboard?mode=dev');

    expect(testRuntime.requestSessionPreviewEndpointAcquire).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();

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
      expect.objectContaining({ restart: undefined })
    );
    expect(rendered.querySelector('[data-testid="managed-preview"]')).not.toBeNull();
  });

  it('refuses a private-LAN destination requested by the page, but not one the user types', async () => {
    const testRuntime = createRuntime({ plane: 'cloud' });
    const rendered = await renderPanel(testRuntime.runtime);
    lastManagedNavigationRequest = null;

    await enterAddress(rendered, '127.0.0.1:5173');
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
      expect.objectContaining({ restart: undefined })
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

  it('shows remote connection progress until the tunnel viewer URL is ready', async () => {
    let resolveCreate: ((response: SessionPreviewCreateResponse) => void) | undefined;
    const createPreview = () =>
      new Promise<SessionPreviewCreateResponse>((resolve) => {
        resolveCreate = resolve;
      });
    const testRuntime = createRuntime({ plane: 'cloud', createPreview });
    const rendered = await renderPanel(testRuntime.runtime);

    await enterAddress(rendered, '127.0.0.1:5173/dashboard?mode=dev');

    expect(rendered.querySelector('[role="status"]')?.textContent).toContain(
      'Establishing a secure preview connection…'
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
      'https://browser-preview.trycloudflare.com/dashboard?mode=dev&__lody_preview_token=remote-token'
    );
    expect(surface?.getAttribute('data-logical-url')).toBe(
      'http://127.0.0.1:5173/dashboard?mode=dev'
    );
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

    expect(rendered.querySelector('[role="alert"]')?.textContent).toContain(
      'Page could not be opened: preview transport disconnected'
    );
    expect(rendered.querySelector('[role="status"]')).not.toBeNull();
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
    expect(testRuntime.requestSessionPreviewEndpointAcquire).toHaveBeenCalledWith(
      session.machineId,
      session.id,
      'user-1',
      localTarget
    );
    expect(testRuntime.requestSessionPreviewCreate).not.toHaveBeenCalled();
    const localViewer = rendered.querySelector('[data-testid="managed-preview"]');
    expect(localViewer?.getAttribute('data-viewer-url')).toBe(localEndpoint.viewerUrl);

    await clickButton(rendered, 'Share preview');
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();

    expect(testRuntime.requestSessionPreviewCreate).toHaveBeenCalledWith(
      session.machineId,
      session.id,
      'user-1',
      localTarget,
      expect.objectContaining({ source: 'share_action', target: localTarget }),
      expect.objectContaining({ restart: undefined })
    );
    expect(rendered.querySelector('[data-testid="managed-preview"]')).toBe(localViewer);
    expect(localViewer?.getAttribute('data-viewer-url')).toBe(localEndpoint.viewerUrl);
  });
});
