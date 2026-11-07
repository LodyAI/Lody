import { referenceSpans } from '../../protocol/message-references.ts';
import type { MentionItem } from '../../models/mentions.ts';
import { forkableTurn, forkOnce, sessionActionMeta } from '../fork-session';
import { machineRpc } from '../machine-rpc';
import type { Value } from '@loro-dev/flock-wasm/base64';
import { tabOwner } from '../directory-tab';
import { projectRows } from '../../protocol/catalog.ts';
import {
  archiveSession,
  setTabClosed,
  deleteSession,
  markSessionRead,
  pinSession,
  renameSession,
} from '../archive-session';
import { creationOptions, createSession } from '../create-session';
import { readWorkspaceProjects } from '../project-groups';
import { sessionMcpSelection } from '../mcp';
import { expandMentions } from '../mention-expansion';
import { expandShortcuts, shortcutAccess } from '../prompt-shortcuts';
import {
  checkTurnQuota,
  controlTurn,
  editSession,
  sessionDoc,
  releaseDeletedSessions,
  respondPermission,
  sendTurn,
} from '../session';
import {
  scopedShortcutCloud,
  type MetaReplica,
  type RuntimeContext,
} from './context.ts';
import type { registerMentions } from './mentions.ts';

const cleared = (value?: { value: string | null }) =>
  value === undefined ? undefined : value.value;

export function registerSessions(
  ctx: RuntimeContext,
  getMentions: ReturnType<typeof registerMentions>,
) {
  const { channel, state, getGrant } = ctx;
  let creating = false;
  function metaWrite(args: { workspaceId: string }, healthy = false) {
    if (
      args.workspaceId !== state.workspace ||
      !state.metaReplica ||
      (healthy && state.unhealthy.size)
    )
      throw new Error('metadata_not_ready');
    return state.metaReplica;
  }
  function republish(replica: MetaReplica) {
    if (state.metaReplica !== replica) return;
    state.catalogs.set('meta', projectRows(replica.flock.scan(), 'meta'));
    ctx.publish();
  }
  const forkAttempts = new Map<string, 'created' | 'rejected' | 'unknown'>();
  channel.handle('forkSession', async (args) => {
    const replica = metaWrite(args, true);
    if (!state.userId) return { state: 'rejected' };
    const room = `session-${args.sourceSessionId}`;
    const meta = sessionActionMeta(
      replica.flock.get(['m', room]),
      replica.flock.scan({ prefix: ['m', room] }),
      replica.flock.get(['e', room]),
    );
    const capability =
      meta &&
      (state.machineReplicas
        .get(meta.machineId)
        ?.get(['acpCapability', meta.agentConfigId]) as
        Record<string, any> | undefined);
    const history = sessionDoc(args.sourceSessionId)
      ?.getList('history')
      .toJSON() as Record<string, any>[] | undefined;
    if (
      !meta ||
      !history ||
      !forkableTurn(history, meta, capability, args.sourceTurnId)
    )
      return { state: 'rejected' };
    if (args.action === 'read') return { state: 'ready' };
    const target = args.targetSessionId;
    if (!target || target === args.sourceSessionId)
      return { state: 'rejected' };
    const key = `${state.workspace}:${target}`;
    const request = {
      sourceSessionId: args.sourceSessionId,
      sourceTurnId: args.sourceTurnId,
      targetSessionId: target,
      requestedByUserId: state.userId,
    };
    return forkOnce(forkAttempts, key, request, () =>
      machineRpc(
        state.workspace,
        meta.machineId,
        'session/fork',
        request,
        getGrant,
        AbortSignal.timeout(120_000),
      ),
    );
  });
  channel.handle('createTab', async (args) => {
    const replica = metaWrite(args, true);
    if (creating || !state.userId) return { state: 'rejected' };
    creating = true;
    try {
      const owner = tabOwner(args.parentSessionId, (id) => {
        const room = `session-${id}`;
        if (replica.flock.get(['e', room]) === false) return undefined;
        const base = replica.flock.get(['m', room]);
        const rows = replica.flock.scan({ prefix: ['m', room] });
        if (!base && !rows.length) return undefined;
        const value = {
          ...(base && typeof base === 'object' && !Array.isArray(base)
            ? base
            : {}),
        } as Record<string, Value | undefined>;
        for (const row of rows)
          if (row.key.length === 3 && typeof row.key[2] === 'string')
            value[row.key[2]] = row.value;
        return value;
      });
      const session = projectRows(replica.flock.scan(), 'meta').sessions.find(
        (s) => s.id === owner.id,
      );
      if (!session) return { state: 'rejected' };
      const options = creationOptions(
        undefined,
        replica.flock,
        state.machineReplicas,
      );
      const agent = options.agents.find(
        (a) =>
          a.machineId === session.machineId &&
          (owner.value.agentConfigId
            ? a.id === owner.value.agentConfigId
            : a.cliType === session.cliType &&
              a.agentType === session.agentType),
      );
      if (!agent) return { state: 'rejected' };
      const result = await createSession(
        {
          workspaceId: args.workspaceId,
          sessionId: args.sessionId,
          machineId: agent.machineId,
          agentConfigId: agent.id,
          userId: state.userId,
          title: args.title,
          tabContext: {
            parentSessionId: owner.id,
            projectId: session.projectId,
            project: owner.value.project as Value | undefined,
            repoFullName: owner.value.repoFullName as Value | undefined,
            baseBranch: owner.value.baseBranch as Value | undefined,
          },
        },
        options,
        replica,
        getGrant,
      );
      if (result.state === 'created') republish(replica);
      return result;
    } catch (error) {
      return {
        state:
          error instanceof Error && error.message === 'session_already_exists'
            ? 'unknown'
            : 'rejected',
      };
    } finally {
      creating = false;
    }
  });
  channel.handle('createSession', async (args) => {
    if (
      creating ||
      args.workspaceId !== state.workspace ||
      !state.metaReplica ||
      state.unhealthy.has('meta') ||
      state.unhealthy.has(args.machineId)
    )
      return { state: 'rejected' };
    const replica = state.metaReplica;
    creating = true;
    try {
      // A multi-repository project: read the group fresh; its run picks the machine's agents.
      const workspace = state.workspace;
      const group = args.projectGroupId
        ? (
            await readWorkspaceProjects(
              workspace,
              getGrant,
              AbortSignal.timeout(30000),
            )
          ).find((project) => project.id === args.projectGroupId)
        : undefined;
      if (args.projectGroupId && (!group || state.workspace !== workspace))
        return { state: 'rejected' };
      const options = creationOptions(
        group ? undefined : args.projectId,
        replica.flock,
        state.machineReplicas,
      );
      const result = await createSession(
        group ? { ...args, projectId: undefined } : args,
        options,
        replica,
        getGrant,
        group,
      );
      if (result.state === 'created') republish(replica);
      return result;
    } catch (error) {
      if (error instanceof Error && error.message === 'session_already_exists')
        return { state: 'unknown' };
      return { state: 'rejected' };
    } finally {
      creating = false;
    }
  });
  channel.handle('deleteSession', async (args) => {
    const replica = metaWrite(args, true);
    const sessionIds = await deleteSession(args, replica);
    if (state.metaReplica === replica) releaseDeletedSessions(sessionIds);
    republish(replica);
    return { sessionIds };
  });
  channel.handle('archiveSession', async (args) => {
    const replica = metaWrite(args);
    await archiveSession(args, replica, state.machineReplicas, getGrant);
    republish(replica);
    return {};
  });
  channel.handle('setTabClosed', async (args) => {
    const replica = metaWrite(args);
    await setTabClosed(args, replica);
    republish(replica);
    return {};
  });
  channel.handle('pinSession', async (args) => {
    const replica = metaWrite(args);
    await pinSession(args, replica);
    republish(replica);
    return {};
  });
  channel.handle('markSessionRead', async (args) => {
    const replica = metaWrite(args);
    await markSessionRead(args, replica);
    republish(replica);
    return {};
  });
  channel.handle('renameSession', async (args) => {
    const replica = metaWrite(args);
    await renameSession(args, replica);
    republish(replica);
    return {};
  });
  channel.handle('respondPermission', respondPermission);
  channel.handle('controlTurn', controlTurn);
  channel.handle('checkTurnQuota', checkTurnQuota);
  channel.handle('editSession', (args) => {
    if (!state.metaReplica || state.unhealthy.size)
      return { state: 'not_sent', reason: 'metadata_not_ready' };
    const room = `session-${args.sessionId}`;
    const flock = state.metaReplica.flock;
    const meta = sessionActionMeta(
      flock.get(['m', room]),
      flock.scan({ prefix: ['m', room] }),
      flock.get(['e', room]),
    );
    if (!meta) return { state: 'not_sent', reason: 'session_not_ready' };
    const capability = state.machineReplicas
      .get(meta.machineId)
      ?.get(['acpCapability', meta.agentConfigId]) as
      Record<string, any> | undefined;
    return editSession(args, meta, capability);
  });
  channel.handle('sendTurn', (wire) => {
    if (!state.metaReplica)
      return { state: 'not_sent', reason: 'metadata_not_ready' };
    // A Role binds the session's own Agent Config, read from metadata, never the wire.
    const room = `session-${wire.sessionId}`;
    const flock = state.metaReplica.flock;
    const meta = sessionActionMeta(
      flock.get(['m', room]),
      flock.scan({ prefix: ['m', room] }),
      flock.get(['e', room]),
    );
    if (!meta) return { state: 'not_sent', reason: 'session_not_ready' };
    const args = {
      ...wire,
      modelId: cleared(wire.modelId),
      reasoningEffort: cleared(wire.reasoningEffort),
      agentRoleId: cleared(wire.agentRoleId),
      agentConfigId:
        typeof meta?.agentConfigId === 'string'
          ? meta.agentConfigId
          : undefined,
    };
    const sourceWorkspace = state.workspace;
    const source = {
      workspaceId: sourceWorkspace,
      sessionId: args.sessionId,
      userId: args.userId ?? '',
      cliType: args.cliType,
      agentType: args.agentType,
    };
    const access = shortcutAccess(
      sourceWorkspace,
      state.userId,
      scopedShortcutCloud(ctx, sourceWorkspace, state.userId),
      AbortSignal.timeout(30000),
    );
    const scoped = () => {
      if (state.workspace !== sourceWorkspace || state.userId !== args.userId)
        throw new Error('workspace_changed');
    };
    return sendTurn(
      args,
      async (text) => {
        const items: MentionItem[] = [];
        const expanded = await expandShortcuts(
          text,
          access.list,
          access.read,
          (part) =>
            expandMentions(part, async (category) => {
              const catalog = await getMentions({ ...source, category });
              items.push(...catalog.items);
              return catalog;
            }),
        );
        return { text: expanded, spans: referenceSpans(expanded, items) };
      },
      async (persisted) => {
        scoped();
        const ids = await sessionMcpSelection(
          sourceWorkspace,
          getGrant,
          persisted,
          AbortSignal.timeout(30000),
        );
        scoped();
        return ids;
      },
    );
  });
}
