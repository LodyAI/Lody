import { describe, expect, it } from 'vitest';

import type { McpServerId } from '../src/ids';
import {
  getEffectiveDefaultMcpIds,
  getProjectMcpKey,
  normalizeMcpServerIdSelection,
  resolveSessionMcpServers,
  type WorkspaceMcpServerMeta,
} from '../src/workspace-mcp';

const serverId = (value: string): McpServerId => value as McpServerId;

const stdioServer = (
  id: string,
  overrides: Partial<WorkspaceMcpServerMeta> = {}
): WorkspaceMcpServerMeta => ({
  id: serverId(id),
  name: id,
  transport: 'stdio',
  connection: { transport: 'stdio', command: 'node' },
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

describe('workspace MCP resolution', () => {
  it('resolves stdio values and daemon environment passthrough', () => {
    const entry = stdioServer('stdio', {
      name: 'filesystem',
      connection: {
        transport: 'stdio',
        command: '${BIN}',
        args: ['--root', '${ROOT}'],
        env: { TOKEN: '${TOKEN}' },
        envPassthrough: ['HOME'],
      },
    });

    expect(
      resolveSessionMcpServers({
        catalog: { [entry.id]: entry },
        selectedIds: [entry.id],
        agentCapabilities: undefined,
        env: { BIN: 'node', ROOT: '/repo', TOKEN: 'secret', HOME: '/home/dev' },
      })
    ).toEqual({
      servers: [
        {
          name: 'filesystem',
          command: 'node',
          args: ['--root', '/repo'],
          env: [
            { name: 'TOKEN', value: 'secret' },
            { name: 'HOME', value: '/home/dev' },
          ],
        },
      ],
      problems: [],
    });
  });

  it('reports missing passthrough variables and skips the whole server', () => {
    const entry = stdioServer('stdio', {
      connection: { transport: 'stdio', command: 'node', envPassthrough: ['TOKEN'] },
    });
    const result = resolveSessionMcpServers({
      catalog: { [entry.id]: entry },
      selectedIds: [entry.id],
      agentCapabilities: undefined,
      env: {},
    });

    expect(result.servers).toEqual([]);
    expect(result.problems).toEqual([
      {
        kind: 'unresolved_env_var',
        mcpServerId: entry.id,
        name: entry.name,
        field: 'TOKEN',
        variable: 'TOKEN',
      },
    ]);
  });

  it('resolves HTTP bearer authorization and stable sorted headers', () => {
    const id = serverId('remote');
    const entry: WorkspaceMcpServerMeta = {
      id,
      name: 'remote',
      transport: 'http',
      connection: {
        transport: 'http',
        url: 'https://${HOST}/mcp',
        bearerToken: '${TOKEN}',
        headers: { Zebra: 'last', Alpha: '${ALPHA}' },
      },
      createdAt: 1,
      updatedAt: 1,
    };

    expect(
      resolveSessionMcpServers({
        catalog: { [id]: entry },
        selectedIds: [id],
        agentCapabilities: { http: true },
        env: { HOST: 'example.test', TOKEN: 'secret', ALPHA: 'first' },
      }).servers
    ).toEqual([
      {
        type: 'http',
        name: 'remote',
        url: 'https://example.test/mcp',
        headers: [
          { name: 'Authorization', value: 'Bearer secret' },
          { name: 'Alpha', value: 'first' },
          { name: 'Zebra', value: 'last' },
        ],
      },
    ]);
  });

  it('reports every resolver problem kind at its decision boundary', () => {
    const missing = stdioServer('missing', { connection: undefined });
    const invalid = stdioServer('invalid', {
      connection: { transport: 'stdio', command: '   ' },
    });
    const httpId = serverId('http');
    const http: WorkspaceMcpServerMeta = {
      id: httpId,
      name: 'http',
      transport: 'http',
      connection: { transport: 'http', url: 'https://example.test' },
      createdAt: 1,
      updatedAt: 1,
    };
    const unresolved = stdioServer('unresolved', {
      connection: { transport: 'stdio', command: '${BIN}' },
    });

    const result = resolveSessionMcpServers({
      catalog: { missing, invalid, http, unresolved },
      selectedIds: ['unknown', missing.id, http.id, invalid.id, unresolved.id],
      agentCapabilities: { http: false },
      env: {},
    });

    expect(result.problems.map(({ kind }) => kind)).toEqual([
      'unknown_server',
      'missing_connection',
      'unsupported_transport',
      'invalid_connection',
      'unresolved_env_var',
    ]);
  });

  it('deduplicates ids and lets a valid sibling survive a failure', () => {
    const good = stdioServer('good');
    const bad = stdioServer('bad', {
      connection: { transport: 'stdio', command: '${MISSING}' },
    });
    const result = resolveSessionMcpServers({
      catalog: { good, bad },
      selectedIds: [bad.id, good.id, good.id],
      agentCapabilities: undefined,
      env: {},
    });

    expect(result.servers.map(({ name }) => name)).toEqual(['good']);
    expect(result.problems).toHaveLength(1);
  });
});

describe('workspace MCP guards and normalization', () => {
  it('keeps explicit empty selections distinct from absent selections', () => {
    expect(normalizeMcpServerIdSelection([])).toEqual([]);
    expect(normalizeMcpServerIdSelection(undefined)).toBeUndefined();
    expect(normalizeMcpServerIdSelection([' one ', '', 'one', 42, 'two'])).toEqual(['one', 'two']);
  });
});

describe('project default selection', () => {
  it('inherits only absent preferences and filters deleted ids without re-enabling defaults', () => {
    const catalog = [stdioServer('a', { enabledByDefault: true }), stdioServer('b')];
    expect(getEffectiveDefaultMcpIds(catalog)).toEqual(['a']);
    expect(getEffectiveDefaultMcpIds(catalog, { ids: [] })).toEqual([]);
    expect(
      getEffectiveDefaultMcpIds(catalog, { ids: [serverId('b'), serverId('gone'), serverId('b')] })
    ).toEqual(['b']);
    expect(
      getEffectiveDefaultMcpIds([...catalog, stdioServer('new', { enabledByDefault: true })], {
        ids: [serverId('b')],
      })
    ).toEqual(['b']);
  });

  it('shares project defaults across branches but isolates project kinds and machines', () => {
    const local = {
      kind: 'local' as const,
      localProjectId: 'project' as import('../src/project').LocalProjectId,
      githubRepoFullName: 'Example/Repo',
    };
    expect(getProjectMcpKey(local, 'a')).toBe(
      getProjectMcpKey({ ...local, branch: 'feature', useWorktree: true }, 'a')
    );
    expect(getProjectMcpKey(local, 'a')).not.toBe(getProjectMcpKey(local, 'b'));
    expect(getProjectMcpKey(local)).toBeUndefined();
    const github = { kind: 'github' as const, repoFullName: 'Example/Repo', branch: 'main' };
    expect(getProjectMcpKey(github)).toBe(
      getProjectMcpKey({ ...github, repoFullName: 'example/repo', branch: 'feature' })
    );
    expect(getProjectMcpKey(github)).not.toBe(getProjectMcpKey(local, 'a'));
  });
});
