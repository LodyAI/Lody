import { describe, expect, it } from 'vitest';
import type { WorkspaceId } from '@lody/shared';

import {
  resolveSessionDetailPresenceState,
  type SessionDetailPresenceState,
} from '../src/lib/session-detail-presence';

const expectState = (
  state: SessionDetailPresenceState,
  expected: SessionDetailPresenceState
): void => {
  expect(state).toBe(expected);
};

describe('resolveSessionDetailPresenceState', () => {
  it('returns resolved from local cache even when offline', () => {
    expectState(
      resolveSessionDetailPresenceState({
        hasActiveSession: true,
        docMetaCacheReady: true,
        runtimeInitializing: false,
        runtimeWorkspaceId: 'workspace-1' as WorkspaceId,
        currentWorkspaceId: 'workspace-1' as WorkspaceId,
        controlConnectionState: 'idle',
      }),
      'resolved'
    );
  });

  it('keeps loading while the doc meta cache is still bootstrapping', () => {
    expectState(
      resolveSessionDetailPresenceState({
        hasActiveSession: false,
        docMetaCacheReady: false,
        runtimeInitializing: false,
        runtimeWorkspaceId: 'workspace-1' as WorkspaceId,
        currentWorkspaceId: 'workspace-1' as WorkspaceId,
        controlConnectionState: 'online',
      }),
      'loading'
    );
  });

  it('keeps loading while runtime is still pointed at another workspace', () => {
    expectState(
      resolveSessionDetailPresenceState({
        hasActiveSession: false,
        docMetaCacheReady: true,
        runtimeInitializing: false,
        runtimeWorkspaceId: 'workspace-1' as WorkspaceId,
        currentWorkspaceId: 'workspace-2' as WorkspaceId,
        controlConnectionState: 'online',
      }),
      'loading'
    );
  });

  it('keeps loading when session not in cache and remote sync not yet completed', () => {
    expectState(
      resolveSessionDetailPresenceState({
        hasActiveSession: false,
        docMetaCacheReady: true,
        runtimeInitializing: false,
        runtimeWorkspaceId: 'workspace-1' as WorkspaceId,
        currentWorkspaceId: 'workspace-1' as WorkspaceId,
        controlConnectionState: 'connecting',
      }),
      'loading'
    );
  });

  it('returns not-found after remote sync has completed and session is absent', () => {
    expectState(
      resolveSessionDetailPresenceState({
        hasActiveSession: false,
        docMetaCacheReady: true,
        runtimeInitializing: false,
        runtimeWorkspaceId: 'workspace-1' as WorkspaceId,
        currentWorkspaceId: 'workspace-1' as WorkspaceId,
        controlConnectionState: 'online',
      }),
      'not-found'
    );
  });

  it('returns not-found when reconnecting (initial sync was completed before)', () => {
    expectState(
      resolveSessionDetailPresenceState({
        hasActiveSession: false,
        docMetaCacheReady: true,
        runtimeInitializing: false,
        runtimeWorkspaceId: 'workspace-1' as WorkspaceId,
        currentWorkspaceId: 'workspace-1' as WorkspaceId,
        controlConnectionState: 'reconnecting',
      }),
      'not-found'
    );
  });
});
