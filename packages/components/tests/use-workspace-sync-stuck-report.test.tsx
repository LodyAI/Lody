// @vitest-environment jsdom

import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import type { WorkspaceId } from '@lody/shared';

const postHog = vi.hoisted(() => ({
  events: [] as Array<{ name: string; properties: Record<string, unknown> }>,
  exceptions: [] as Array<{ error: Error; properties: Record<string, unknown> }>,
}));

vi.mock('../src/lib/deferred-posthog', () => ({
  deferredPostHog: {
    capture: (name: string, properties: Record<string, unknown>) =>
      postHog.events.push({ name, properties }),
    captureException: (error: Error, properties: Record<string, unknown>) =>
      postHog.exceptions.push({ error, properties }),
  },
}));

import { browserOnlineAtom, lodyControlConnectionStateAtom } from '../src/atoms/control-connection';
import type { WorkspaceRuntime } from '../src/atoms/runtime';
import {
  WORKSPACE_SYNC_STUCK_REPORT_DELAY_MS,
  useWorkspaceSyncStuckReport,
} from '../src/hooks/use-workspace-sync-stuck-report';
import {
  clearSessionRenderTraceForTest,
  getSessionRenderTraceText,
} from '../src/lib/session-render-trace';
import type {
  WorkspaceDataScopeBlocker,
  WorkspaceDataScopeState,
} from '../src/lib/workspace-data-scope';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const runtime = {
  workspaceSlug: 'acme',
  workspaceId: 'ws-acme' as WorkspaceId,
} as WorkspaceRuntime;

const switching = (blocker: WorkspaceDataScopeBlocker, targetSlug = 'acme') =>
  ({ status: 'switching', targetSlug, blocker }) satisfies WorkspaceDataScopeState;
const ready: WorkspaceDataScopeState = {
  status: 'ready',
  targetSlug: 'acme',
  workspaceId: runtime.workspaceId,
  runtime,
};

type Input = Parameters<typeof useWorkspaceSyncStuckReport>[0];

function Probe({ input }: { input: Input }) {
  useWorkspaceSyncStuckReport(input);
  return null;
}

let root: Root;
let store: ReturnType<typeof createStore>;

function render(scope: WorkspaceDataScopeState | null, overrides: Partial<Input> = {}) {
  const input: Input = {
    targetSlug: scope?.targetSlug ?? null,
    scope,
    workspaceId: 'ws-acme',
    organizationsReady: true,
    docMetaScanErrorType: null,
    ...overrides,
  };
  act(() => {
    root.render(createElement(Provider, { store }, createElement(Probe, { input })));
  });
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-26T00:00:00Z'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  postHog.events.length = 0;
  postHog.exceptions.length = 0;
  clearSessionRenderTraceForTest();
  store = createStore();
  store.set(lodyControlConnectionStateAtom, 'online');
  store.set(browserOnlineAtom, true);
  root = createRoot(document.createElement('div'));
});

afterEach(() => {
  act(() => root.unmount());
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('useWorkspaceSyncStuckReport', () => {
  it('reports nothing when the workspace becomes ready before the threshold', () => {
    render(switching('doc_meta_scan_pending'));
    advance(WORKSPACE_SYNC_STUCK_REPORT_DELAY_MS - 1);
    render(ready);
    advance(WORKSPACE_SYNC_STUCK_REPORT_DELAY_MS);

    expect(postHog.events).toEqual([]);
    expect(postHog.exceptions).toEqual([]);
  });

  it('reports a stuck online workspace as an error, then how long it took to recover', () => {
    render(switching('runtime_missing'));
    advance(10_000);
    // The blocker moves on mid-wait; the report names the one at report time.
    render(switching('doc_meta_scan_failed'), { docMetaScanErrorType: 'TypeError' });
    advance(WORKSPACE_SYNC_STUCK_REPORT_DELAY_MS - 10_000);

    expect(postHog.events).toEqual([
      {
        name: 'workspace/sync_stuck',
        properties: expect.objectContaining({
          blocker: 'doc_meta_scan_failed',
          stuck_ms: WORKSPACE_SYNC_STUCK_REPORT_DELAY_MS,
          threshold_ms: WORKSPACE_SYNC_STUCK_REPORT_DELAY_MS,
          workspace_id: 'ws-acme',
          doc_meta_scan_error_type: 'TypeError',
          connection_ui_state: 'online',
          control_connection_state: 'online',
          online: true,
        }),
      },
    ]);
    expect(postHog.exceptions).toHaveLength(1);
    expect(postHog.exceptions[0]!.error).toMatchObject({
      name: 'WorkspaceSyncStuckError',
      message: 'Workspace data stuck before ready: doc_meta_scan_failed',
    });

    advance(12_000);
    render(ready);

    expect(postHog.events[1]).toEqual({
      name: 'workspace/sync_stuck_resolved',
      properties: expect.objectContaining({
        blocker_at_report: 'doc_meta_scan_failed',
        final_blocker: null,
        resolution: 'ready',
        stuck_ms: 42_000,
      }),
    });
    expect(getSessionRenderTraceText()).toContain('workspace-sync stuck doc_meta_scan_failed');
    expect(getSessionRenderTraceText()).toContain('workspace-sync ready after 42000ms');
  });

  it('reports only one stuck event per wait, however long it lasts', () => {
    render(switching('doc_meta_scan_pending'));
    advance(WORKSPACE_SYNC_STUCK_REPORT_DELAY_MS * 10);

    expect(postHog.events.map((event) => event.name)).toEqual(['workspace/sync_stuck']);
  });

  it('keeps an offline wait out of error tracking but still records it', () => {
    store.set(browserOnlineAtom, false);
    store.set(lodyControlConnectionStateAtom, 'offline');
    render(switching('runtime_missing'));
    advance(WORKSPACE_SYNC_STUCK_REPORT_DELAY_MS);

    expect(postHog.events[0]).toEqual({
      name: 'workspace/sync_stuck',
      properties: expect.objectContaining({ connection_ui_state: 'offline', online: false }),
    });
    expect(postHog.exceptions).toEqual([]);
  });

  it('closes a reported wait as target_changed or unmounted when it never became ready', () => {
    render(switching('doc_meta_scan_pending'));
    advance(WORKSPACE_SYNC_STUCK_REPORT_DELAY_MS);
    render(switching('runtime_other_workspace', 'other'));

    expect(postHog.events[1]).toEqual({
      name: 'workspace/sync_stuck_resolved',
      properties: expect.objectContaining({
        resolution: 'target_changed',
        final_blocker: 'runtime_other_workspace',
      }),
    });

    advance(WORKSPACE_SYNC_STUCK_REPORT_DELAY_MS);
    act(() => root.unmount());
    root = createRoot(document.createElement('div'));

    expect(postHog.events.map((event) => event.name)).toEqual([
      'workspace/sync_stuck',
      'workspace/sync_stuck_resolved',
      'workspace/sync_stuck',
      'workspace/sync_stuck_resolved',
    ]);
    expect(postHog.events[3]!.properties).toEqual(
      expect.objectContaining({
        resolution: 'unmounted',
        blocker_at_report: 'runtime_other_workspace',
      })
    );
  });
});
