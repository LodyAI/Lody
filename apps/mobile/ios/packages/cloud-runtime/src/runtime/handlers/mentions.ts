import type {
  MentionCatalog,
  MentionCategory,
  MentionSource,
} from '../../models/mentions';
import { workspaceRoleMentions } from '../agent-roles';
import { commandMentions, mentionCatalog, sessionMentions } from '../mentions';
import { listedShortcuts } from '../prompt-shortcuts';
import {
  sameShortcutProject,
  type PromptShortcutScope,
} from '../../protocol/prompt-shortcuts/model.ts';
import type { PromptShortcutIndexEntry } from '../../protocol/prompt-shortcuts/catalog.ts';
import { scopedShortcutCloud, type RuntimeContext } from './context.ts';

type MentionArgs = MentionSource & {
  category: MentionCategory;
  userId: string;
};

/**
 * Web's `resolveShortcutAvailability` scope gate. References inside the body are not
 * gated here: choosing a shortcut reads its body and both composers insert them as chips.
 */
function shortcutInScope(
  entry: PromptShortcutIndexEntry,
  scope: PromptShortcutScope,
) {
  const saved = entry.scope;
  if (
    saved.project &&
    (!scope.project || !sameShortcutProject(saved.project, scope.project))
  )
    return false;
  if (saved.machineId !== undefined && saved.machineId !== scope.machineId)
    return false;
  return (
    saved.providerKey === undefined || saved.providerKey === scope.providerKey
  );
}

export function registerMentions(ctx: RuntimeContext) {
  const { channel, state, getGrant } = ctx;
  const githubPending = new Map<string, Promise<MentionCatalog>>();
  function githubMentions(repoFullName: string): Promise<MentionCatalog> {
    const key = `${state.workspace}:${repoFullName}`;
    const pending = githubPending.get(key);
    if (pending) return pending;
    const workspaceId = state.workspace;
    const request = (async () => {
      try {
        return await channel.request('githubMentions', {
          workspaceId,
          repoFullName,
        });
      } catch {
        throw new Error('github_mentions_unavailable');
      }
    })().finally(() => githubPending.delete(key));
    githubPending.set(key, request);
    return request;
  }
  async function getMentions(args: MentionArgs) {
    const { catalogs, machineReplicas } = state;
    if (
      args.workspaceId !== state.workspace ||
      !state.metaReplica ||
      state.unhealthy.size
    )
      throw new Error('metadata_not_ready');
    if (args.category === 'role') {
      const sourceWorkspace = state.workspace,
        sourceUserId = state.userId;
      if (args.userId !== sourceUserId) throw new Error('workspace_changed');
      const check = () => {
        if (
          state.workspace !== sourceWorkspace ||
          state.userId !== sourceUserId
        )
          throw new Error('workspace_changed');
      };
      const result = await workspaceRoleMentions(
        sourceWorkspace,
        args.userId,
        machineReplicas,
        async () => {
          check();
          const value = await getGrant();
          check();
          return value;
        },
        () => state.presence,
      );
      check();
      return result;
    }
    if (args.category === 'session')
      return sessionMentions(
        catalogs.get('meta')?.sessions ?? [],
        [...catalogs.values()].flatMap((value) => value.projects),
        args.sessionId,
      );
    const session = args.sessionId
      ? catalogs
          .get('meta')
          ?.sessions.find((item) => item.id === args.sessionId)
      : undefined;
    if (args.sessionId && !session) throw new Error('session_unavailable');
    const projectId = session?.projectId ?? args.projectId;
    const project = [...catalogs.values()]
      .flatMap((value) => value.projects)
      .find((item) => item.id === projectId);
    if (args.projectId && !project) throw new Error('project_unavailable');
    const machineId =
      session?.machineId ??
      (projectId?.startsWith('github:')
        ? args.machineId
        : project?.machineId) ??
      args.machineId;
    if (!machineId || !machineReplicas.has(machineId))
      throw new Error('machine_unavailable');
    const prefix = `${machineId}:local:`;
    const localProjectId = projectId?.startsWith(prefix)
      ? projectId.slice(prefix.length)
      : undefined;
    if (
      localProjectId &&
      machineReplicas
        .get(machineId)
        ?.get(['cmd', 'deleteLocalProject', localProjectId]) !== undefined
    )
      throw new Error('project_unavailable');
    if (args.category === 'issue' || args.category === 'pr') {
      if (!projectId?.startsWith('github:'))
        return { items: [], truncated: false, incomplete: false };
      const result = await githubMentions(projectId.slice(7));
      return {
        ...result,
        items: result.items.filter((item) => item.kind === args.category),
      };
    }
    if (args.category === 'cmd') {
      const sourceWorkspace = state.workspace;
      const cliType = args.cliType ?? session?.cliType;
      const agentType = args.agentType ?? session?.agentType;
      // The composer's scope, as web's `shortcutComposerScope`: a shortcut saved for a
      // project, computer or agent lists only where they match (web hides the rest).
      const scope: PromptShortcutScope = { machineId };
      if (localProjectId)
        scope.project = { kind: 'local', id: localProjectId, machineId };
      else if (projectId?.startsWith('github:'))
        scope.project = {
          kind: 'github',
          repository: projectId.slice('github:'.length),
        };
      if (cliType && agentType) scope.providerKey = `${cliType}:${agentType}`;
      const listing = await listedShortcuts(
        sourceWorkspace,
        state.userId,
        scopedShortcutCloud(ctx, sourceWorkspace, state.userId),
      );
      const shortcuts = listing.entries
        .filter((entry) => shortcutInScope(entry, scope))
        .map((entry) => ({
          path: entry.id,
          name: `/shortcut:${entry.slug}`,
          kind: 'cmd' as const,
          subtitle: entry.name,
          insertText: `/shortcut:${entry.slug}`,
        }));
      const currentMeta = state.metaReplica;
      if (
        !currentMeta ||
        state.workspace !== sourceWorkspace ||
        state.unhealthy.size
      )
        throw new Error('metadata_not_ready');
      const commands = () => {
        const metadata = session
          ? (currentMeta.flock.get(['m', `session-${session.id}`]) as
              Record<string, unknown> | undefined)
          : undefined;
        const configId = session
          ? (currentMeta.flock.get([
              'm',
              `session-${session.id}`,
              'agentConfigId',
            ]) ?? metadata?.agentConfigId)
          : args.agentConfigId;
        if (typeof configId !== 'string') return commandMentions([]);
        const capability = machineReplicas
          .get(machineId)
          ?.get(['acpCapability', configId]) as
          Record<string, unknown> | undefined;
        if (
          !capability ||
          capability.cliType !== (args.cliType ?? session?.cliType) ||
          capability.agentType !== (args.agentType ?? session?.agentType)
        )
          return commandMentions([]);
        return commandMentions(capability.availableCommands);
      };
      const result = commands();
      const names = new Set(result.items.map((item) => item.insertText));
      return {
        ...result,
        incomplete: result.incomplete || listing.incomplete,
        items: [
          ...result.items,
          ...shortcuts.filter((item) => !names.has(item.insertText)),
        ],
      };
    }
    return mentionCatalog(
      {
        workspaceId: state.workspace,
        machineId,
        localProjectId,
        repoFullName: projectId?.startsWith('github:')
          ? projectId.slice('github:'.length)
          : undefined,
        sessionId: session?.id,
        getGrant,
        signal: AbortSignal.timeout(35000),
      },
      args.category,
      args.userId,
    );
  }
  channel.handle('mentionCatalog', getMentions);
  return getMentions;
}
