import { machineRpc } from '../machine-rpc';
import {
  androidEmulatorControl,
  createPreview,
  iosSimulatorControl,
  previewTarget,
  revokePreview,
} from '../preview';
import { sessionDoc } from '../session';
import { sessionActionMeta } from '../fork-session';
import { createMobileRoostSessionData } from '../upstream-roost-history';
import { readShareHistory } from '../sharing/history.ts';
import { createSharingRuntime } from '../sharing/runtime.ts';
import { machineFor, type RuntimeContext } from './context.ts';

export function registerSharing(ctx: RuntimeContext) {
  const { channel, state, getGrant } = ctx;
  const shareRuntime = createSharingRuntime({
    sessions: () => state.catalogs.get('meta')?.sessions ?? [],
    history: async (id, signal) => {
      const flock = state.metaReplica?.flock;
      if (!flock || state.unhealthy.has('meta'))
        throw new Error('metadata_not_ready');
      const room = `session-${id}`;
      const meta = sessionActionMeta(
        flock.get(['m', room]),
        flock.scan({ prefix: ['m', room] }),
        flock.get(['e', room]),
      );
      if (!meta) throw new Error('session_not_ready');
      if (meta.historyBackend === undefined || meta.historyBackend === 'loro')
        return readShareHistory(state.workspace, id, getGrant, signal);
      if (
        meta.historyBackend !== 'roost' ||
        typeof meta.machineId !== 'string' ||
        !meta.machineId
      )
        throw new Error('history_backend_unsupported');
      const workspace = state.workspace;
      const user = state.userId;
      const session = createMobileRoostSessionData({
        accountId: user,
        workspaceId: workspace,
        machineId: meta.machineId,
        sessionId: id,
        getGrant,
        signal,
        isCurrent: () => state.workspace === workspace && state.userId === user,
      });
      try {
        return (await session.snapshots.capture()).history;
      } finally {
        session.dispose();
      }
    },
    progress: (progress) => channel.emit('shareProgress', progress),
    broker: ctx.broker,
  });
  function previewControl(sessionId: string, userId: string) {
    const { workspaceId, machineId, getGrant } = machineFor(
      ctx,
      sessionId,
      '/',
    );
    return {
      workspaceId,
      machineId,
      sessionId,
      userId,
      rpc: (method: string, params: object, timeoutMs: number) =>
        machineRpc(
          workspaceId,
          machineId,
          method,
          params,
          getGrant,
          AbortSignal.timeout(timeoutMs),
        ),
      mintToken: (intent: object) =>
        ctx.broker('previewToken', { intent }).catch(() => undefined),
    };
  }
  channel.handle('sessionSharing', async (args) => {
    if (args.workspaceId !== state.workspace)
      throw new Error('share_workspace_changed');
    const shared = await shareRuntime(args);
    return shared ? { outcome: 'state', ...shared } : { outcome: 'closed' };
  });
  channel.handle('sessionPreview', async (args) => {
    const doc = sessionDoc(args.sessionId);
    const target = doc && previewTarget(doc);
    if (!target) return { error: 'unavailable' };
    const control = previewControl(args.sessionId, args.userId);
    return args.action === 'revoke'
      ? revokePreview(control)
      : createPreview({ ...control, target });
  });
  function machineCapabilities(machineId: string) {
    const room = `machine-${machineId}`;
    const meta = state.metaReplica!.flock;
    return (meta.get(['m', room, 'protocolCapabilities']) ??
      (meta.get(['m', room]) as Record<string, unknown>)
        ?.protocolCapabilities) as Record<string, number> | undefined;
  }
  channel.handle('iosSimulatorControl', async (args) => {
    if (args.workspaceId !== state.workspace)
      throw new Error('metadata_not_ready');
    const control = previewControl(args.sessionId, args.userId);
    const capabilities = machineCapabilities(control.machineId);
    // Older CLIs drop unknown methods without replying.
    if (!((capabilities?.iosSimulator ?? 0) >= 1))
      return { error: 'unsupported', capabilities };
    return iosSimulatorControl({ ...control, command: args.command });
  });
  channel.handle('androidEmulatorControl', async (args) => {
    if (args.workspaceId !== state.workspace)
      throw new Error('metadata_not_ready');
    const control = previewControl(args.sessionId, args.userId);
    const capabilities = machineCapabilities(control.machineId);
    if (!((capabilities?.androidEmulator ?? 0) >= 1))
      return { error: 'unsupported', capabilities };
    let command = args.command;
    // The CLI's strict schema rejects `quality` unless it advertises the preset.
    if (
      command.action === 'start' &&
      !((capabilities?.androidEmulatorQuality ?? 0) >= 1)
    ) {
      const { quality: _quality, ...rest } = command;
      command = rest;
    }
    return androidEmulatorControl({ ...control, command });
  });
}
