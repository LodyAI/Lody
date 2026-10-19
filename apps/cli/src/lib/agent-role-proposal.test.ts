import { describe, expect, it } from 'vitest';
import { LoroRepo } from 'loro-repo';
import {
  AgentRoleProposalMetaSchema,
  applyAgentRoleProposal,
  getWorkspaceFlockDocId,
  writeWorkspaceAgentRoleToFlock,
  type WorkspaceId,
  type AgentRoleProposalCommand,
  type SessionId,
} from '@lody/shared';
import { SessionDocument, type LoroDocumentManager } from './loro/doc';
import { createSessionBackend } from '@/session/session-backend';
import { proposeAgentRole, publishAgentRoleProposal } from './agent-role-proposal';

const command: AgentRoleProposalCommand = {
  action: 'create',
  requestId: 'request',
  name: 'Reviewer',
  machineId: 'machine',
  agentConfigId: 'agent',
  promptPrefix: 'Review the patch',
};

describe('Role proposal history', () => {
  it('persists a pending card, rejects different retries and returns the saved outcome', async () => {
    const repo = await LoroRepo.create({});
    const doc = new SessionDocument(repo, 'role-proposal-test' as SessionId, async () => undefined);
    await doc.initOffline(undefined, { historyBackend: 'loro' });
    const backend = await createSessionBackend(doc, { historyBackend: 'loro' });
    const prepare = async () => ({ command, requesterUserId: 'user', roleId: 'role' });
    try {
      expect(await publishAgentRoleProposal(backend, command, 'user', prepare, () => 0)).toEqual({
        pending: true,
        roleId: 'role',
      });
      expect(
        await publishAgentRoleProposal(backend, command, 'user', async () => {
          throw new Error('must reuse stored proposal');
        })
      ).toMatchObject({ pending: true, roleId: 'role' });
      expect(await backend.history.count()).toBe(1);
      await expect(
        publishAgentRoleProposal(backend, { ...command, name: 'Different' }, 'user', prepare)
      ).rejects.toThrow('Idempotency');
      await expect(publishAgentRoleProposal(backend, command, 'other', prepare)).rejects.toThrow(
        'Idempotency'
      );
      const read = await backend.readTurn('agent-role-proposal-request');
      if (read.state !== 'ready') throw new Error('missing card');
      const item = read.turn.items?.[0] as { meta: unknown };
      const meta = AgentRoleProposalMetaSchema.parse(item.meta);
      expect(meta.command).toEqual(command);
      await doc.sessionData.commands.replaceTurn(read.turn.id, {
        ...read.turn,
        items: [
          {
            type: 'system_notice',
            name: 'agent_role_proposal',
            meta: { ...meta, outcome: 'saved' },
          },
        ],
      });
      expect(await publishAgentRoleProposal(backend, command, 'user', prepare)).toEqual({
        pending: false,
        outcome: 'saved',
        roleId: 'role',
      });
      expect(await backend.history.count()).toBe(1);
    } finally {
      await doc.destroy();
      await repo.destroy();
    }
  });

  it('publishes owned updates and rejects missing or unowned Roles without adding history', async () => {
    const repo = await LoroRepo.create({});
    const sessionId = 'role-proposal-ownership' as SessionId;
    const workspaceId = 'workspace' as WorkspaceId;
    const doc = new SessionDocument(repo, sessionId, async () => undefined);
    await doc.initOffline(undefined, { historyBackend: 'loro' });
    const backend = await createSessionBackend(doc, { historyBackend: 'loro' });
    const manager = {
      repo,
      getOrCreateSessionDoc: async () => doc,
    } as unknown as LoroDocumentManager;
    try {
      const handle = await repo.openFlockDoc(getWorkspaceFlockDocId(workspaceId));
      const role = applyAgentRoleProposal(
        { command, requesterUserId: 'user', roleId: 'role' },
        [],
        'user',
        0
      );
      writeWorkspaceAgentRoleToFlock(handle.flock, role);
      const propose = (roleId: string, userId: string, requestId: string) =>
        proposeAgentRole({
          manager,
          workspaceId,
          sessionId,
          userId,
          localOnly: true,
          command: {
            action: 'update',
            requestId,
            roleId,
            patch: { description: 'New description' },
          },
          validateTarget: async () => {
            throw new Error('Update must preserve binding');
          },
        });
      await expect(propose('missing', 'user', 'missing')).rejects.toThrow();
      await expect(propose('role', 'other', 'unauthorized')).rejects.toThrow();
      expect(await backend.history.count()).toBe(0);
      expect(await propose('role', 'user', 'owned')).toEqual({ pending: true, roleId: 'role' });
      const read = await backend.readTurn('agent-role-proposal-owned');
      if (read.state !== 'ready') throw new Error('missing card');
      expect(read.turn.items?.[0]).toMatchObject({
        meta: {
          roleId: 'role',
          requesterUserId: 'user',
          before: { name: 'Reviewer' },
          command: { patch: { description: 'New description' } },
        },
      });
      expect(await backend.history.count()).toBe(1);
    } finally {
      await doc.destroy();
      await repo.destroy();
    }
  });

  it('does not replace a proposal when history is temporarily unavailable', async () => {
    await expect(
      publishAgentRoleProposal(
        {
          readTurn: async () => ({ state: 'unavailable', reason: 'incomplete' }),
          appendHistoryTurn: async () => {
            throw new Error('Unexpected write');
          },
        },
        command,
        'user',
        async () => {
          throw new Error('Unexpected preparation');
        }
      )
    ).rejects.toThrow('Proposal history is unavailable');
  });

  it('does not publish a card when validation fails', async () => {
    const repo = await LoroRepo.create({});
    const doc = new SessionDocument(
      repo,
      'role-proposal-failure' as SessionId,
      async () => undefined
    );
    await doc.initOffline(undefined, { historyBackend: 'loro' });
    const backend = await createSessionBackend(doc, { historyBackend: 'loro' });
    try {
      await expect(
        publishAgentRoleProposal(backend, command, 'user', async () => {
          throw new Error('not editable');
        })
      ).rejects.toThrow('not editable');
      expect(await backend.history.count()).toBe(0);
    } finally {
      await doc.destroy();
      await repo.destroy();
    }
  });
});
