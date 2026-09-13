import { describe, expect, it } from 'vitest';
import type { McpServerId, WorkspaceMcpServerMeta } from '@lody/shared';
import {
  createBuiltinMcpEntry,
  createUniqueBuiltinMcpName,
  findBuiltinMcpEntry,
} from '../src/lib/builtin-mcp-connectors';

const customEntry = (id: string, name: string): WorkspaceMcpServerMeta => ({
  id: id as McpServerId,
  name,
  transport: 'http',
  connection: { transport: 'http', url: 'https://example.test/mcp' },
  createdAt: 1,
  updatedAt: 1,
});

describe('built-in MCP connector catalog helpers', () => {
  it('creates a secret-free preset row with the reviewed provider policy', () => {
    const entry = createBuiltinMcpEntry({
      providerId: 'posthog',
      id: 'posthog-id' as McpServerId,
      now: 42,
      servers: [],
      description: 'Analytics',
      createdBy: 'user-1',
    });

    expect(entry).toEqual({
      id: 'posthog-id',
      name: 'PostHog',
      transport: 'http',
      description: 'Analytics',
      source: {
        kind: 'builtin',
        providerId: 'posthog',
        presetVersion: 1,
        accessProfile: 'readonly',
      },
      enabledByDefault: false,
      createdAt: 42,
      updatedAt: 42,
      createdBy: 'user-1',
    });
    expect(entry.connection).toBeUndefined();
    expect(JSON.stringify(entry)).not.toMatch(/token|secret|authorization/i);
  });

  it('does not mistake a same-name custom server for an installed preset', () => {
    const custom = customEntry('custom-linear', 'Linear');
    const builtin = createBuiltinMcpEntry({
      providerId: 'linear',
      id: 'builtin-linear' as McpServerId,
      now: 2,
      servers: [custom],
    });

    expect(builtin.name).toBe('Linear (Lody)');
    expect(findBuiltinMcpEntry([custom], 'linear')).toBeUndefined();
    expect(findBuiltinMcpEntry([custom, builtin], 'linear')).toBe(builtin);
  });

  it('chooses a deterministic unique name when prior names already exist', () => {
    const servers = [
      customEntry('one', 'Notion'),
      customEntry('two', 'Notion (Lody)'),
      customEntry('three', 'Notion (Lody) 2'),
    ];
    expect(createUniqueBuiltinMcpName('Notion', servers)).toBe('Notion (Lody) 3');
  });

  it('uses the localized provider name supplied by the settings UI', () => {
    const entry = createBuiltinMcpEntry({
      providerId: 'feishu',
      displayName: '飞书',
      id: 'feishu-id' as McpServerId,
      now: 7,
      servers: [],
    });

    expect(entry.name).toBe('飞书');
  });
});
