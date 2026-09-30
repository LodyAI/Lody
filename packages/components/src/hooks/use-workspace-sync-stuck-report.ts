import { useEffect, useRef } from 'react';
import { useAtomValue } from 'jotai';
import {
  browserOnlineAtom,
  lodyConnectionUiStateAtom,
  lodyControlConnectionStateAtom,
  type LodyConnectionUiState,
  type LodyControlConnectionState,
} from '@/atoms/control-connection';
import { deferredPostHog } from '@/lib/deferred-posthog';
import { capturePostHogEvent } from '@/lib/posthog-analytics';
import { recordSessionRenderTrace } from '@/lib/session-render-trace';
import type {
  WorkspaceDataScopeBlocker,
  WorkspaceDataScopeState,
} from '@/lib/workspace-data-scope';

/** How long a workspace may stay not ready before it is reported as stuck. */
export const WORKSPACE_SYNC_STUCK_REPORT_DELAY_MS = 30_000;

export type WorkspaceSyncStuckResolution = 'ready' | 'target_changed' | 'unmounted';

/** Thrown into PostHog error tracking only; never raised in product code. */
export class WorkspaceSyncStuckError extends Error {
  constructor(blocker: WorkspaceDataScopeBlocker) {
    super(`Workspace data stuck before ready: ${blocker}`);
    this.name = 'WorkspaceSyncStuckError';
  }
}

type Observation = {
  targetSlug: string | null;
  blocker: WorkspaceDataScopeBlocker | null;
  workspaceId: string | null;
  organizationsReady: boolean;
  docMetaScanErrorType: string | null;
  connectionUiState: LodyConnectionUiState;
  controlConnectionState: LodyControlConnectionState;
  online: boolean;
};

function readVisibility(): string | null {
  return typeof document === 'undefined' ? null : document.visibilityState;
}

function captureSafely(report: () => void): void {
  try {
    report();
  } catch {
    // Diagnostics are side-effect-only: they must never throw into product code.
  }
}

function reportStuck(observation: Observation, stuckMs: number, thresholdMs: number): void {
  const blocker = observation.blocker!;
  const properties = {
    blocker,
    stuck_ms: stuckMs,
    threshold_ms: thresholdMs,
    workspace_id: observation.workspaceId,
    organizations_ready: observation.organizationsReady,
    doc_meta_scan_error_type: observation.docMetaScanErrorType,
    connection_ui_state: observation.connectionUiState,
    control_connection_state: observation.controlConnectionState,
    online: observation.online,
    visibility: readVisibility(),
  };
  console.warn('[workspace-sync] workspace data still not ready', properties);
  recordSessionRenderTrace(
    `workspace-sync stuck ${blocker} ${stuckMs}ms conn=${observation.connectionUiState}`
  );
  captureSafely(() => {
    capturePostHogEvent(deferredPostHog, 'workspace/sync_stuck', properties);
    // Only an online connection makes this an error: offline and reconnecting
    // already explain the wait, and the user sees them as such.
    if (observation.connectionUiState === 'online') {
      deferredPostHog.captureException(new WorkspaceSyncStuckError(blocker), properties);
    }
  });
}

function reportResolved(
  blockerAtReport: WorkspaceDataScopeBlocker,
  latest: Observation,
  resolution: WorkspaceSyncStuckResolution,
  stuckMs: number
): void {
  const properties = {
    blocker_at_report: blockerAtReport,
    final_blocker: resolution === 'ready' ? null : latest.blocker,
    resolution,
    stuck_ms: stuckMs,
    workspace_id: latest.workspaceId,
  };
  console.info('[workspace-sync] stuck workspace data resolved', properties);
  recordSessionRenderTrace(`workspace-sync ${resolution} after ${stuckMs}ms`);
  captureSafely(() => {
    capturePostHogEvent(deferredPostHog, 'workspace/sync_stuck_resolved', properties);
  });
}

/**
 * Reports a workspace whose data scope stays short of `ready` — the sidebar's
 * "Syncing workspace…" — for `delayMs`: one `workspace/sync_stuck` event per
 * episode, a `WorkspaceSyncStuckError` when the connection itself is online,
 * and a `workspace/sync_stuck_resolved` event with the total wait when the
 * episode ends. Purely observational; it never touches the scope.
 */
export function useWorkspaceSyncStuckReport(
  input: {
    targetSlug: string | null;
    scope: WorkspaceDataScopeState | null;
    workspaceId: string | null;
    organizationsReady: boolean;
    docMetaScanErrorType: string | null;
  },
  delayMs = WORKSPACE_SYNC_STUCK_REPORT_DELAY_MS
): void {
  const connectionUiState = useAtomValue(lodyConnectionUiStateAtom);
  const controlConnectionState = useAtomValue(lodyControlConnectionStateAtom);
  const online = useAtomValue(browserOnlineAtom);
  const blocker =
    input.targetSlug !== null && input.scope?.status === 'switching' ? input.scope.blocker : null;

  // Read at report time, so the report describes the moment it fires rather
  // than the moment the wait began.
  const latestRef = useRef<Observation | null>(null);
  latestRef.current = {
    targetSlug: input.targetSlug,
    blocker,
    workspaceId: input.workspaceId,
    organizationsReady: input.organizationsReady,
    docMetaScanErrorType: input.docMetaScanErrorType,
    connectionUiState,
    controlConnectionState,
    online,
  };

  const stuck = blocker !== null;
  const targetSlug = input.targetSlug;
  useEffect(() => {
    if (!stuck) return undefined;
    const startedAt = Date.now();
    let reportedBlocker: WorkspaceDataScopeBlocker | null = null;
    const timer = setTimeout(() => {
      const latest = latestRef.current!;
      reportedBlocker = latest.blocker;
      reportStuck(latest, Date.now() - startedAt, delayMs);
    }, delayMs);
    return () => {
      clearTimeout(timer);
      if (reportedBlocker === null) return;
      // Cleanup runs after the render that ended the episode, so the latest
      // observation says why: ready, another workspace, or neither (unmount).
      const latest = latestRef.current!;
      const resolution: WorkspaceSyncStuckResolution =
        latest.targetSlug !== targetSlug
          ? 'target_changed'
          : latest.blocker === null
            ? 'ready'
            : 'unmounted';
      reportResolved(reportedBlocker, latest, resolution, Date.now() - startedAt);
    };
  }, [stuck, targetSlug, delayMs]);
}
