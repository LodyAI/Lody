import {
  closeSession,
  ensureSession,
  openSession,
  releaseReserve,
  traceSessionResume,
  traceStalledReads,
} from '../session';
import type { RuntimeContext } from './context.ts';

export function registerLifecycle(ctx: RuntimeContext) {
  const { channel, state, getGrant, emitSession, markDispatch } = ctx;
  channel.handle('ensureSession', async ({ sessionId }) => {
    const result = ensureSession(
      sessionId,
      state.workspace,
      getGrant,
      emitSession,
      markDispatch,
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
      if (workspaceId !== state.workspace || userId !== state.userId)
        await ctx.disposeProviderOperations?.();
      if (version !== scopeStartVersion) return {};
      state.workspace = workspaceId;
      state.userId = userId;
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
    );
    ctx.publishSubscriptions();
    await result;
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
      );
    }
    for (const id of reserved)
      void ensureSession(
        id,
        workspace,
        getGrant,
        emitSession,
        markDispatch,
      ).catch(() => {});
    if (current)
      void openSession(current, workspace, getGrant, emitSession, markDispatch);
    else closeSession();
    ctx.publishSubscriptions();
    return {};
  });
}
