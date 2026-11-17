import type {
  PromptShortcut,
  PromptShortcutIndexEntry,
  ShortcutRequest,
} from '../../models/prompt-shortcuts.ts';
import { promptShortcuts } from '../prompt-shortcuts';
import { roleSettings } from '../role-settings';
import { remoteSettings } from '../settings';
import { agentProviders } from '../provider-settings';
import {
  providerDetail,
  probeProvider,
  MODEL_OPTIONS_READ_TIMEOUT_MS,
  readProvider,
} from '../provider-detail';
import { createProviderRpc } from '../provider-rpc';
import { projectRows } from '../../protocol/catalog';
import { scopedShortcutCloud, type RuntimeContext } from './context.ts';

export function registerSettings(ctx: RuntimeContext) {
  const { channel, state, getGrant } = ctx;
  channel.handle('promptShortcuts', async (args) => {
    if (args.workspaceId !== state.workspace || args.userId !== state.userId)
      throw new Error('workspace_changed');
    const value = await promptShortcuts(
      args as ShortcutRequest,
      args.userId,
      scopedShortcutCloud(ctx, args.workspaceId, args.userId),
      AbortSignal.timeout(120000),
    );
    if (args.action === 'list')
      return { action: 'list', entries: value as PromptShortcutIndexEntry[] };
    if (args.action === 'read')
      return { action: 'read', shortcut: value as PromptShortcut };
    return { action: 'save', entry: value as PromptShortcutIndexEntry };
  });
  channel.handle('remoteSettings', async (args) => {
    if (
      args.workspaceId !== state.workspace ||
      !state.metaReplica ||
      state.unhealthy.size
    )
      throw new Error('metadata_not_ready');
    const scopedGrant = async () => {
      const check = () => {
        if (
          args.workspaceId !== state.workspace ||
          args.userId !== state.userId
        )
          throw new Error('workspace_changed');
      };
      check();
      const value = await getGrant();
      check();
      return value;
    };
    return {
      settings: await remoteSettings(
        args,
        args.userId,
        scopedGrant,
        AbortSignal.timeout(35000),
      ),
    };
  });
  const replicaScope = (args: { workspaceId: string; userId: string }) => {
    const replica = state.metaReplica;
    const check = () => {
      if (
        args.workspaceId !== state.workspace ||
        args.userId !== state.userId ||
        !replica ||
        state.metaReplica !== replica ||
        state.unhealthy.size
      )
        throw new Error('workspace_changed');
    };
    check();
    const scopedGrant = async () => {
      check();
      const value = await getGrant();
      check();
      return value;
    };
    return { flock: replica!.flock, check, scopedGrant };
  };
  const providerScope = (args: { workspaceId: string; userId: string }) => {
    const replica = state.metaReplica;
    const check = () => {
      if (
        !replica ||
        replica.flock !== state.metaReplica?.flock ||
        args.workspaceId !== state.workspace ||
        args.userId !== state.userId ||
        state.unhealthy.has('meta')
      )
        throw new Error('workspace_changed');
    };
    const scopedGrant = async () => {
      check();
      const value = await getGrant();
      check();
      return value;
    };
    check();
    return { check, scopedGrant };
  };
  let providerRpc: ReturnType<typeof createProviderRpc> | undefined;
  let providerRpcScope = '';
  let providerRpcReplica = state.metaReplica?.flock;
  let providerDisposal: Promise<{ unconfirmedFlowIds: string[] }> | undefined;
  ctx.disposeProviderOperations = () => {
    const previous = providerRpc;
    providerRpc = undefined;
    providerRpcScope = '';
    providerRpcReplica = undefined;
    if (!previous)
      return providerDisposal ?? Promise.resolve({ unconfirmedFlowIds: [] });
    const cleanup = previous.dispose().then((result) => {
      for (const flowId of result.unconfirmedFlowIds)
        channel.emit('agentProviderAuthChanged', {
          flowId,
          status: 'error',
          errorCode: 'provider_auth_cancel_unknown',
          methods: [],
          fields: [],
          acceptsAuthorizationCode: false,
          requiresAuthorizationConsent: false,
        });
      return result;
    });
    const pending = cleanup.finally(() => {
      if (providerDisposal === pending) providerDisposal = undefined;
    });
    providerDisposal = pending;
    return pending;
  };
  const providerService = async (args: {
    workspaceId: string;
    userId: string;
  }) => {
    const key = JSON.stringify([args.workspaceId, args.userId]);
    const { check, scopedGrant } = providerScope(args);
    if (
      providerDisposal ||
      providerRpcScope !== key ||
      providerRpcReplica !== state.metaReplica?.flock
    )
      await ctx.disposeProviderOperations!();
    check();
    providerRpcScope = key;
    providerRpcReplica = state.metaReplica?.flock;
    providerRpc ??= createProviderRpc({
      grant: scopedGrant,
      check,
      online: (machineId) =>
        state.presence.state === 'live' &&
        state.presence.onlineMachineIds.includes(machineId),
      progress: (value) => channel.emit('agentProviderAuthChanged', value),
      operationProgress: (value) =>
        channel.emit('agentProviderOperationProgress', value),
    });
    return providerRpc;
  };
  channel.handle('agentProviderAuth', async (args) =>
    (await providerService(args)).auth(args),
  );
  channel.handle('agentProviderOperation', async (args) => {
    const result = await (await providerService(args)).operation(args);
    if (result.success && args.action === 'rate-limits-refresh') {
      const { check, scopedGrant } = providerScope(args);
      const live = state.machineReplicas.get(args.machineId);
      const fresh = await readProvider(
        args,
        scopedGrant,
        AbortSignal.timeout(35000),
        check,
      );
      check();
      if (!live || state.machineReplicas.get(args.machineId) !== live)
        throw new Error('provider_quota_sync_unknown');
      live.importFile(fresh.flock.exportFile());
      state.catalogs.set(
        args.machineId,
        projectRows(live.scan(), args.machineId),
      );
      ctx.publish();
    }
    return result;
  });
  channel.handle('agentProviderDetail', async (args) => {
    const { check, scopedGrant } = providerScope(args);
    return providerDetail(args, scopedGrant, AbortSignal.timeout(35000), check);
  });
  channel.handle('agentProviderProbe', async (args) => {
    const { check, scopedGrant } = providerScope(args);
    if (
      state.presence.state !== 'live' ||
      !state.presence.onlineMachineIds.includes(args.machineId)
    )
      throw new Error('machine_unavailable');
    return probeProvider(
      args,
      scopedGrant,
      AbortSignal.timeout(
        args.readModelOptions ? MODEL_OPTIONS_READ_TIMEOUT_MS + 5000 : 125000,
      ),
      check,
      (progress) =>
        channel.emit('agentProviderRefreshProgress', {
          machineId: args.machineId,
          id: args.id,
          ...progress,
        }),
    );
  });
  channel.handle('agentProviders', async (args) => {
    const { check, scopedGrant } = providerScope(args);
    // A list reads the already-synced workspace replicas; writes open fresh copies.
    const machines = new Map(
      [...state.machineReplicas].filter(([id]) => !state.unhealthy.has(id)),
    );
    return agentProviders(
      args,
      scopedGrant,
      AbortSignal.timeout(125000),
      state.presence,
      check,
      state.metaReplica && !state.unhealthy.has('meta')
        ? { meta: state.metaReplica.flock, machines }
        : undefined,
    );
  });
  channel.handle('agentRoles', async (args) => {
    const { flock, check, scopedGrant } = replicaScope(args);
    return roleSettings(
      args,
      args.userId,
      flock,
      state.machineReplicas,
      scopedGrant,
      AbortSignal.timeout(35000),
      check,
    );
  });
}
