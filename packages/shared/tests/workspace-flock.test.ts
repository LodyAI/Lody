import { describe, expect, it } from 'vitest';

import { AGENT_ROLE_VERSION, type AgentRole } from '../src/agent-role';
import type { AgentConfigId, AgentRoleId, MachineId, McpServerId } from '../src/ids';
import { applyWorkspaceFlockRowEvents, getProjectMcpDefaults, listWorkspaceAgentRoles, writeWorkspaceAgentRoleToFlock, listWorkspaceMcpServers, readWorkspaceFlockRowsFromFlock, workspaceFlockKeys, writeWorkspaceMcpServerToFlock, type WorkspaceFlockKey, type WorkspaceFlockWritableFlock } from '../src/workspace-flock';
import { getProjectMcpKey, type WorkspaceMcpServerMeta } from '../src/workspace-mcp';
import { splitMcpAuthentication, assertPublicMcpServer } from '../src/mcp-authentication';

const id = (value: string): McpServerId => value as McpServerId;
const agentRole = (roleId: string, overrides: Partial<AgentRole> = {}): AgentRole => ({
  v: AGENT_ROLE_VERSION,
  id: roleId as AgentRoleId,
  ownerUserId: 'user-1',
  visibility: 'private',
  name: roleId,
  machineId: 'machine-1' as MachineId,
  agentConfigId: 'config-1' as AgentConfigId,
  runConfig: {},
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const entry = (serverId: string, name = serverId): WorkspaceMcpServerMeta => ({
  id: id(serverId),
  name,
  transport: 'stdio',
  connection: { transport: 'stdio', command: 'node' },
  createdAt: 1,
  updatedAt: 1,
});

it('keeps manual secrets outside shared writes and strips old credentials on read without mutating the document', () => {
  const flock = new FakeWorkspaceFlock();
  const privateEntry: WorkspaceMcpServerMeta = {
    ...entry('private'),
    transport: 'http',
    connection: {
      transport: 'http',
      url: 'https://example.test/mcp',
      bearerToken: 'private-token',
      headers: { 'X-Key': 'private-key', 'X-Env': '${LOCAL_KEY}' },
    },
  };
  expect(() => writeWorkspaceMcpServerToFlock(flock, privateEntry)).toThrow('local machine');
  expect(flock.rows.size).toBe(0);
  expect(() =>
    writeWorkspaceMcpServerToFlock(flock, {
      ...privateEntry,
      connection: {
        transport: 'http',
        url: 'https://example.test/mcp',
        headers: Object.fromEntries([['__proto__', 'private-prototype-token']]),
      },
    })
  ).toThrow('local machine');
  const split = splitMcpAuthentication(
    privateEntry.connection ?? { transport: 'stdio', command: 'node' }
  );
  expect(split.authentication).toEqual({
    bearerToken: 'private-token',
    headers: { 'X-Key': 'private-key' },
  });
  writeWorkspaceMcpServerToFlock(flock, { ...privateEntry, connection: split.connection });
  expect(JSON.stringify([...flock.rows.values()])).not.toContain('private-token');
  expect(JSON.stringify([...flock.rows.values()])).not.toContain('private-key');
  expect(listWorkspaceMcpServers(readWorkspaceFlockRowsFromFlock(flock))[0]?.connection).toEqual({
    transport: 'http',
    url: 'https://example.test/mcp',
    authentication: 'local',
    headers: { 'X-Env': '${LOCAL_KEY}' },
  });
  flock.set(workspaceFlockKeys.mcpServer(privateEntry.id), privateEntry);
  const normalized = listWorkspaceMcpServers(readWorkspaceFlockRowsFromFlock(flock));
  expect(JSON.stringify(normalized)).not.toContain('private-token');
  expect(JSON.stringify([...flock.rows.values()])).toContain('private-token');
  expect(() =>
    assertPublicMcpServer({
      ...privateEntry,
      connection: {
        transport: 'http',
        url: 'https://user:private-password@example.test/mcp?token=private-token',
      },
    })
  ).toThrow('URLs must not contain credentials');
});

class FakeWorkspaceFlock implements WorkspaceFlockWritableFlock {
  readonly rows = new Map<string, { key: WorkspaceFlockKey; value: unknown }>();
  readonly scanOptions: Array<{ prefix?: readonly unknown[] } | undefined> = [];
  commits = 0;

  scan(options?: { prefix?: readonly unknown[] }) {
    this.scanOptions.push(options);
    return [...this.rows.values()].filter(
      ({ key }) => options?.prefix?.every((part, index) => key[index] === part) ?? true
    );
  }

  set(key: WorkspaceFlockKey, value: unknown): void {
    this.rows.set(JSON.stringify(key), { key: [...key] as WorkspaceFlockKey, value });
  }

  delete(key: WorkspaceFlockKey): void {
    this.rows.delete(JSON.stringify(key));
  }

  commit(): void {
    this.commits += 1;
  }
}

describe('workspace Flock helpers', () => {

  it('normalizes a secret-shaped option out of a stored role row', () => {
    const flock = new FakeWorkspaceFlock();
    const role = agentRole('role-1');
    flock.set(workspaceFlockKeys.agentRole(role.id), {
      ...role,
      runConfig: { modelId: 'gpt-5.6', configOptionValues: { api_key: 'sk-live', fast: true } },
    });
    expect(listWorkspaceAgentRoles(readWorkspaceFlockRowsFromFlock(flock))[0]?.runConfig).toEqual({
      modelId: 'gpt-5.6',
      configOptionValues: { fast: true },
    });
  });

  it('stores a multi-machine role as v2 and a single-machine role as the unchanged v1 row', () => {
    const flock = new FakeWorkspaceFlock();
    const key = workspaceFlockKeys.agentRole('role-1' as AgentRoleId);
    const single = agentRole('role-1', { runConfig: { modelId: 'gpt-5.6' } });
    writeWorkspaceAgentRoleToFlock(flock, single);
    const storedSingle = flock.rows.get(JSON.stringify(key))?.value as Record<string, unknown>;
    // Exactly what an older client wrote and still reads.
    expect(storedSingle).toMatchObject({ v: 1, machineId: 'machine-1', agentConfigId: 'config-1' });
    expect(storedSingle).not.toHaveProperty('additionalTargets');
    expect(storedSingle).not.toHaveProperty('targets');

    const multi: AgentRole = {
      ...single,
      alias: 'Reviewer-Mac',
      additionalTargets: [
        {
          machineId: 'machine-2' as MachineId,
          agentConfigId: 'config-2' as AgentConfigId,
          runConfig: { modelId: 'gpt-5.6-luna' },
        },
      ],
    };
    expect(writeWorkspaceAgentRoleToFlock(flock, multi)).toBe(true);
    const storedMulti = flock.rows.get(JSON.stringify(key))?.value as Record<string, unknown>;
    // Older clients accept only v1, so they skip this row instead of rewriting
    // it without the second machine.
    expect(storedMulti.v).toBe(2);
    expect(storedMulti).not.toHaveProperty('machineId');
    expect(storedMulti.targets).toEqual([
      {
        machineId: 'machine-1',
        agentConfigId: 'config-1',
        runConfig: { modelId: 'gpt-5.6' },
        alias: 'Reviewer-Mac',
      },
      { machineId: 'machine-2', agentConfigId: 'config-2', runConfig: { modelId: 'gpt-5.6-luna' } },
    ]);
    expect(listWorkspaceAgentRoles(readWorkspaceFlockRowsFromFlock(flock))).toEqual([multi]);
    expect(writeWorkspaceAgentRoleToFlock(flock, multi)).toBe(false);

    // Back to one machine: the row returns to the v1 shape and the alias goes.
    writeWorkspaceAgentRoleToFlock(flock, single);
    expect(flock.rows.get(JSON.stringify(key))?.value).toMatchObject({ v: 1 });
  });
});

describe('project MCP preferences', () => {
  it('reads replacement selections and explicit empty rows without changing catalog entries', () => {
    const flock = new FakeWorkspaceFlock();
    const key = getProjectMcpKey({ kind: 'github', repoFullName: 'Example/Repo', branch: 'main' })!;
    writeWorkspaceMcpServerToFlock(flock, entry('a'));
    flock.set(workspaceFlockKeys.projectMcpDefault(key), { ids: [id('a'), id('a')] });
    expect(getProjectMcpDefaults(readWorkspaceFlockRowsFromFlock(flock))[key]).toEqual({
      ids: ['a'],
    });
    flock.set(workspaceFlockKeys.projectMcpDefault(key), { ids: [] });
    const rows = readWorkspaceFlockRowsFromFlock(flock);
    expect(getProjectMcpDefaults(rows)[key]).toEqual({ ids: [] });
    expect(listWorkspaceMcpServers(rows)).toEqual([entry('a')]);
    const deleted = applyWorkspaceFlockRowEvents(rows, [
      { key: workspaceFlockKeys.projectMcpDefault(key) },
    ]);
    expect(getProjectMcpDefaults(deleted)[key]).toBeUndefined();
  });
});
