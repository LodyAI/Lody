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
import {
  TargetRoutedMachineMonitor,
  type MachineMonitorTransportPort,
} from '../src/providers/target-routed-machine-monitor';
import { resolveEffectiveWorkspaceId } from '../src/providers/resolve-effective-workspace-id';
import { atom, createStore } from 'jotai';
import {
  clearWorkspaceContextForSlugAtom,
  currentWorkspaceIdAtom,
  currentWorkspaceSlugAtom,
  setWorkspaceContextAtRevisionAtom,
  setWorkspaceContextAtom,
} from '../src/atoms/workspace-context';

describe('workspace-target-router', () => {
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
      expect(
        router.resolveTransportRoute({ kind: 'doc', id: getSessionRoomId(sessionId) })
      ).toEqual({
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
      expect(
        router.resolveTransportRoute({ kind: 'doc', id: getSessionRoomId(sessionId) })
      ).toEqual({
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
      expect(
        router.resolveTransportRoute({ kind: 'doc', id: getSessionRoomId(sessionId) })
      ).toEqual({
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
});

describe('target-routed-machine-monitor', () => {
  const LOCAL = 'machine-local' as MachineId;
  const REMOTE = 'machine-remote' as MachineId;

  const makePort = () => {
    const unsubscribe = vi.fn();
    const subscribeMachine = vi.fn(() => unsubscribe);
    const forceSample = vi.fn();
    return {
      port: { subscribeMachine, forceSample } satisfies MachineMonitorTransportPort,
      subscribeMachine,
      forceSample,
      unsubscribe,
    };
  };

  describe('TargetRoutedMachineMonitor', () => {
    it('keeps ownership pending, then routes local and remote targets independently', () => {
      const cloud = makePort();
      const local = makePort();
      let identityKnown = false;
      const targetRouter = {
        getPlaneForMachine: (machineId: MachineId) =>
          identityKnown ? (machineId === LOCAL ? ('local' as const) : ('cloud' as const)) : null,
      };
      const monitor = new TargetRoutedMachineMonitor(targetRouter, cloud.port);
      monitor.setLocalTransport(local.port);
      const localListener = vi.fn();
      const remoteListener = vi.fn();

      monitor.subscribeMachine(LOCAL, localListener);
      monitor.subscribeMachine(REMOTE, remoteListener);
      expect(local.subscribeMachine).not.toHaveBeenCalled();
      expect(cloud.subscribeMachine).not.toHaveBeenCalled();

      identityKnown = true;
      monitor.refreshRoutes();
      expect(local.subscribeMachine).toHaveBeenCalledWith(LOCAL, localListener);
      expect(cloud.subscribeMachine).toHaveBeenCalledWith(REMOTE, remoteListener);

      monitor.forceSample(LOCAL);
      monitor.forceSample(REMOTE);
      expect(local.forceSample).toHaveBeenCalledWith(LOCAL);
      expect(cloud.forceSample).toHaveBeenCalledWith(REMOTE);
    });

    it('rebinds subscriptions when local ownership changes', () => {
      const cloud = makePort();
      const local = makePort();
      let localMachineId: MachineId | null = LOCAL;
      const targetRouter = {
        getPlaneForMachine: (machineId: MachineId) =>
          machineId === localMachineId ? ('local' as const) : ('cloud' as const),
      };
      const monitor = new TargetRoutedMachineMonitor(targetRouter, cloud.port);
      monitor.setLocalTransport(local.port);
      monitor.subscribeMachine(LOCAL, vi.fn());

      localMachineId = null;
      monitor.refreshRoutes();

      expect(local.unsubscribe).toHaveBeenCalledTimes(1);
      expect(cloud.subscribeMachine).toHaveBeenCalledWith(LOCAL, expect.any(Function));
    });
  });
});

describe('resolve-effective-workspace-id', () => {
  describe('resolveEffectiveWorkspaceId', () => {
    it('prefers server workspace id when it disagrees with cache (authoritative)', () => {
      expect(
        resolveEffectiveWorkspaceId({
          workspaceSlug: 'b',
          cachedWorkspaceId: 'w2' as WorkspaceId,
          serverWorkspaceId: 'w3' as WorkspaceId,
          prevWorkspaceSlug: 'b',
          prevServerWorkspaceId: 'w2' as WorkspaceId,
        })
      ).toBe('w3');
    });

    it('ignores mismatched server workspace id when it is stale during slug transition', () => {
      expect(
        resolveEffectiveWorkspaceId({
          workspaceSlug: 'b',
          cachedWorkspaceId: 'w2' as WorkspaceId,
          serverWorkspaceId: 'w1' as WorkspaceId,
          prevWorkspaceSlug: 'a',
          prevServerWorkspaceId: 'w1' as WorkspaceId,
        })
      ).toBe('w2');
    });

    it('treats serverWorkspaceId as stale when slug changed but id did not', () => {
      expect(
        resolveEffectiveWorkspaceId({
          workspaceSlug: 'b',
          cachedWorkspaceId: null,
          serverWorkspaceId: 'w1' as WorkspaceId,
          prevWorkspaceSlug: 'a',
          prevServerWorkspaceId: 'w1' as WorkspaceId,
        })
      ).toBeNull();
    });
  });
});

describe('workspace-context', () => {
  const workspaceIdentityAtom = atom((get) => ({
    slug: get(currentWorkspaceSlugAtom),
    workspaceId: get(currentWorkspaceIdAtom),
  }));

  const workspaceId = (value: string) => value as WorkspaceId;

  describe('workspace context atoms', () => {
    it('publishes a complete workspace identity in one observable update', () => {
      const store = createStore();
      store.set(setWorkspaceContextAtom, {
        slug: 'workspace-a',
        workspaceId: workspaceId('workspace-a-id'),
      });

      const observed: Array<{ slug: string | null; workspaceId: WorkspaceId | null }> = [];
      const unsubscribe = store.sub(workspaceIdentityAtom, () => {
        observed.push(store.get(workspaceIdentityAtom));
      });

      store.set(setWorkspaceContextAtom, {
        slug: 'workspace-b',
        workspaceId: workspaceId('workspace-b-id'),
      });
      unsubscribe();

      expect(observed).toEqual([
        { slug: 'workspace-b', workspaceId: workspaceId('workspace-b-id') },
      ]);
    });

    it('clears the previous id in the same update when the route slug changes', () => {
      const store = createStore();
      store.set(setWorkspaceContextAtom, {
        slug: 'workspace-a',
        workspaceId: workspaceId('workspace-a-id'),
      });

      store.set(currentWorkspaceSlugAtom, 'workspace-b');

      expect(store.get(workspaceIdentityAtom)).toEqual({
        slug: 'workspace-b',
        workspaceId: null,
      });
    });

    it('does not let an old route cleanup clear a newer target', () => {
      const store = createStore();
      store.set(setWorkspaceContextAtom, {
        slug: 'workspace-c',
        workspaceId: workspaceId('workspace-c-id'),
      });

      store.set(clearWorkspaceContextForSlugAtom, 'workspace-b');

      expect(store.get(workspaceIdentityAtom)).toEqual({
        slug: 'workspace-c',
        workspaceId: workspaceId('workspace-c-id'),
      });
    });

    it('rejects a stale mutation continuation after navigation publishes a newer identity', () => {
      const store = createStore();
      const revision = store.set(setWorkspaceContextAtom, {
        slug: null,
        workspaceId: null,
      });
      store.set(setWorkspaceContextAtom, {
        slug: 'workspace-b',
        workspaceId: workspaceId('workspace-b-id'),
      });

      const published = store.set(setWorkspaceContextAtRevisionAtom, {
        revision,
        context: {
          slug: 'workspace-a',
          workspaceId: workspaceId('workspace-a-id'),
        },
      });

      expect(published).toBe(false);
      expect(store.get(workspaceIdentityAtom)).toEqual({
        slug: 'workspace-b',
        workspaceId: workspaceId('workspace-b-id'),
      });
    });
  });
});
