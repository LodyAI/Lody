import { machineRpc } from '../machine-rpc';
import {
  createPreview,
  iosSimulatorControl,
  previewTarget,
  revokePreview,
} from '../preview';
import { sessionDoc } from '../session';
import { readShareHistory } from '../sharing/history.ts';
import { createSharingRuntime } from '../sharing/runtime.ts';
import { machineFor, type RuntimeContext } from './context.ts';

export function registerSharing(ctx: RuntimeContext) {
  const { channel, state, getGrant } = ctx;
  const shareRuntime = createSharingRuntime({
    sessions: () => state.catalogs.get('meta')?.sessions ?? [],
    history: (id, signal) =>
      readShareHistory(state.workspace, id, getGrant, signal),
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
  channel.handle('iosSimulatorControl', async (args) => {
    if (args.workspaceId !== state.workspace)
      throw new Error('metadata_not_ready');
    const control = previewControl(args.sessionId, args.userId);
    const room = `machine-${control.machineId}`;
    const meta = state.metaReplica!.flock;
    const capabilities = (meta.get(['m', room, 'protocolCapabilities']) ??
      (meta.get(['m', room]) as Record<string, unknown>)
        ?.protocolCapabilities) as Record<string, number> | undefined;
    // Older CLIs drop unknown methods without replying.
    if (!((capabilities?.iosSimulator ?? 0) >= 1))
      return { error: 'unsupported', capabilities };
    return iosSimulatorControl({ ...control, command: args.command });
  });
}
