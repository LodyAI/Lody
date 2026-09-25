import { describe, expect, it, vi } from 'vitest';
import type { ACPSessionId, SessionId } from '@lody/shared';
import type { PromptRequest, SessionNotification } from '@agentclientprotocol/sdk';

import { AgentClient } from '../src/agent/agent-client';
import type { Logger } from '../src/utils/logger';

const createSilentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  setLevel: () => {},
  child: () => createSilentLogger(),
  close: async () => {},
});

function createTestClient(agentType: string) {
  const onUpdateMessage = vi.fn();
  const onSessionTitleUpdate = vi.fn();
  const onAgentWarning = vi.fn();
  const client = new AgentClient({
    sessionId: 'test-session' as SessionId,
    logger: createSilentLogger(),
    terminalManager: {} as never,
    agentConfig: { cliType: 'builtin', agentType },
    onUpdateMessage,
    onRequestPermission: vi.fn(async () => ({ outcome: { outcome: 'cancelled' as const } })),
    onSessionTitleUpdate,
    onAgentWarning,
  });
  // @ts-expect-error - accessing private field for test setup
  client.acpSessionId = 'acp-test' as ACPSessionId;
  return { client, onUpdateMessage, onSessionTitleUpdate, onAgentWarning };
}

const sessionInfoNotification = (update: Record<string, unknown>): SessionNotification =>
  ({
    sessionId: 'acp-test',
    update: { sessionUpdate: 'session_info_update', ...update },
  }) as unknown as SessionNotification;

describe('AgentClient goal prompt transport', () => {
  it.each(['pause', 'clear'] as const)(
    'sends cold %s through the advertised prompt transport',
    async (action) => {
      const { client } = createTestClient('codex');
      const requests: PromptRequest[] = [];
      Object.assign(client, {
        lodyExtensionCapabilities: {
          goal: {
            version: 1,
            actions: ['set', 'pause', 'resume', 'clear'],
            controlActions: ['pause', 'clear'],
            promptActions: ['set', 'pause', 'resume', 'clear'],
          },
        },
        connection: {
          prompt: async (request: PromptRequest) => {
            requests.push(request);
            return { stopReason: 'end_turn' as const };
          },
        },
      });
      expect(client.resolveGoalActionTransport(action)).toBe('request');
      await expect(
        client.prompt('acp-test' as ACPSessionId, [], { goalControl: { action } })
      ).resolves.toEqual({ stopReason: 'end_turn' });
      expect(requests).toEqual([
        {
          sessionId: 'acp-test',
          prompt: [],
          _meta: { lody: { goalControl: { version: 1, action } } },
        },
      ]);

      // Manual commands are still ordinary prompts, not rewritten as button metadata.
      await client.prompt('acp-test' as ACPSessionId, [{ type: 'text', text: '/goal Ship it' }]);
      expect(requests[1]).toEqual({
        sessionId: 'acp-test',
        prompt: [{ type: 'text', text: '/goal Ship it' }],
      });
    }
  );
});

describe('AgentClient session title updates', () => {
  it.each([
    ['claude', false, undefined, 'Accepted'],
    ['grok', false, undefined, 'Accepted'],
    ['codex', false, { codex: { titleSource: 'explicit' } }, 'Accepted'],
    ['codex', false, { codex: { titleSource: 'fallback' } }, undefined],
    ['codex', false, undefined, undefined],
    ['kimi', false, undefined, undefined],
    ['custom', true, { lody: { titleSource: 'generated' } }, 'Accepted'],
    ['custom', true, { lody: { titleSource: 'explicit' } }, 'Accepted'],
    ['custom', true, { lody: { titleSource: 'fallback' } }, undefined],
    ['custom', true, { lody: { titleSource: 'unset' } }, undefined],
    ['custom', true, undefined, undefined],
    ['custom', false, { lody: { titleSource: 'generated' } }, undefined],
    ['claude', true, { lody: { titleSource: 'fallback' } }, undefined],
    ['claude', true, undefined, undefined],
    [
      'codex',
      true,
      { lody: { titleSource: 'fallback' }, codex: { titleSource: 'explicit' } },
      undefined,
    ],
    ['claude', false, { lody: { titleSource: 'unknown' } }, undefined],
  ] as const)(
    'routes %s title with capability=%s and metadata=%j',
    async (provider, advertised, meta, expected) => {
      const titles: string[] = [];
      const { client } = createTestClient(provider);
      Object.assign(client, {
        lodyExtensionCapabilities: advertised ? { sessionTitle: { version: 1 } } : {},
      });
      // Observe the title consumer's resulting state, not callback counts.
      Object.assign(client, {
        options: {
          // @ts-expect-error private options are only read for this boundary fixture
          ...client.options,
          agentConfig: {
            cliType: provider === 'custom' ? 'custom' : 'builtin',
            agentType: provider,
          },
          onSessionTitleUpdate: (title: string) => titles.push(title),
        },
      });
      await client.sessionUpdate(sessionInfoNotification({ title: '  Accepted  ', _meta: meta }));
      expect(titles).toEqual(expected ? [expected] : []);
      await client.sessionUpdate(sessionInfoNotification({ title: '   ', _meta: meta }));
      await client.sessionUpdate({
        ...sessionInfoNotification({ title: 'Other session', _meta: meta }),
        sessionId: 'different-session',
      });
      expect(titles).toEqual(expected ? [expected] : []);
    }
  );
});

describe('AgentClient agent warning updates', () => {
  it('forwards Codex session warnings from structured _meta', async () => {
    const { client, onUpdateMessage, onAgentWarning } = createTestClient('codex');

    await client.sessionUpdate(
      sessionInfoNotification({
        _meta: {
          codex: {
            warning: {
              source: 'warning',
              message: 'Skill descriptions were shortened to fit the 2% skills context budget.',
            },
          },
        },
      })
    );

    expect(onAgentWarning).toHaveBeenCalledWith({
      source: 'warning',
      message: 'Skill descriptions were shortened to fit the 2% skills context budget.',
    });
    // The notification itself still flows through the normal pipeline (ignored by history).
    expect(onUpdateMessage).toHaveBeenCalledTimes(1);
  });

  it('ignores warning metadata from non-Codex agents', async () => {
    const { client, onAgentWarning } = createTestClient('claude');

    await client.sessionUpdate(
      sessionInfoNotification({ _meta: { codex: { warning: { message: 'something' } } } })
    );

    expect(onAgentWarning).not.toHaveBeenCalled();
  });
});
