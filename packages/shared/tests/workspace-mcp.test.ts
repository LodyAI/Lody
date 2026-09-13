import { describe, expect, it } from 'vitest';

import type { McpServerId } from '../src/ids';
import { BUILTIN_MCP_PROVIDERS, getBuiltinMcpProvider } from '../src/builtin-mcp-providers';
import {
  formatMcpResolutionProblem,
  interpolateEnvVars,
  isMcpConnectionSpec,
  isWorkspaceMcpServerMeta,
  normalizeMcpServerIdSelection,
  resolveSessionMcpServers,
  type McpResolutionProblem,
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
  it('interpolates set variables and preserves missing placeholders', () => {
    expect(
      interpolateEnvVars('https://${HOST}/${PATH}', { HOST: 'example.test', PATH: 'mcp' })
    ).toEqual({
      value: 'https://example.test/mcp',
      missing: [],
    });
    expect(interpolateEnvVars('token=${TOKEN}', {})).toEqual({
      value: 'token=${TOKEN}',
      missing: ['TOKEN'],
    });
    expect(interpolateEnvVars('token=${TOKEN}', { TOKEN: '' })).toEqual({
      value: 'token=${TOKEN}',
      missing: ['TOKEN'],
    });
  });

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

  it('formats all problem kinds as actionable warnings', () => {
    const problems: McpResolutionProblem[] = [
      { kind: 'catalog_unavailable', reason: 'offline' },
      { kind: 'unknown_server', mcpServerId: serverId('unknown') },
      { kind: 'missing_connection', mcpServerId: serverId('missing'), name: 'Missing' },
      {
        kind: 'unsupported_transport',
        mcpServerId: serverId('http'),
        name: 'HTTP',
        transport: 'http',
      },
      {
        kind: 'unresolved_env_var',
        mcpServerId: serverId('env'),
        name: 'Env',
        field: 'bearerToken',
        variable: 'TOKEN',
      },
      {
        kind: 'invalid_connection',
        mcpServerId: serverId('invalid'),
        name: 'Invalid',
        reason: 'empty URL',
      },
    ];

    for (const problem of problems) {
      expect(formatMcpResolutionProblem(problem)).toMatch(/Settings|retry|connectivity|selection/i);
    }
  });
});

describe('workspace MCP guards and normalization', () => {
  it('accepts valid connection specs and rejects malformed or SSE specs', () => {
    expect(isMcpConnectionSpec({ transport: 'stdio', command: 'node', args: ['server.js'] })).toBe(
      true
    );
    expect(isMcpConnectionSpec({ transport: 'http', url: 'https://example.test/mcp' })).toBe(true);
    expect(isMcpConnectionSpec({ transport: 'stdio', command: 42 })).toBe(false);
    expect(isMcpConnectionSpec({ transport: 'http', url: 42 })).toBe(false);
    expect(isMcpConnectionSpec({ transport: 'sse', url: 'https://example.test/sse' })).toBe(false);
  });

  it('keeps explicit empty selections distinct from absent selections', () => {
    expect(normalizeMcpServerIdSelection([])).toEqual([]);
    expect(normalizeMcpServerIdSelection(undefined)).toBeUndefined();
    expect(normalizeMcpServerIdSelection([' one ', '', 'one', 42, 'two'])).toEqual(['one', 'two']);
  });

  it('accepts a public built-in preset without a connection and rejects secret overrides', () => {
    const preset: WorkspaceMcpServerMeta = {
      id: serverId('linear'),
      name: 'Linear',
      transport: 'http',
      source: {
        kind: 'builtin',
        providerId: 'linear',
        presetVersion: 1,
        accessProfile: 'readonly',
      },
      createdAt: 1,
      updatedAt: 1,
    };

    expect(isWorkspaceMcpServerMeta(preset)).toBe(true);
    expect(
      isWorkspaceMcpServerMeta({
        ...preset,
        connection: {
          transport: 'http',
          url: 'https://attacker.example/mcp',
          bearerToken: 'workspace-readable-secret',
        },
      })
    ).toBe(false);
    expect(
      isWorkspaceMcpServerMeta({
        ...preset,
        source: {
          kind: 'builtin',
          providerId: 'unknown-provider',
          presetVersion: 1,
          accessProfile: 'readonly',
        },
      })
    ).toBe(false);
    expect(
      isWorkspaceMcpServerMeta({
        ...preset,
        source: { ...preset.source, publicOptions: { bearerToken: 'workspace-readable-secret' } },
      })
    ).toBe(false);
    expect(
      isWorkspaceMcpServerMeta({
        ...preset,
        source: { ...preset.source, presetVersion: 999 },
      })
    ).toBe(false);

    const posthogPreset: WorkspaceMcpServerMeta = {
      ...preset,
      id: serverId('posthog'),
      name: 'PostHog',
      source: {
        kind: 'builtin',
        providerId: 'posthog',
        presetVersion: 1,
        accessProfile: 'readonly',
        publicOptions: { mode: 'cli' },
      },
    };
    expect(isWorkspaceMcpServerMeta(posthogPreset)).toBe(true);
    expect(
      isWorkspaceMcpServerMeta({
        ...posthogPreset,
        source: { ...posthogPreset.source, publicOptions: { mode: 'cli', readonly: true } },
      })
    ).toBe(false);
  });

  it('keeps the built-in registry pinned to the five reviewed providers', () => {
    expect(BUILTIN_MCP_PROVIDERS.map(({ id }) => id)).toEqual([
      'linear',
      'notion',
      'cloudflare',
      'posthog',
      'feishu',
    ]);
    expect(getBuiltinMcpProvider('linear').endpoint).toBe('https://mcp.linear.app/mcp/readonly');
    expect(getBuiltinMcpProvider('posthog').endpoint).toBe(
      'https://mcp.posthog.com/mcp?mode=cli&readonly=true'
    );
    expect(getBuiltinMcpProvider('posthog').oauthResource).toBe('https://mcp.posthog.com/mcp');
    expect(getBuiltinMcpProvider('feishu').endpoint).toBeUndefined();
  });

  it('reports an unconnected built-in preset as auth required without exposing an endpoint', () => {
    const entry: WorkspaceMcpServerMeta = {
      id: serverId('linear'),
      name: 'Linear',
      transport: 'http',
      source: {
        kind: 'builtin',
        providerId: 'linear',
        presetVersion: 1,
        accessProfile: 'readonly',
      },
      createdAt: 1,
      updatedAt: 1,
    };

    const result = resolveSessionMcpServers({
      catalog: { [entry.id]: entry },
      selectedIds: [entry.id],
      agentCapabilities: { http: true },
      env: {},
    });

    expect(result.servers).toEqual([]);
    expect(result.problems).toEqual([
      {
        kind: 'auth_required',
        mcpServerId: entry.id,
        name: 'Linear',
        providerId: 'linear',
      },
    ]);
    expect(formatMcpResolutionProblem(result.problems[0])).toContain('needs authorization');
  });
});
