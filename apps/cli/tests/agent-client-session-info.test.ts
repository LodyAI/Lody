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
  it('forwards Claude session_info_update titles', async () => {
    const { client, onUpdateMessage, onSessionTitleUpdate } = createTestClient('claude');

    await client.sessionUpdate(sessionInfoNotification({ title: '  Fix login bug  ' }));

    expect(onSessionTitleUpdate).toHaveBeenCalledWith('Fix login bug');
    // The notification itself still flows through the normal history pipeline.
    expect(onUpdateMessage).toHaveBeenCalledTimes(1);
  });

  it('forwards explicitly named Codex threads', async () => {
    const { client, onSessionTitleUpdate } = createTestClient('codex');

    await client.sessionUpdate(
      sessionInfoNotification({
        title: '  Diagnose title generation  ',
        _meta: { codex: { titleSource: 'explicit' } },
      })
    );

    expect(onSessionTitleUpdate).toHaveBeenCalledWith('Diagnose title generation');
  });

  it('ignores source-tagged Codex prompt fallback titles', async () => {
    const { client, onSessionTitleUpdate } = createTestClient('codex');

    await client.sessionUpdate(
      sessionInfoNotification({
        title: 'first prompt fallback',
        _meta: { codex: { titleSource: 'fallback' } },
      })
    );

    expect(onSessionTitleUpdate).not.toHaveBeenCalled();
  });

  it('ignores untyped Codex titles from older adapters', async () => {
    const { client, onSessionTitleUpdate } = createTestClient('codex');

    await client.sessionUpdate(sessionInfoNotification({ title: 'unknown source' }));

    expect(onSessionTitleUpdate).not.toHaveBeenCalled();
  });

  it('ignores session_info_update titles from agents without native title support', async () => {
    const { client, onSessionTitleUpdate } = createTestClient('kimi');

    await client.sessionUpdate(sessionInfoNotification({ title: 'first prompt fallback' }));

    expect(onSessionTitleUpdate).not.toHaveBeenCalled();
  });
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
