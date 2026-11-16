import { describe, expect, it } from 'vitest';
import { LoroRepo } from 'loro-repo';
import {
  AgentRoleProposalMetaSchema,
  applyAgentRoleProposal,
  getAgentRoleTarget,
  getWorkspaceFlockDocId,
  withAgentRoleTargets,
  writeWorkspaceAgentRoleToFlock,
  type MachineId,
  type MemoryBinding,
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
          validateMemory: async () => {
            throw new Error('Update must not probe memory');
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

  it('binds per-machine memory, records the before state and carries identities to import', async () => {
    const repo = await LoroRepo.create({});
    const sessionId = 'role-proposal-memory' as SessionId;
    const workspaceId = 'workspace' as WorkspaceId;
    const doc = new SessionDocument(repo, sessionId, async () => undefined);
    await doc.initOffline(undefined, { historyBackend: 'loro' });
    const backend = await createSessionBackend(doc, { historyBackend: 'loro' });
    const manager = {
      repo,
      getOrCreateSessionDoc: async () => doc,
    } as unknown as LoroDocumentManager;
    const reviewer = { providerId: 'nowledge-mem', memoryId: 'reviewer' };
    const scout = { providerId: 'nowledge-mem', memoryId: 'scout' };
    const probed: string[] = [];
    try {
      const handle = await repo.openFlockDoc(getWorkspaceFlockDocId(workspaceId));
      const single = applyAgentRoleProposal(
        { command, requesterUserId: 'user', roleId: 'role' },
        [],
        'user',
        0
      );
      const role = withAgentRoleTargets(single, [
        { ...getAgentRoleTarget(single, 'machine' as MachineId)!, runConfig: { memory: reviewer } },
        { machineId: 'build' as MachineId, agentConfigId: single.agentConfigId, runConfig: {} },
      ]);
      writeWorkspaceAgentRoleToFlock(handle.flock, role);
      const propose = (
        requestId: string,
        targets: { machineId: string; memory: MemoryBinding | null }[]
      ) =>
        proposeAgentRole({
          manager,
          workspaceId,
          sessionId,
          userId: 'user',
          localOnly: true,
          command: { action: 'update', requestId, roleId: 'role', patch: { targets } },
          validateTarget: async () => {
            throw new Error('Update must preserve binding');
          },
          validateMemory: async (machineId, memory) => {
            probed.push(`${machineId}/${memory.memoryId}`);
            return memory.memoryId === 'scout'
              ? { machineId, ...memory, name: 'Scout' }
              : undefined;
          },
        });
      await expect(propose('elsewhere', [{ machineId: 'laptop', memory: scout }])).rejects.toThrow(
        'does not run on machine laptop'
      );
      expect(probed).toEqual([]);
      await propose('bind', [
        { machineId: 'build', memory: scout },
        { machineId: 'machine', memory: null },
      ]);
      expect(probed).toEqual(['build/scout']);
      const read = await backend.readTurn('agent-role-proposal-bind');
      if (read.state !== 'ready') throw new Error('missing card');
      const meta = AgentRoleProposalMetaSchema.parse(
        (read.turn.items?.[0] as { meta: unknown }).meta
      );
      expect(meta.before?.targets).toEqual([
        { machineId: 'build' },
        { machineId: 'machine', memory: reviewer },
      ]);
      expect(meta.memoryImports).toEqual([{ machineId: 'build', ...scout, name: 'Scout' }]);
      const saved = applyAgentRoleProposal(meta, [role], 'user', 5);
      expect(getAgentRoleTarget(saved, 'build' as MachineId)?.runConfig).toEqual({ memory: scout });
      expect(getAgentRoleTarget(saved, 'machine' as MachineId)?.runConfig).toEqual({});
      expect(saved.revision).toBe(role.revision + 1);
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
});
