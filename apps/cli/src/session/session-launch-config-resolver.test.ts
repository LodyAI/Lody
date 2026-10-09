import { describe, expect, it, vi } from 'vitest';
import {
  getMachineFlockDocId,
  machineFlockKeys,
  type AgentConfigId,
  type MachineFlockKey,
  type MachineFlockReadableFlock,
  type MachineId,
  type SessionId,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';
import {
  readMachineSessionLaunchSnapshotFromFlock,
  resolveSessionLaunchConfig,
} from './session-launch-config-resolver';

class FakeMachineFlock implements MachineFlockReadableFlock {
  readonly rows: Array<{ key: MachineFlockKey; value: unknown }> = [];

  scan(options?: { prefix?: readonly unknown[] }) {
    const prefix = options?.prefix;
    return prefix
      ? this.rows.filter((row) => prefix.every((part, index) => row.key[index] === part))
      : this.rows;
  }
}

const workspaceId = 'workspace-1' as WorkspaceId;
const machineId = 'machine-1' as MachineId;
const sessionId = 'session-1' as SessionId;
const agentConfigId = 'agent-config-1' as AgentConfigId;
const logger = { debug: vi.fn() };

const sessionMeta = (): SessionMeta =>
  ({
    id: sessionId,
    machineId,
    agentConfigId,
  }) as SessionMeta;

describe('resolveSessionLaunchConfig', () => {
  it('reads the current launch config synchronously from an existing Flock handle', () => {
    const flock = new FakeMachineFlock();
    flock.rows.push({
      key: machineFlockKeys.agentConfig(agentConfigId),
      value: {
        id: agentConfigId,
        machineId,
        name: 'Codex',
        cliType: 'builtin',
        agentType: 'codex',
        env: { AGENT_ENV: '1' },
        magpieGatewayUrl: 'http://127.0.0.1:3425',
        prompt: '',
      },
    });

    expect(
      readMachineSessionLaunchSnapshotFromFlock({ flock, sessionId, sessionMeta: sessionMeta() })
        .resolution
    ).toEqual({
      source: 'agent-config',
      config: { env: { AGENT_ENV: '1' }, magpieGatewayUrl: 'http://127.0.0.1:3425' },
    });

    flock.rows[0]!.value = {
      ...(flock.rows[0]!.value as object),
      env: { AGENT_ENV: '2' },
    };
    expect(
      readMachineSessionLaunchSnapshotFromFlock({ flock, sessionId, sessionMeta: sessionMeta() })
        .resolution
    ).toEqual({
      source: 'agent-config',
      config: { env: { AGENT_ENV: '2' }, magpieGatewayUrl: 'http://127.0.0.1:3425' },
    });
  });

  it('reads session and agent launch fields from one targeted machine Flock open', async () => {
    const flock = new FakeMachineFlock();
    flock.rows.push(
      {
        key: machineFlockKeys.sessionLaunchConfig(sessionId),
        value: { worktreeSetup: { scripts: { bash: 'pnpm install' } } },
      },
      {
        key: machineFlockKeys.agentConfig(agentConfigId),
        value: {
          id: agentConfigId,
          machineId,
          name: 'Codex',
          cliType: 'builtin',
          agentType: 'codex',
          env: { AGENT_ENV: '1' },
          prompt: '',
        },
      }
    );
    const openFlockDoc = vi.fn(async () => ({ flock }));
    const getAgentConfigById = vi.fn();

    const result = await resolveSessionLaunchConfig({
      workspaceDocument: {
        repo: { openFlockDoc },
        getAgentConfigById,
      },
      workspaceId,
      machineId,
      sessionId,
      sessionMeta: sessionMeta(),
      logger,
    });

    expect(openFlockDoc).toHaveBeenCalledOnce();
    expect(openFlockDoc).toHaveBeenCalledWith(getMachineFlockDocId(workspaceId, machineId));
    expect(getAgentConfigById).not.toHaveBeenCalled();
    expect(result).toEqual({
      source: 'agent-config',
      config: {
        env: { AGENT_ENV: '1' },
        worktreeSetup: { scripts: { bash: 'pnpm install' } },
      },
    });
  });

  it('limits the compatibility fallback lookup to the target machine', async () => {
    const flock = new FakeMachineFlock();
    const getAgentConfigById = vi.fn(async () => ({
      customAcp: { command: 'custom-agent' },
      runtimeOverrides: undefined,
      env: {},
    }));

    const result = await resolveSessionLaunchConfig({
      workspaceDocument: {
        repo: { openFlockDoc: vi.fn(async () => ({ flock })) },
        getAgentConfigById,
      },
      workspaceId,
      machineId,
      sessionId,
      sessionMeta: sessionMeta(),
      logger,
    });

    expect(getAgentConfigById).toHaveBeenCalledWith(agentConfigId, machineId);
    expect(result).toMatchObject({
      source: 'agent-config',
      config: { customAcp: { command: 'custom-agent' } },
    });
  });
});
