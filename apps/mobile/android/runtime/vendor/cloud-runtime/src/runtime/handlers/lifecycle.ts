import { forgetSettings } from '../settings';
import { forgetShortcuts } from '../prompt-shortcuts';
import {
  closeSession,
  ensureSession,
  openSession,
  loadOlderSession,
  releaseReserve,
  traceSessionResume,
  traceStalledReads,
  startAcceptedInputs,
  stopSessions,
  resumeAcceptedInputs,
} from '../session';
import type { RuntimeContext } from './context.ts';
import { sessionActionMeta } from '../fork-session';

import {
  machineSupportsSessionHistoryProtocol,
  machineSupportsSessionHistoryIncremental,
  machineSupportsSessionHistoryWatch,
  machineSupportsSessionHistoryPatches,
  machineSupportsSessionHistoryInspection,
  machineSupportsSessionInputAcceptance,
  machineSupportsSessionInputDispatch,
  type SendMetadata,
} from '../upstream-roost.js';

export function registerLifecycle(ctx: RuntimeContext) {
  const { channel, state, getGrant, emitSession, markDispatch } = ctx;
  const getDocMeta = (roomId: string): SendMetadata | undefined => {
    const replica = state.metaReplica;
    if (!replica || state.unhealthy.has('meta')) return undefined;
    const exists = replica.flock.get(['e', roomId]);
    if (exists === false) return { exists: false };
    const meta = sessionActionMeta(
      replica.flock.get(['m', roomId]),
      replica.flock.scan({ prefix: ['m', roomId] }),
      exists,
    );
    return meta
      ? {
          exists: true,
          meta: { id: roomId.slice(roomId.indexOf('-') + 1), ...meta },
        }
      : undefined;
  };
  const resolveTarget = (id: string) => {
    const workspace = state.workspace;
    const user = state.userId;
    const isCurrent = () =>
      state.workspace === workspace && state.userId === user;
    const resolve = () => {
      if (!isCurrent()) throw new Error('workspace_changed');
      const meta = getDocMeta(`session-${id}`)?.meta;
      if (!meta) return undefined;
      if (meta.historyBackend === 'loro') return { backend: 'loro' as const };
      if (typeof meta.machineId !== 'string' || !meta.machineId)
        return undefined;
      if (meta.historyBackend === undefined)
        return { backend: 'loro' as const };
      if (meta.historyBackend !== 'roost')
        throw new Error('history_backend_unsupported');
      if (!user) return undefined;
      const machine = getDocMeta(`machine-${meta.machineId}`)?.meta;
      const capabilityCarrier = machine as
        | {
            protocolCapabilities?: Record<string, unknown>;
          }
        | undefined;
      if (!machineSupportsSessionHistoryProtocol(capabilityCarrier))
        throw new Error('roost_history_unsupported');
      return {
        backend: 'roost' as const,
        accountId: user,
        machineId: meta.machineId as string,
        incremental:
          machineSupportsSessionHistoryIncremental(capabilityCarrier),
        watch: machineSupportsSessionHistoryWatch(capabilityCarrier),
        acceptsInput: machineSupportsSessionInputAcceptance(capabilityCarrier),
        dispatchesInput: machineSupportsSessionInputDispatch(capabilityCarrier),
        isArchived: meta.isArchived === true,
        latestUserMsgId:
          typeof meta.latestUserMsgId === 'string'
            ? meta.latestUserMsgId
            : undefined,
        patches: machineSupportsSessionHistoryPatches(capabilityCarrier),
        coherentInspection:
          machineSupportsSessionHistoryInspection(capabilityCarrier),
        isCurrent,
      };
    };
    resolve.isCurrent = isCurrent;
    resolve.legacyFallbackAllowed = () => {
      const replica = state.metaReplica;
      if (!replica) return true;
      const room = `session-${id}`;
      const meta = sessionActionMeta(
        replica.flock.get(['m', room]),
        replica.flock.scan({ prefix: ['m', room] }),
        replica.flock.get(['e', room]),
      );
      return !meta?.historyBackend || meta.historyBackend === 'loro';
    };
    return resolve;
  };
  channel.handle('ensureSession', async ({ sessionId }) => {
    const result = ensureSession(
      sessionId,
      state.workspace,
      getGrant,
      emitSession,
      markDispatch,
      resolveTarget(sessionId),
    );
    ctx.publishSubscriptions();
    await result;
    return {};
  });
  let scopeStartVersion = 0;
  channel.handle(
    'start',
    async ({ workspaceId, userId, active, knownRepos }) => {
      const version = ++scopeStartVersion;
      if (workspaceId !== state.workspace || userId !== state.userId) {
        forgetSettings();
        forgetShortcuts();
        await ctx.disposeProviderOperations?.();
      }
      if (version !== scopeStartVersion) return {};
      if (workspaceId !== state.workspace || userId !== state.userId)
        stopSessions();
      state.workspace = workspaceId;
      state.userId = userId;
      startAcceptedInputs({
        accountId: userId,
        workspaceId,
        getGrant,
        emit: emitSession,
        markDispatch,
        async getDocMeta(roomId) {
          if (state.workspace !== workspaceId || state.userId !== userId)
            throw new Error('workspace_changed');
          if (!state.metaReplica || state.unhealthy.has('meta'))
            throw new Error('metadata_not_ready');
          return getDocMeta(roomId);
        },
        resolveTarget: (id) => {
          if (state.workspace !== workspaceId || state.userId !== userId)
            throw new Error('workspace_changed');
          return resolveTarget(id);
        },
      });
      state.knownProjects = Object.entries(knownRepos ?? {}).map(
        ([id, repoFullName]) => ({ id, repoFullName }),
      );
      ctx.watch('meta');
      if (active) ctx.startPresence();
      return {};
    },
  );
  channel.handle('setActive', ({ active }) => {
    if (!state.workspace) return {};
    if (active) {
      ctx.startPresence();
      traceSessionResume();
      resumeAcceptedInputs();
    } else ctx.stopPresence();
    return {};
  });
  channel.handle('ping', () => {
    traceStalledReads();
    return {};
  });
  channel.handle('openSession', async ({ sessionId }) => {
    const result = openSession(
      sessionId,
      state.workspace,
      getGrant,
      emitSession,
      markDispatch,
      true,
      resolveTarget(sessionId),
    );
    ctx.publishSubscriptions();
    await result;
    return {};
  });
  channel.handle('loadOlderSession', async ({ sessionId }) => {
    await loadOlderSession(sessionId);
    return {};
  });
  channel.handle('closeSession', () => {
    closeSession();
    ctx.publishSubscriptions();
    return {};
  });
  channel.handle('releaseReserve', ({ sessionId }) => {
    releaseReserve(sessionId);
    ctx.publishSubscriptions();
    return {};
  });
  channel.handle('restoreSessions', ({ ids, current, reserved }) => {
    const { workspace } = state;
    for (const id of ids) {
      if (id === current || reserved.includes(id)) continue;
      void openSession(
        id,
        workspace,
        getGrant,
        emitSession,
        markDispatch,
        false,
        resolveTarget(id),
      );
    }
    for (const id of reserved)
      void ensureSession(
        id,
        workspace,
        getGrant,
        emitSession,
        markDispatch,
        resolveTarget(id),
      ).catch(() => {});
    if (current)
      void openSession(
        current,
        workspace,
        getGrant,
        emitSession,
        markDispatch,
        true,
        resolveTarget(current),
      );
    else closeSession();
    ctx.publishSubscriptions();
    return {};
  });
}
