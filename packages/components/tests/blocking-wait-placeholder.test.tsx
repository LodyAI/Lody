/** @vitest-environment jsdom */

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceId } from '@lody/shared';

const app = vi.hoisted(() => ({
  reloads: 0,
  relaunches: [] as unknown[],
  events: [] as Array<{ name: string; properties: Record<string, unknown> }>,
}));

vi.mock('../src/lib/clear-local-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/clear-local-cache')>()),
  reloadApp: () => {
    app.reloads += 1;
  },
}));

vi.mock('../src/lib/deferred-posthog', () => ({
  deferredPostHog: {
    capture: (name: string, properties: Record<string, unknown>) =>
      app.events.push({ name, properties }),
    captureException: () => {},
  },
}));

vi.mock('../src/components/preloaded-main-layout', () => ({
  preloadMainLayout: () => Promise.resolve(),
}));

import 'fake-indexeddb/auto';
import { docMetaCacheScopeAtom } from '../src/atoms/doc-meta';
import {
  runtimeAtom,
  workspaceRuntimeInitFailureAtom,
  type WorkspaceRuntime,
} from '../src/atoms/runtime';
import { setWorkspaceContextAtom } from '../src/atoms/workspace-context';
import { BootShellProvider } from '../src/components/boot-shell';
import {
  BLOCKING_WAIT_RECOVERY_DELAY_MS,
  BlockingWaitPlaceholder,
} from '../src/components/blocking-wait-placeholder';
import { RouteMessage } from '../src/components/route-message';
import {
  resetWorkspaceDataReadyForTests,
  resolveWorkspaceDataWaitKind,
  useRecordWorkspaceDataReady,
  WorkspaceDataWait,
} from '../src/components/workspace-data-wait';
import { StuckConnectionBannerContainer } from '../src/components/stuck-connection-banner';
import { browserOnlineAtom, lodyControlConnectionStateAtom } from '../src/atoms/control-connection';
import { authTokenAtom } from '../src/atoms/runtime';
import { STUCK_CONNECTION_HINT_DELAY_MS } from '../src/hooks/use-stuck-connection';
import { TestCloudPlatformProvider } from './test-platform';
import {
  describeBootRequestError,
  recordBootRequestResult,
  resetBootRequestFailuresForTests,
} from '../src/lib/boot-request-failures';
import { initI18n } from '../src/i18n';
import {
  installAppActivityTracking,
  resetAppActivityGapForTests,
} from '../src/lib/app-activity-gap';
import {
  LOCAL_CLEAR_RECORD_RELEVANCE_MS,
  markCacheClearPending,
  maybeClearLodyCacheOnBoot,
  readPendingLocalClearMode,
  resetBootClearMemoForTests,
} from '../src/lib/clear-local-cache';
import { WorkspaceRouteTargetProvider } from '../src/providers/workspace-route-target';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const RECOVERY_DELAY_MS = 20_000;
const runtime = {
  workspaceSlug: 'acme',
  workspaceId: 'ws-acme' as WorkspaceId,
} as WorkspaceRuntime;

let container: HTMLDivElement;
let root: Root;

function createWorkspaceStore({
  scan,
  initErrorType = 'InvalidStateError',
}: {
  scan: 'pending' | 'failed' | 'init-failed';
  initErrorType?: string;
}) {
  const store = createStore();
  store.set(setWorkspaceContextAtom, { slug: 'acme', workspaceId: runtime.workspaceId });
  if (scan === 'init-failed') {
    store.set(workspaceRuntimeInitFailureAtom, { workspaceSlug: 'acme', errorType: initErrorType });
    return store;
  }
  store.set(runtimeAtom, runtime);
  store.set(docMetaCacheScopeAtom, {
    runtime,
    workspaceId: runtime.workspaceId,
    workspaceSlug: 'acme',
    ready: false,
    ...(scan === 'failed' ? { scanFailure: { errorType: 'UnknownError' } } : {}),
  });
  return store;
}

function renderNode(store: ReturnType<typeof createStore>, node: ReactNode, slug: string | null) {
  act(() => {
    root.render(
      <Provider store={store}>
        <BootShellProvider path={slug ? `/${slug}/chat` : '/'}>
          {slug ? (
            <WorkspaceRouteTargetProvider slug={slug}>{node}</WorkspaceRouteTargetProvider>
          ) : (
            node
          )}
        </BootShellProvider>
      </Provider>
    );
  });
}

function render(store: ReturnType<typeof createStore>) {
  renderNode(
    store,
    <BlockingWaitPlaceholder
      gate="workspace_data"
      variant="content"
      title="Switching workspace"
      description="Finalizing workspace access and permissions."
      recoveryDelayMs={RECOVERY_DELAY_MS}
    />,
    'acme'
  );
}

const text = () => {
  const visible = container.cloneNode(true) as HTMLElement;
  visible.querySelectorAll('style').forEach((style) => style.remove());
  return visible.textContent ?? '';
};
const buttonLabels = () =>
  Array.from(container.querySelectorAll('button')).map((button) => button.textContent);
const click = (label: string) => {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent === label
  );
  if (!button) throw new Error(`No "${label}" button`);
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};
const eventsNamed = (name: string) => app.events.filter((event) => event.name === name);

/** Make `name`'s delete fail, as on a storage backend that cannot open it. */
function failingDelete(name: string) {
  const deleteDatabase = indexedDB.deleteDatabase.bind(indexedDB);
  vi.spyOn(indexedDB, 'deleteDatabase').mockImplementation((target: string) => {
    if (target !== name) return deleteDatabase(target);
    return {
      error: new DOMException('backing store', 'UnknownError'),
      addEventListener: (type: string, listener: () => void) => {
        if (type === 'error') queueMicrotask(listener);
      },
    } as unknown as IDBOpenDBRequest;
  });
}

/** Run the boot-time clear; fake-indexeddb schedules its work on the faked timers. */
async function bootClear(extraNames: string[] = []) {
  await act(async () => {
    const booting = maybeClearLodyCacheOnBoot(extraNames);
    await vi.runAllTimersAsync();
    await booting;
  });
}

beforeEach(async () => {
  await initI18n('en');
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 9, 13, 12));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  localStorage.clear();
  resetBootClearMemoForTests();
  resetAppActivityGapForTests();
  resetBootRequestFailuresForTests();
  resetWorkspaceDataReadyForTests();
  app.reloads = 0;
  app.relaunches = [];
  app.events = [];
  // The desktop bridge: a restart into a clear is a recorded relaunch request.
  (window as unknown as { ipc: unknown }).ipc = {
    invoke: async (channel: string, ...args: unknown[]) => {
      if (channel === 'app.relaunchIntoLocalReset') app.relaunches.push(args[0]);
      return null;
    },
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  delete (window as { ipc?: unknown }).ipc;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const DAMAGED = 'Data stored on this device may be damaged.';
const GENERIC = "Reload first. If that doesn't help";

describe('BlockingWaitPlaceholder', () => {
  it('shows the ways out at once for a failed scan, and clears nothing on its own', () => {
    render(createWorkspaceStore({ scan: 'failed' }));

    expect(text()).toContain("Lody couldn't open this workspace");
    expect(text()).toContain(DAMAGED);
    expect(buttonLabels()).toEqual(
      expect.arrayContaining(['Reload Lody', 'Clear local cache and retry', 'Copy diagnostics'])
    );
    expect(text()).toContain('Clear all local data and sign out');
    // The replica may hold edits that never synced: deleting it is the person's call.
    expect(readPendingLocalClearMode()).toBeNull();
    expect(app.relaunches).toEqual([]);
    expect(app.reloads).toBe(0);
    expect(eventsNamed('workspace/boot_wait_stuck')).toEqual([
      {
        name: 'workspace/boot_wait_stuck',
        properties: expect.objectContaining({
          gate: 'workspace_data',
          failed: true,
          blocker: 'doc_meta_scan_failed',
        }),
      },
    ]);
  });

  it('calls local data damaged only when the runtime failed reading storage', () => {
    render(createWorkspaceStore({ scan: 'init-failed', initErrorType: 'RepoStorageError' }));
    expect(text()).toContain(DAMAGED);

    act(() => {
      root.unmount();
    });
    root = createRoot(container);
    render(createWorkspaceStore({ scan: 'init-failed', initErrorType: 'TypeError' }));

    expect(text()).toContain("Lody couldn't open this workspace");
    expect(text()).toContain(GENERIC);
    expect(text()).not.toContain(DAMAGED);
  });

  it('offers the ways out for a scan that never settles, without clearing on its own', () => {
    render(createWorkspaceStore({ scan: 'pending' }));
    expect(text()).toContain('Switching workspace');

    act(() => {
      vi.advanceTimersByTime(RECOVERY_DELAY_MS - 1);
    });
    expect(text()).toContain('Switching workspace');

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(text()).toContain('This workspace is taking too long to open');
    expect(buttonLabels()).toContain('Clear local cache and retry');
    expect(readPendingLocalClearMode()).toBeNull();
  });

  it('times out a wait that has nothing to do with workspace data', () => {
    // Signing in, before any workspace is chosen: no route target, no scope.
    renderNode(
      createStore(),
      <BlockingWaitPlaceholder
        gate="session_loading"
        variant="boot"
        title="Signing you in"
        recoveryDelayMs={RECOVERY_DELAY_MS}
      />,
      null
    );
    expect(text()).toContain('Signing you in');
    const shell = container.querySelector('[data-lody-boot-shell]');
    expect(shell).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(RECOVERY_DELAY_MS);
    });

    expect(text()).toContain('Lody is taking too long to open');
    expect(text()).toContain(GENERIC);
    expect(buttonLabels()).toContain('Reload Lody');
    expect(container.querySelector('[data-lody-boot-shell]')).toBeNull();
    expect(shell?.hasAttribute('inert')).toBe(true);
    expect(shell?.querySelector('[role="status"]')).toBeNull();
    click('Reload Lody');
    expect(app.reloads).toBe(1);
    expect(eventsNamed('workspace/boot_wait_stuck')[0]?.properties).toMatchObject({
      gate: 'session_loading',
      failed: false,
      blocker: null,
    });
  });

  it('times the whole wait across gates and reports it once, under the gate shown', () => {
    const store = createStore();
    const wait = (gate: string) => (
      <BlockingWaitPlaceholder
        gate={gate}
        variant="boot"
        title="Loading"
        recoveryDelayMs={RECOVERY_DELAY_MS}
      />
    );
    renderNode(store, wait('session_loading'), null);
    act(() => {
      vi.advanceTimersByTime(RECOVERY_DELAY_MS - 1);
    });
    // A route branch further on renders the same placeholder in the same place.
    renderNode(store, wait('workspace_list_loading'), null);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    renderNode(store, wait('workspace_access_loading'), null);

    expect(text()).toContain('Lody is taking too long to open');
    expect(eventsNamed('workspace/boot_wait_stuck').map((event) => event.properties.gate)).toEqual([
      'workspace_list_loading',
    ]);
  });

  it('says so when the last clear could not delete everything, and that retrying restarts', async () => {
    markCacheClearPending();
    failingDelete('lody-loro-repo-db-ws-acme');
    await bootClear(['lody-loro-repo-db-ws-acme']);

    render(createWorkspaceStore({ scan: 'failed' }));

    expect(text()).toContain("The last cache clear couldn't remove everything.");
    expect(text()).toContain('Clearing again restarts Lody');
  });

  it('does not bring up a clear older than a day', async () => {
    failingDelete('lody-loro-repo-db-ws-acme');
    markCacheClearPending();
    await bootClear(['lody-loro-repo-db-ws-acme']);
    vi.setSystemTime(Date.now() + LOCAL_CLEAR_RECORD_RELEVANCE_MS);

    render(createWorkspaceStore({ scan: 'failed' }));

    expect(text()).not.toContain("couldn't remove everything");
  });

  it('reports a boot-time clear that did not get the workspace open', async () => {
    markCacheClearPending();
    await bootClear();

    render(createWorkspaceStore({ scan: 'failed' }));

    expect(eventsNamed('workspace/recovery_outcome')).toEqual([
      {
        name: 'workspace/recovery_outcome',
        properties: expect.objectContaining({
          outcome: 'stuck_again',
          gate: 'workspace_data',
          mode: 'cache',
          clear_ok: true,
        }),
      },
    ]);
  });

  it('puts the gate, blocker, idle gap and last clear into the copied diagnostics', () => {
    localStorage.setItem('lody:lastActiveAt', String(Date.now() - 72 * 3_600_000));
    const stopTracking = installAppActivityTracking();
    render(createWorkspaceStore({ scan: 'failed' }));
    // Nothing is built while the details are closed.
    expect(container.querySelector('pre')).toBeNull();

    click('Technical details');

    const report = container.querySelector('pre')?.textContent ?? '';
    expect(report).toContain('Lody did not open: workspace_data');
    expect(report).toContain('Workspace data blocker: doc_meta_scan_failed');
    expect(report).toContain('Workspace: acme');
    expect(report).toContain('Doc metadata scan error: UnknownError');
    expect(report).toContain('Idle before launch: 72h');
    expect(report).toContain('Local clear in the last day: none');
    stopTracking();
  });
});

/** The `_auth` route's use: record readiness, otherwise wait by kind. */
function WorkspaceDataRoute({
  slug,
  ready,
  accountId = 'user-1',
}: {
  slug: string;
  ready: boolean;
  accountId?: string;
}) {
  useRecordWorkspaceDataReady(ready ? slug : null, accountId);
  if (ready) return <div>Workspace content</div>;
  return <WorkspaceDataWait kind={resolveWorkspaceDataWaitKind(slug, accountId)} />;
}

describe('WorkspaceDataWait', () => {
  const bootShell = () => container.querySelector('[data-lody-boot-shell]');

  it('continues the boot shell on a cold start instead of claiming a switch', () => {
    const store = createWorkspaceStore({ scan: 'pending' });
    renderNode(store, <WorkspaceDataRoute slug="acme" ready={false} />, 'acme');

    expect(bootShell()).not.toBeNull();
    expect(text()).toContain('Loading workspace');
    expect(text()).not.toContain('Switching workspace');
  });

  it('says it is switching only when another workspace was open', () => {
    const store = createWorkspaceStore({ scan: 'pending' });
    renderNode(store, <WorkspaceDataRoute slug="acme" ready />, 'acme');
    renderNode(store, <WorkspaceDataRoute slug="beta" ready={false} />, 'beta');

    expect(bootShell()).toBeNull();
    expect(text()).toContain('Switching workspace');
  });

  it('reloading the open workspace stays a pane wait without claiming a switch', () => {
    const store = createWorkspaceStore({ scan: 'pending' });
    renderNode(store, <WorkspaceDataRoute slug="acme" ready />, 'acme');
    renderNode(store, <WorkspaceDataRoute slug="acme" ready={false} />, 'acme');

    expect(bootShell()).toBeNull();
    expect(text()).toContain('Loading workspace');
    expect(text()).not.toContain('Switching workspace');
  });

  it('treats a workspace opened by another account as a cold start', () => {
    const store = createWorkspaceStore({ scan: 'pending' });
    renderNode(store, <WorkspaceDataRoute slug="acme" ready />, 'acme');
    renderNode(store, <WorkspaceDataRoute slug="beta" ready={false} accountId="user-2" />, 'beta');

    expect(bootShell()).not.toBeNull();
    expect(text()).not.toContain('Switching workspace');
  });

  it('forgets the ready workspace once the authed layout unmounts', () => {
    const store = createWorkspaceStore({ scan: 'pending' });
    renderNode(store, <WorkspaceDataRoute slug="acme" ready />, 'acme');
    // Sign-out leaves the workspace routes.
    renderNode(store, <div>Sign in</div>, null);
    renderNode(store, <WorkspaceDataRoute slug="beta" ready={false} />, 'beta');

    expect(bootShell()).not.toBeNull();
    expect(text()).not.toContain('Switching workspace');
  });

  it('a cold start that never readies still reaches the recovery page', () => {
    const store = createWorkspaceStore({ scan: 'pending' });
    renderNode(store, <WorkspaceDataRoute slug="acme" ready={false} />, 'acme');

    act(() => {
      vi.advanceTimersByTime(BLOCKING_WAIT_RECOVERY_DELAY_MS);
    });
    expect(buttonLabels()).toEqual(expect.arrayContaining(['Reload Lody']));
  });
});

describe('a wait stuck on a failing request', () => {
  const signingIn = () =>
    renderNode(
      createStore(),
      <BlockingWaitPlaceholder
        gate="session_loading"
        variant="boot"
        title="Signing you in"
        recoveryDelayMs={RECOVERY_DELAY_MS}
      />,
      null
    );

  it('says the server failed, and that this device is not the problem', () => {
    // Better Auth's client error for a 5xx from get-session.
    recordBootRequestResult('session', {
      status: 503,
      statusText: 'Service Unavailable',
      code: 'FAILED_TO_GET_SESSION',
      message: 'Failed to get session',
    });
    signingIn();
    act(() => {
      vi.advanceTimersByTime(RECOVERY_DELAY_MS);
    });

    expect(text()).toContain(
      'The server returned an error while checking your sign-in (HTTP 503).'
    );
    expect(text()).toContain("This isn't a problem with the data on this device.");
    expect(text()).not.toContain(DAMAGED);
    expect(eventsNamed('workspace/boot_wait_stuck')[0]?.properties).toMatchObject({
      request_failure_source: 'session',
      request_failure_kind: 'server',
      request_failure_status: 503,
      request_failure_code: 'FAILED_TO_GET_SESSION',
    });

    click('Technical details');
    expect(container.querySelector('pre')?.textContent).toContain(
      'Failing request: session: server · HTTP 503 · FAILED_TO_GET_SESSION · "Failed to get session"'
    );
  });

  it('says the server could not be reached when the request never got an answer', () => {
    recordBootRequestResult('organizations', new TypeError('Load failed'));
    signingIn();
    act(() => {
      vi.advanceTimersByTime(RECOVERY_DELAY_MS);
    });

    expect(text()).toContain("Lody can't reach the server while loading your workspaces.");
  });

  it('drops the message once the request succeeds', () => {
    recordBootRequestResult('session', { status: 502 });
    recordBootRequestResult('session', null);
    signingIn();
    act(() => {
      vi.advanceTimersByTime(RECOVERY_DELAY_MS);
    });

    expect(text()).not.toContain('The server');
    expect(text()).toContain(GENERIC);
  });

  it('classifies request errors and keeps tokens out of the message', () => {
    expect(describeBootRequestError({ status: 429 }).kind).toBe('rate_limited');
    expect(describeBootRequestError({ status: 401 }).kind).toBe('unauthorized');
    expect(describeBootRequestError({ error: { status: 500 } })).toMatchObject({
      kind: 'server',
      status: 500,
    });
    expect(describeBootRequestError(new TypeError('Failed to fetch')).kind).toBe('network');
    expect(
      describeBootRequestError({ status: 0, message: 'Network request failed' })
    ).toMatchObject({ kind: 'network', status: null });
    expect(
      describeBootRequestError({
        status: 400,
        message: 'bad header Bearer abc.def and token Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg',
      }).message
    ).toBe('bad header Bearer … and token …');
  });
});

describe('RouteMessage', () => {
  it('gives a failure without its own retry a reload and the full recovery screen', () => {
    renderNode(
      createStore(),
      <RouteMessage
        gate="workspace_switch_error"
        title="Unable to open workspace"
        description="Please refresh the page and try again."
      />,
      null
    );

    click('Reload Lody');
    expect(app.reloads).toBe(1);
    expect(eventsNamed('workspace/boot_wait_stuck')[0]?.properties).toMatchObject({
      gate: 'workspace_switch_error',
      failed: true,
    });

    click('More ways to recover');
    expect(text()).toContain("Lody couldn't open");
    expect(buttonLabels()).toContain('Clear local cache and retry');
  });

  it('keeps a message that is not a failure free of recovery actions', () => {
    renderNode(createStore(), <RouteMessage gate={null} title="Workspace limit reached" />, null);

    expect(buttonLabels()).toEqual([]);
    expect(eventsNamed('workspace/boot_wait_stuck')).toEqual([]);
  });
});

describe('StuckConnectionBannerContainer', () => {
  it('reports a connection stuck loading and opens the full recovery page', () => {
    // Signed in with a workspace id but no runtime: the case where only the
    // banner, not a route wait, is on screen.
    const store = createStore();
    store.set(setWorkspaceContextAtom, { slug: 'acme', workspaceId: runtime.workspaceId });
    store.set(browserOnlineAtom, true);
    store.set(authTokenAtom, 'auth-token');
    store.set(lodyControlConnectionStateAtom, 'idle');
    renderNode(
      store,
      <TestCloudPlatformProvider>
        <StuckConnectionBannerContainer />
      </TestCloudPlatformProvider>,
      'acme'
    );

    act(() => {
      vi.advanceTimersByTime(STUCK_CONNECTION_HINT_DELAY_MS - 1);
    });
    expect(text()).toBe('');
    expect(eventsNamed('workspace/boot_wait_stuck')).toEqual([]);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(text()).toContain('Still connecting');
    expect(eventsNamed('workspace/boot_wait_stuck')).toEqual([
      {
        name: 'workspace/boot_wait_stuck',
        properties: expect.objectContaining({
          gate: 'control_connection_loading',
          failed: false,
          blocker: 'runtime_missing',
        }),
      },
    ]);

    click('Recover…');
    expect(buttonLabels()).toEqual(
      expect.arrayContaining(['Reload Lody', 'Clear local cache and retry', 'Copy diagnostics'])
    );
    // The full reset replaces the credential, which a cache clear keeps.
    expect(text()).toContain('Clear all local data and sign out');
    expect(readPendingLocalClearMode()).toBeNull();
    expect(eventsNamed('workspace/boot_wait_stuck')).toHaveLength(1);

    // A connection that comes through closes the page instead of trapping the user.
    act(() => {
      store.set(lodyControlConnectionStateAtom, 'online');
    });
    expect(text()).toBe('');
  });
});
