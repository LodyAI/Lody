import { describe, expect, it, vi } from 'vitest';
import {
  getAgentConfigRoomId,
  getCodeCollabFileIndexFlockDocId,
  getMachineRoomId,
  getSessionRoomId,
  type AgentConfigId,
  type MachineId,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';

import { WorkspaceTargetRouter } from '../src/providers/workspace-target-router';

const workspaceId = 'workspace-1' as WorkspaceId;
const localMachineId = 'machine-local' as MachineId;
const remoteMachineId = 'machine-remote' as MachineId;

function createRouter(metaByRoomId: Record<string, unknown> = {}) {
  const getDocMeta = vi.fn(async (roomId: string) => {
    const meta = metaByRoomId[roomId];
    return meta === undefined ? undefined : { meta };
  });
  const onRouteChange = vi.fn();
  const router = new WorkspaceTargetRouter({
    repo: { getDocMeta } as never,
    syncMode: 'dual',
    onRouteChange,
  });
  return { router, getDocMeta, onRouteChange };
}

describe('WorkspaceTargetRouter', () => {
  it('mounts unknown-owner rooms pure cloud until ownership resolves', () => {
    const { router } = createRouter();
    const sessionId = 'session-pending' as SessionId;

    expect(router.getPlaneForMachine(remoteMachineId)).toBeNull();
    // Web-isomorphic fallback: mounting the "wrong" plane only costs redundant
    // delivery; ownership resolution refreshes routes and adds the local member.
    expect(router.resolveTransportRoute({ kind: 'doc', id: getSessionRoomId(sessionId) })).toEqual({
      transportIds: ['cloud'],
    });
    expect(
      router.resolveTransportRoute({
        kind: 'flock-doc',
        id: getCodeCollabFileIndexFlockDocId(workspaceId, sessionId),
      })
    ).toEqual({ transportIds: ['cloud'] });

    router.setLocalMachineId(localMachineId);
    router.rememberSessionTarget(sessionId, localMachineId);
    expect(router.resolveTransportRoute({ kind: 'doc', id: getSessionRoomId(sessionId) })).toEqual({
      transportIds: ['local', 'cloud'],
    });
  });

  it('resolves a prepared session only after local identity is known', async () => {
    const { router } = createRouter();
    const sessionId = 'session-waiting-for-identity' as SessionId;
    const prepared = router.prepareSessionTarget(sessionId, localMachineId);
    let settled = false;
    void prepared.finally(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    router.setLocalMachineId(localMachineId);
    await expect(prepared).resolves.toBe('local');
  });

  it('dual-homes meta with local as the logical primary', () => {
    const { router } = createRouter();

    expect(router.resolveTransportRoute({ kind: 'meta', id: 'meta' })).toEqual({
      transportIds: ['local', 'cloud'],
    });
  });

  it('dual-homes local rooms with local primary and routes remote rooms cloud-only', () => {
    const { router } = createRouter();
    const localSessionId = 'session-dual-home' as SessionId;
    const remoteSessionId = 'session-cloud-only' as SessionId;
    router.setLocalMachineId(localMachineId);
    router.rememberSessionTarget(localSessionId, localMachineId);
    router.rememberSessionTarget(remoteSessionId, remoteMachineId);

    expect(
      router.resolveTransportRoute({ kind: 'doc', id: getSessionRoomId(localSessionId) })
    ).toEqual({ transportIds: ['local', 'cloud'] });
    expect(
      router.resolveTransportRoute({
        kind: 'flock-doc',
        id: getCodeCollabFileIndexFlockDocId(workspaceId, localSessionId),
      })
    ).toEqual({ transportIds: ['local', 'cloud'] });
    expect(
      router.resolveTransportRoute({ kind: 'doc', id: getSessionRoomId(remoteSessionId) })
    ).toEqual({ transportIds: ['cloud'] });
  });

  it('rejects an ownership change instead of rerouting a live session', async () => {
    const { router } = createRouter();
    const sessionId = 'session-immutable' as SessionId;
    const roomId = getSessionRoomId(sessionId);
    router.setLocalMachineId(localMachineId);
    router.rememberSessionTarget(sessionId, localMachineId);

    expect(() => router.rememberSessionTarget(sessionId, remoteMachineId)).toThrow(
      'workspace_target_conflict'
    );
    await expect(router.prepareDocTarget(roomId, { machineId: remoteMachineId })).rejects.toThrow(
      'workspace_target_conflict'
    );
    expect(router.getPlaneForSession(sessionId)).toBe('local');
  });

  it('resolves legacy agent docs from their persisted machine owner', async () => {
    const configId = 'agent-local' as AgentConfigId;
    const roomId = getAgentConfigRoomId(configId);
    const { router } = createRouter({
      [roomId]: { id: configId, machineId: localMachineId },
    });
    router.setLocalMachineId(localMachineId);

    await expect(router.prepareDocTarget(roomId)).resolves.toBe('local');
  });

  it('keeps pre-association agent config cleanup on the offline-capable local author', async () => {
    const configId = 'agent-without-owner' as AgentConfigId;
    const roomId = getAgentConfigRoomId(configId);
    const { router } = createRouter({
      [roomId]: { id: configId, name: 'Legacy config' },
    });
    router.setLocalMachineId(localMachineId);

    await expect(router.prepareDocTarget(roomId)).resolves.toBe('local');
  });

  it('uses cloud semantics without requiring ownership in a non-local-first runtime', async () => {
    const getDocMeta = vi.fn();
    const router = new WorkspaceTargetRouter({
      repo: { getDocMeta } as never,
      syncMode: 'cloud',
    });
    const sessionId = 'legacy-session-without-owner' as SessionId;

    expect(router.getPlaneForMachine(localMachineId)).toBe('cloud');
    expect(
      router.resolveTransportRoute({ kind: 'doc', id: getMachineRoomId(localMachineId) })
    ).toEqual({ transportIds: ['cloud'] });
    await expect(router.prepareSessionTarget(sessionId)).resolves.toBe('cloud');
    await expect(router.prepareDocTarget(getSessionRoomId(sessionId))).resolves.toBe('cloud');
    expect(getDocMeta).not.toHaveBeenCalled();
  });
});

describe('WorkspaceTargetRouter local-only mode', () => {
  it('routes every room to the local plane without ownership or identity', async () => {
    const getDocMeta = vi.fn();
    const router = new WorkspaceTargetRouter({
      repo: { getDocMeta } as never,
      syncMode: 'local',
    });
    const sessionId = 'session-local-only' as SessionId;

    // No setLocalMachineId call: local-only must not wait for identity.
    expect(router.getPlaneForMachine(remoteMachineId)).toBe('local');
    expect(router.resolveTransportRoute({ kind: 'meta', id: 'meta' })).toEqual({
      transportIds: ['local'],
    });
    expect(router.resolveTransportRoute({ kind: 'doc', id: getSessionRoomId(sessionId) })).toEqual({
      transportIds: ['local'],
    });
    // Workspace-scoped Flock rooms (e.g. the task index) fall back to cloud in
    // dual mode; local-only must route them local too.
    expect(router.resolveTransportRoute({ kind: 'flock-doc', id: 'ws-1:ti' })).toEqual({
      transportIds: ['local'],
    });
    expect(router.getPlaneForFlockDoc('ws-1:ti')).toBe('local');
    await expect(router.prepareSessionTarget(sessionId)).resolves.toBe('local');
    await expect(router.prepareDocTarget(getSessionRoomId(sessionId))).resolves.toBe('local');
    await expect(router.resolvePlaneForMachine(remoteMachineId)).resolves.toBe('local');
    expect(getDocMeta).not.toHaveBeenCalled();
  });
});
