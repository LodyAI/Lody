import type {
  PromptShortcut,
  PromptShortcutIndexEntry,
  ShortcutRequest,
} from '../../models/prompt-shortcuts.ts';
import type { PublishedSharePage } from '../../models/session-sharing.ts';
import { memorySettings } from '../memory-settings';
import { promptShortcuts } from '../prompt-shortcuts';
import { roleSettings } from '../role-settings';
import { remoteSettings } from '../settings';
import { scopedShortcutCloud, type RuntimeContext } from './context.ts';

export function registerSettings(ctx: RuntimeContext) {
  const { channel, state, getGrant } = ctx;
  channel.handle('publishedShares', async (args) => {
    const current = state.workspace,
      user = state.userId;
    const check = () => {
      if (
        current !== state.workspace ||
        args.workspaceId !== state.workspace ||
        user !== state.userId ||
        args.userId !== user
      )
        throw new Error('shares_scope_changed');
    };
    check();
    const result = await ctx.broker(
      'management',
      args.action === 'list' ? { ...args, cursor: args.cursor ?? null } : args,
    );
    check();
    const failure = (result as { error?: unknown } | null)?.error;
    if (typeof failure === 'string')
      return { outcome: 'failed', error: failure };
    return { outcome: 'page', ...(result as PublishedSharePage) };
  });
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
  channel.handle('memorySettings', async (args) => {
    const { flock, check, scopedGrant } = replicaScope(args);
    return memorySettings(
      args,
      args.userId,
      flock,
      state.machineReplicas,
      () => state.presence,
      scopedGrant,
      AbortSignal.timeout(35000),
      check,
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
