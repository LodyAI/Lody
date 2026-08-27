import { describe, expect, it, vi } from 'vitest';
import * as acp from '@agentclientprotocol/sdk';
import type { SessionInfo } from '@agentclientprotocol/sdk';
import type { ACPSessionId } from '@lody/shared';

import { resolveACPProcessLaunch, resolveACPProcessLaunchAsync } from '../src/agent/setting';
import {
  dedupeHistorySessionsById,
  listPaginatedHistorySessions,
  requestHistorySessionReplay,
  resolveHistoryACPProcessLaunch,
} from '../src/lib/history-session-catalog-client';

function session(sessionId: string, title: string): SessionInfo {
  return {
    sessionId,
    title,
    updatedAt: '2026-05-14T00:00:00.000Z',
  } as SessionInfo;
}

describe('history session catalog client', () => {
  it('paginates listSessions until nextCursor is empty', async () => {
    const calls: Array<{ cwd: string; cursor?: string | null }> = [];
    const result = await listPaginatedHistorySessions('/repo/project', async (params) => {
      calls.push(params);
      if (!params.cursor) {
        return {
          sessions: [session('session-1', 'First')],
          nextCursor: 'page-2',
        };
      }
      return {
        sessions: [session('session-2', 'Second')],
        nextCursor: null,
      };
    });

    expect(calls).toEqual([
      { cwd: '/repo/project', cursor: undefined },
      { cwd: '/repo/project', cursor: 'page-2' },
    ]);
    expect(result.map((item) => item.sessionId)).toEqual(['session-1', 'session-2']);
  });

  it('stops pagination once the requested session limit is filled', async () => {
    const calls: Array<{ cwd: string; cursor?: string | null }> = [];
    const result = await listPaginatedHistorySessions(
      '/repo/project',
      async (params) => {
        calls.push(params);
        const page = params.cursor ? 2 : 1;
        return {
          sessions: Array.from({ length: 60 }, (_, index) =>
            session(`session-${(page - 1) * 60 + index}`, `Session ${index}`)
          ),
          nextCursor: `page-${page + 1}`,
        };
      },
      { maxSessions: 100 }
    );

    expect(calls).toEqual([
      { cwd: '/repo/project', cursor: undefined },
      { cwd: '/repo/project', cursor: 'page-2' },
    ]);
    expect(result).toHaveLength(100);
    expect(result.at(-1)?.sessionId).toBe('session-99');
  });

  it('continues past the limit until explicitly required sessions are found', async () => {
    const calls: Array<{ cwd: string; cursor?: string | null }> = [];
    const result = await listPaginatedHistorySessions(
      '/repo/project',
      async (params) => {
        calls.push(params);
        const page = params.cursor ? 2 : 1;
        return {
          sessions: Array.from({ length: 60 }, (_, index) =>
            session(`session-${(page - 1) * 60 + index}`, `Session ${index}`)
          ),
          nextCursor: page === 1 ? 'page-2' : 'page-3',
        };
      },
      {
        maxSessions: 100,
        requiredSessionIds: new Set(['session-119']),
      }
    );

    expect(calls).toHaveLength(2);
    expect(result).toHaveLength(101);
    expect(result.slice(0, 100).map((item) => item.sessionId)).toEqual(
      Array.from({ length: 100 }, (_, index) => `session-${index}`)
    );
    expect(result.at(-1)?.sessionId).toBe('session-119');
  });

  it('dedupes sessions by acp session id with later entries winning', () => {
    const result = dedupeHistorySessionsById([
      session('session-1', 'Old title'),
      session('session-2', 'Other'),
      session('session-1', 'New title'),
    ]);

    expect(result.map((item) => [item.sessionId, item.title])).toEqual([
      ['session-1', 'New title'],
      ['session-2', 'Other'],
    ]);
  });
});

describe('requestHistorySessionReplay', () => {
  const acpSessionId = 'session-1' as ACPSessionId;
  const codexProvider = { cliType: 'builtin', agentType: 'codex' } as const;

  function initializeResponse(
    overrides: Partial<acp.InitializeResponse> = {}
  ): acp.InitializeResponse {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {},
      authMethods: [],
      ...overrides,
    };
  }

  it('uses the advertised Lody read-only method for builtin Codex', async () => {
    const request = vi.fn(async () => ({}));
    const loadSession = vi.fn(async () => ({}));

    await requestHistorySessionReplay({
      provider: codexProvider,
      acpSessionId,
      cwd: '/repo/project',
      connection: { request, loadSession } as never,
      initResponse: initializeResponse({
        agentCapabilities: {
          _meta: {
            lody: {
              sessionHistory: {
                version: 1,
                method: '_lody/session/history/read',
              },
            },
          },
        },
      }),
    });

    expect(request).toHaveBeenCalledWith('_lody/session/history/read', {
      sessionId: acpSessionId,
    });
    expect(loadSession).not.toHaveBeenCalled();
  });

  it('fails closed when builtin Codex does not advertise the read-only method', async () => {
    const request = vi.fn(async () => ({}));
    const loadSession = vi.fn(async () => ({}));

    await expect(
      requestHistorySessionReplay({
        provider: codexProvider,
        acpSessionId,
        cwd: '/repo/project',
        connection: { request, loadSession } as never,
        initResponse: initializeResponse({
          agentCapabilities: { loadSession: true },
        }),
      })
    ).rejects.toThrow('agentCapabilities._meta.lody.sessionHistory version 1');
    expect(request).not.toHaveBeenCalled();
    expect(loadSession).not.toHaveBeenCalled();
  });

  it('keeps loadSession for non-Codex providers', async () => {
    const request = vi.fn(async () => ({}));
    const loadSession = vi.fn(async () => ({}));

    await requestHistorySessionReplay({
      provider: { cliType: 'registry', agentType: 'auggie' },
      acpSessionId,
      cwd: '/repo/project',
      connection: { request, loadSession } as never,
      initResponse: initializeResponse({
        agentCapabilities: { loadSession: true },
      }),
    });

    expect(request).not.toHaveBeenCalled();
    expect(loadSession).toHaveBeenCalledWith({
      sessionId: acpSessionId,
      cwd: '/repo/project',
      mcpServers: [],
    });
  });
});

describe('resolveHistoryACPProcessLaunch', () => {
  it('uses the same builtin Codex bundled-adapter launch as normal sessions', async () => {
    const provider = {
      cliType: 'builtin',
      agentType: 'codex',
      runtimeOverrides: { codexPath: '/opt/lody/codex' },
    } as const;
    const sessionLaunch = await resolveACPProcessLaunchAsync(provider);
    const historyLaunch = await resolveHistoryACPProcessLaunch({
      provider,
      env: { PATH: '/usr/bin' },
    });

    expect(historyLaunch.command).toBe(sessionLaunch.command);
    expect(historyLaunch.args).toEqual(sessionLaunch.args);
    expect(historyLaunch.command).toBe(process.execPath);
    expect(historyLaunch.args[0]).toContain('codex-acp.js');
    expect(historyLaunch.env.CODEX_PATH).toBe('/opt/lody/codex');
    expect(historyLaunch.env.PATH).toBe('/usr/bin');
  });

  it('uses the same registry Interactive Claude npx launch as normal sessions', async () => {
    const provider = { cliType: 'registry', agentType: 'claude-p' } as const;
    const sessionLaunch = resolveACPProcessLaunch(provider);
    const historyLaunch = await resolveHistoryACPProcessLaunch({
      provider,
      env: { PATH: '/usr/bin' },
    });

    expect(historyLaunch.command).toBe(sessionLaunch.command);
    expect(historyLaunch.args).toEqual(sessionLaunch.args);
    expect(historyLaunch.command).toBe('npx');
    expect(historyLaunch.args).toContain('--registry=https://registry.npmjs.org/');
    expect(historyLaunch.args.some((arg) => /^acp-extension-claude-pty.*@0\.1\.5$/.test(arg))).toBe(
      true
    );
    expect(historyLaunch.env.PATH).toBe('/usr/bin');
  });

  it('uses the same registry ACP npx launch as normal sessions', async () => {
    const provider = { cliType: 'registry', agentType: 'auggie' } as const;
    const sessionLaunch = resolveACPProcessLaunch(provider);
    const historyLaunch = await resolveHistoryACPProcessLaunch({
      provider,
      env: { PATH: '/usr/bin' },
    });

    expect(historyLaunch.command).toBe(sessionLaunch.command);
    expect(historyLaunch.args).toEqual(sessionLaunch.args);
    expect(historyLaunch.env.PATH).toBe('/usr/bin');
    expect(historyLaunch.env.AUGMENT_DISABLE_AUTO_UPDATE).toBe('1');
  });

  it('uses the same registry ACP local launch as normal sessions', async () => {
    const provider = { cliType: 'registry', agentType: 'amp-acp' } as const;
    const sessionLaunch = resolveACPProcessLaunch(provider);
    const historyLaunch = await resolveHistoryACPProcessLaunch({
      provider,
      env: { PATH: '/usr/bin' },
    });

    expect(historyLaunch.command).toBe(sessionLaunch.command);
    expect(historyLaunch.args).toEqual(sessionLaunch.args);
    expect(historyLaunch.command).toBe('npx');
    expect(historyLaunch.args).toEqual(['--prefer-offline', '-y', 'amp-acp@0.9.0']);
  });
});
