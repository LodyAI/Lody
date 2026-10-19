import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  AgentRoleProposalMetaSchema,
  applyAgentRoleProposal,
  getServerNow,
  getWorkspaceFlockDocId,
  listWorkspaceAgentRoles,
  readWorkspaceFlockRowsFromFlock,
  type AgentRoleProposalCommand,
  type AgentRoleProposalMeta,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';
import type { SessionBackend } from '@/session/session-backend';
import { createSessionBackend } from '@/session/session-backend';
import type { LoroDocumentManager } from './loro/doc';
import { WorkspaceSyncUnavailableError } from './command-runtime';

/** The durable notice is the retry receipt. Publishing never changes the Role catalog. */
export async function publishAgentRoleProposal(
  backend: Pick<SessionBackend, 'readTurn' | 'appendHistoryTurn'>,
  command: AgentRoleProposalCommand,
  userId: string,
  prepare: () => Promise<AgentRoleProposalMeta>,
  now: () => number = getServerNow
) {
  const entryId = `agent-role-proposal-${command.requestId}`;
  const read = await backend.readTurn(entryId);
  if (read.state === 'ready') {
    const notice = z.object({
      type: z.literal('system_notice'),
      name: z.literal('agent_role_proposal'),
      meta: AgentRoleProposalMetaSchema,
    });
    const prior = read.turn.items?.flatMap((item) => {
      const parsed = notice.safeParse(item);
      return parsed.success ? [parsed.data.meta] : [];
    })[0];
    if (!prior) throw new Error('Idempotency key conflict');
    if (prior.requesterUserId !== userId || !isDeepStrictEqual(prior.command, command))
      throw new Error('Idempotency key conflict');
    return { pending: !prior.outcome, outcome: prior.outcome, roleId: prior.roleId };
  }
  if (read.state !== 'missing')
    throw new Error('Proposal history is unavailable; retry with the same requestId');
  const meta = await prepare();
  await backend.appendHistoryTurn({
    id: entryId,
    role: 'system',
    timestamp: new Date(now()).toISOString(),
    items: [{ type: 'system_notice', name: 'agent_role_proposal', meta }],
    fileDiff: [],
    finished: true,
  });
  return { pending: true, roleId: meta.roleId };
}

export async function proposeAgentRole(args: {
  manager: LoroDocumentManager;
  workspaceId: WorkspaceId;
  sessionId: SessionId;
  userId: string;
  command: AgentRoleProposalCommand;
  localOnly: boolean;
  validateTarget: (machineId: string, agentConfigId: string) => Promise<void>;
}) {
  const { manager, workspaceId, sessionId, userId, command } = args;
  const session = await manager.getOrCreateSessionDoc(sessionId);
  if (!args.localOnly)
    await manager.syncDocOrThrow(session.roomId, { reason: 'agent-role:proposal' });
  const backend = await createSessionBackend(session);
  const result = await publishAgentRoleProposal(backend, command, userId, async () => {
    const docId = getWorkspaceFlockDocId(workspaceId);
    if (!args.localOnly) {
      try {
        await manager.syncMetaOrThrow({
          reason: 'agent-role:proposal',
          requireRemoteConfirmation: true,
        });
        await manager.syncFlockDocOrThrow(docId, {
          reason: 'agent-role:proposal',
          requireRemoteConfirmation: true,
        });
      } catch (cause) {
        throw new WorkspaceSyncUnavailableError({
          message: 'Role catalog synchronization is unavailable; retry the request.',
          cause,
        });
      }
    }
    const handle = await manager.repo.openFlockDoc(docId);
    const roles = listWorkspaceAgentRoles(readWorkspaceFlockRowsFromFlock(handle.flock));
    const existing =
      command.action === 'update' ? roles.find((role) => role.id === command.roleId) : undefined;
    if (command.action === 'create')
      await args.validateTarget(command.machineId, command.agentConfigId);
    const meta: AgentRoleProposalMeta = {
      command,
      requesterUserId: userId,
      roleId: command.action === 'update' ? command.roleId : randomUUID(),
      ...(existing && command.action === 'update'
        ? {
            before: {
              name: existing.name,
              ...(command.patch.description !== undefined
                ? { description: existing.description }
                : {}),
              ...(command.patch.promptPrefix !== undefined
                ? { promptPrefix: existing.promptPrefix }
                : {}),
            },
          }
        : {}),
    };
    applyAgentRoleProposal(meta, roles, userId, getServerNow());
    return meta;
  });
  await manager.repo.flush();
  if (!args.localOnly && (!(await backend.waitUntilSynced()) || !(await session.waitUntilSynced())))
    throw new Error(
      `Proposal saved locally; sync pending. Retry with requestId ${command.requestId}.`
    );
  return result;
}
