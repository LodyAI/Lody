import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ACPSessionId,
  AgentConfigCliType,
  MachineId,
  SessionId,
  WorkspaceId,
} from '@lody/shared';
import { parseAskUserQuestionPermissionMeta } from '@lody/shared';
import type {
  CreateElicitationRequest,
  SessionNotification,
  RequestPermissionRequest,
} from '@agentclientprotocol/sdk';

import { AgentClient } from '../src/agent/agent-client';
import { loadEnv } from '../src/utils/const';
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

/** Helper to create an AgentClient with pre-configured modes for testing. */
function createTestClient(options?: {
  cliType?: AgentConfigCliType;
  agentType?: string;
  workspaceId?: WorkspaceId;
  machineId?: MachineId;
}) {
  const logger = createSilentLogger();
  const onUpdateMessage = vi.fn();
  const onContextWindowUsageUpdate = vi.fn();
  const onUsageUpdate = vi.fn();
  const onRateLimitUpdate = vi.fn();
  const onThreadGoalUpdated = vi.fn();
  const onThreadGoalCleared = vi.fn();
  const onCodexProposedPlan = vi.fn();
  const onCodexImageGenerationBegin = vi.fn();
  const onCodexImageGenerationEnd = vi.fn();
  const onRequestPermission = vi.fn(async () => ({
    outcome: { outcome: 'selected' as const, optionId: 'opt-1' },
  }));

  const client = new AgentClient({
    sessionId: 'test-session' as SessionId,
    workspaceId: options?.workspaceId,
    machineId: options?.machineId,
    logger,
    terminalManager: {} as never,
    agentConfig: {
      cliType: options?.cliType ?? 'builtin',
      agentType: options?.agentType ?? 'codex',
    },
    onUpdateMessage,
    onContextWindowUsageUpdate,
    onUsageUpdate,
    onRateLimitUpdate,
    onThreadGoalUpdated,
    onThreadGoalCleared,
    onCodexProposedPlan,
    onCodexImageGenerationBegin,
    onCodexImageGenerationEnd,
    onRequestPermission,
  });

  // Simulate session startup by setting internal fields directly
  // @ts-expect-error - accessing private field for test setup
  client.acpSessionId = 'acp-test' as ACPSessionId;

  return {
    client,
    onUpdateMessage,
    onContextWindowUsageUpdate,
    onUsageUpdate,
    onRateLimitUpdate,
    onThreadGoalUpdated,
    onThreadGoalCleared,
    onCodexProposedPlan,
    onCodexImageGenerationBegin,
    onCodexImageGenerationEnd,
    onRequestPermission,
  };
}

function makePermissionRequest(kind?: string): RequestPermissionRequest {
  return {
    sessionId: 'acp-test',
    toolCall: {
      toolCallId: 'tc-1',
      title: 'Test tool',
      kind: kind ?? 'execute',
    },
    options: [
      { optionId: 'opt-allow', name: 'Allow', kind: 'allow_once' as const },
      { optionId: 'opt-deny', name: 'Deny' },
    ],
  } as RequestPermissionRequest;
}

function makeCurrentModeUpdateNotification(modeId: string): SessionNotification {
  return {
    sessionId: 'acp-test',
    update: {
      sessionUpdate: 'current_mode_update',
      currentModeId: modeId,
    },
  } as SessionNotification;
}

function makeUsageUpdateNotification(params?: {
  size?: unknown;
  used?: unknown;
}): SessionNotification {
  return {
    sessionId: 'acp-test',
    update: {
      sessionUpdate: 'usage_update',
      size: params?.size ?? 4096,
      used: params?.used ?? 1024,
    },
  } as SessionNotification;
}

describe('AgentClient plan mode permission restoration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Lody MCP server config', () => {
    it('passes public deployment endpoints to the MCP subprocess', () => {
      const keys = ['LODY_AUTH_URL', 'LODY_AUTH_SITE_URL', 'LODY_SERVER_URL'] as const;
      const previous = new Map(keys.map((key) => [key, process.env[key]]));
      process.env.LODY_AUTH_URL = 'https://convex.example.test';
      process.env.LODY_AUTH_SITE_URL = 'https://site.example.test';
      process.env.LODY_SERVER_URL = 'https://server.example.test';
      loadEnv();

      try {
        const { client } = createTestClient({
          workspaceId: 'workspace-1' as WorkspaceId,
          machineId: 'machine-1' as MachineId,
        });

        // @ts-expect-error - exercising private config builder for a focused regression test
        const [server] = client.buildMcpServers('/tmp/lody-session');

        expect(server.env).toEqual(
          expect.arrayContaining([
            { name: 'LODY_AUTH_URL', value: 'https://convex.example.test' },
            { name: 'LODY_AUTH_SITE_URL', value: 'https://site.example.test' },
            { name: 'LODY_SERVER_URL', value: 'https://server.example.test' },
          ])
        );
        expect(server.env).not.toContainEqual(expect.objectContaining({ name: 'LODY_CLI_TOKEN' }));
      } finally {
        for (const key of keys) {
          const value = previous.get(key);
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
        loadEnv();
      }
    });

    it('passes ELECTRON_RUN_AS_NODE through when the embedded Electron CLI is running as Node', () => {
      const previous = process.env.ELECTRON_RUN_AS_NODE;
      process.env.ELECTRON_RUN_AS_NODE = '1';
      try {
        const { client } = createTestClient({
          workspaceId: 'workspace-1' as WorkspaceId,
          machineId: 'machine-1' as MachineId,
        });

        // @ts-expect-error - exercising private config builder for a focused regression test
        const [server] = client.buildMcpServers('/tmp/lody-session');

        expect(server.env).toContainEqual({ name: 'ELECTRON_RUN_AS_NODE', value: '1' });
      } finally {
        if (previous === undefined) {
          delete process.env.ELECTRON_RUN_AS_NODE;
        } else {
          process.env.ELECTRON_RUN_AS_NODE = previous;
        }
      }
    });

    it('does not add Electron-only env when running from a normal Node CLI', () => {
      const previous = process.env.ELECTRON_RUN_AS_NODE;
      delete process.env.ELECTRON_RUN_AS_NODE;
      try {
        const { client } = createTestClient({
          workspaceId: 'workspace-1' as WorkspaceId,
          machineId: 'machine-1' as MachineId,
        });

        // @ts-expect-error - exercising private config builder for a focused regression test
        const [server] = client.buildMcpServers('/tmp/lody-session');

        expect(server.env).not.toContainEqual({ name: 'ELECTRON_RUN_AS_NODE', value: '1' });
      } finally {
        if (previous === undefined) {
          delete process.env.ELECTRON_RUN_AS_NODE;
        } else {
          process.env.ELECTRON_RUN_AS_NODE = previous;
        }
      }
    });
  });

  describe('requestPermission', () => {
    it('sends all permission requests through the normal flow', async () => {
      const { client, onRequestPermission } = createTestClient();

      await client.requestPermission(makePermissionRequest('execute'));

      expect(onRequestPermission).toHaveBeenCalled();
    });

    it('sends switch_mode requests through normal flow', async () => {
      const { client, onRequestPermission } = createTestClient();

      await client.requestPermission(makePermissionRequest('switch_mode'));

      expect(onRequestPermission).toHaveBeenCalled();
    });
  });

  describe('permission mode routing', () => {
    it('does not treat current_mode_update as Codex plan-mode control state', async () => {
      const { client } = createTestClient();
      const setSessionModeSpy = vi.fn(async () => ({}));
      // @ts-expect-error - accessing private field for test setup
      client.connection = { setSessionMode: setSessionModeSpy };

      await client.setSessionMode('acp-test' as ACPSessionId, 'default');
      setSessionModeSpy.mockClear();

      await client.sessionUpdate(makeCurrentModeUpdateNotification('plan'));
      await client.sessionUpdate(makeCurrentModeUpdateNotification('acceptEdits'));

      expect(setSessionModeSpy).not.toHaveBeenCalled();
    });

    it('does not restore mode when agent transitions between non-plan modes', async () => {
      const { client } = createTestClient();
      const setSessionModeSpy = vi.fn(async () => ({}));
      // @ts-expect-error - accessing private field for test setup
      client.connection = { setSessionMode: setSessionModeSpy };

      // User selects default mode
      await client.setSessionMode('acp-test' as ACPSessionId, 'default');
      setSessionModeSpy.mockClear();

      // Agent transitions from default to acceptEdits (not from plan)
      await client.sessionUpdate(makeCurrentModeUpdateNotification('acceptEdits'));

      // Should NOT trigger a mode restore
      expect(setSessionModeSpy).not.toHaveBeenCalled();
    });

    it('does not restore mode when agent exits plan to the same mode user selected', async () => {
      const { client } = createTestClient();
      const setSessionModeSpy = vi.fn(async () => ({}));
      // @ts-expect-error - accessing private field for test setup
      client.connection = { setSessionMode: setSessionModeSpy };

      // User selects acceptEdits mode
      await client.setSessionMode('acp-test' as ACPSessionId, 'acceptEdits');
      setSessionModeSpy.mockClear();

      // Agent enters plan mode
      await client.sessionUpdate(makeCurrentModeUpdateNotification('plan'));

      // Agent exits plan mode → transitions to acceptEdits (same as user's selection)
      await client.sessionUpdate(makeCurrentModeUpdateNotification('acceptEdits'));

      // Should NOT trigger a mode restore since modes already match
      expect(setSessionModeSpy).not.toHaveBeenCalled();
    });

    it('keeps plan mode separate from session/set_mode permission routing', async () => {
      const { client } = createTestClient();
      const setSessionModeSpy = vi.fn(async () => ({}));
      // @ts-expect-error - accessing private field for test setup
      client.connection = { setSessionMode: setSessionModeSpy };

      // User selects default mode
      await client.setSessionMode('acp-test' as ACPSessionId, 'default');

      // Agent enters plan mode
      await client.sessionUpdate(makeCurrentModeUpdateNotification('plan'));

      // Agent exits plan mode → transitions to acceptEdits
      await client.sessionUpdate(makeCurrentModeUpdateNotification('acceptEdits'));

      expect(setSessionModeSpy).toHaveBeenCalledTimes(1);
      expect(setSessionModeSpy).toHaveBeenCalledWith({
        sessionId: 'acp-test',
        modeId: 'default',
      });
    });

    it('does not track user-selected mode for auto-restore', async () => {
      const { client } = createTestClient();
      const setSessionModeSpy = vi.fn(async () => ({}));
      // @ts-expect-error - accessing private field for test setup
      client.connection = { setSessionMode: setSessionModeSpy };

      await client.setSessionMode('acp-test' as ACPSessionId, 'acceptEdits');
      await client.setSessionMode('acp-test' as ACPSessionId, 'default');

      expect(setSessionModeSpy).toHaveBeenNthCalledWith(1, {
        sessionId: 'acp-test',
        modeId: 'acceptEdits',
      });
      expect(setSessionModeSpy).toHaveBeenNthCalledWith(2, {
        sessionId: 'acp-test',
        modeId: 'default',
      });
    });
  });

  describe('context window usage updates', () => {
    it('handles usage_update via context callback only', async () => {
      const { client, onUpdateMessage, onContextWindowUsageUpdate } = createTestClient();

      await client.sessionUpdate(makeUsageUpdateNotification({ size: 8192, used: 2048 }));

      expect(onContextWindowUsageUpdate).toHaveBeenCalledWith({ size: 8192, used: 2048 });
      expect(onUpdateMessage).not.toHaveBeenCalled();
    });

    it('ignores invalid usage_update payloads', async () => {
      const { client, onUpdateMessage, onContextWindowUsageUpdate } = createTestClient();

      await client.sessionUpdate(makeUsageUpdateNotification({ size: 'bad', used: 100 }));

      expect(onContextWindowUsageUpdate).not.toHaveBeenCalled();
      expect(onUpdateMessage).not.toHaveBeenCalled();
    });

    it('ignores non-finite and negative usage_update values', async () => {
      const { client, onUpdateMessage, onContextWindowUsageUpdate } = createTestClient();

      await client.sessionUpdate(makeUsageUpdateNotification({ size: Number.NaN, used: 100 }));
      await client.sessionUpdate(makeUsageUpdateNotification({ size: 8192, used: -1 }));

      expect(onContextWindowUsageUpdate).not.toHaveBeenCalled();
      expect(onUpdateMessage).not.toHaveBeenCalled();
    });
  });

  describe('ACP extension updates', () => {
    it('holds the steer application notification until its ownership lease is released', async () => {
      const { client, onUpdateMessage } = createTestClient({ agentType: 'claude' });
      const prompt = vi.fn(() => new Promise(() => {}));
      // @ts-expect-error - focused protocol-boundary setup
      client.connection = { prompt };
      // @ts-expect-error - focused capability-negotiation setup
      client.acknowledgedSteerCapability = {
        provider: 'claudeCode',
        appliedNotificationMethod: 'claude/steerApplied',
        upstreamTurn: 'handoff',
        configPolicy: 'apply',
      };

      const steerRun = client.steerPrompt('acp-test' as ACPSessionId, [
        { type: 'text', text: 'guide' },
      ]);
      const request = prompt.mock.calls[0]?.[0];
      const steerId = request?._meta?.claudeCode?.steer?.id;
      expect(steerId).toEqual(expect.any(String));

      let notificationCompleted = false;
      const notification = client
        .extNotification?.('_claude/steerApplied', {
          sessionId: 'acp-test',
          steerId,
        })
        .then(() => {
          notificationCompleted = true;
        });
      const lease = await steerRun.applied;
      expect(notificationCompleted).toBe(false);
      const postApplicationUpdate = client.sessionUpdate({
        sessionId: 'acp-test',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'after application' },
        },
      });
      await Promise.resolve();
      expect(onUpdateMessage).not.toHaveBeenCalled();

      lease.release();
      await notification;
      await postApplicationUpdate;
      expect(notificationCompleted).toBe(true);
      expect(onUpdateMessage).toHaveBeenCalledOnce();
    });

    it('handles rate limit extension notifications', async () => {
      const { client, onRateLimitUpdate } = createTestClient();
      const limits = {
        schemaVersion: 2 as const,
        planName: '"pro"',
        limitName: null,
        limitId: 'codex',
        windows: [
          {
            usedPercent: 18,
            windowDurationMins: 7 * 24 * 60,
            resetsAt: 1777400602,
          },
        ],
        fiveHour: 3,
        sevenDay: 82,
        fiveHourResetAt: 1777288209,
        sevenDayResetAt: 1777400602,
      };

      await expect(client.extNotification?.('_acp_ext:session_rate_limits', limits)).resolves.toBe(
        undefined
      );

      expect(onRateLimitUpdate).toHaveBeenCalledWith(limits);
    });

    it('keeps handling rate limit extension method requests', async () => {
      const { client, onRateLimitUpdate } = createTestClient();
      const limits = {
        planName: null,
        fiveHour: 3,
        sevenDay: 82,
        fiveHourResetAt: 1777288209,
        sevenDayResetAt: 1777400602,
      };

      await expect(client.extMethod('_acp_ext:session_rate_limits', limits)).resolves.toEqual({});

      expect(onRateLimitUpdate).toHaveBeenCalledWith(limits);
    });

    it('routes completed Codex proposed plan extension notifications through proposed plan updates', async () => {
      const { client, onCodexProposedPlan, onUpdateMessage } = createTestClient();

      await client.extNotification?.('_acp_ext:codex_proposed_plan', {
        schemaVersion: 1,
        sessionId: 'acp-test',
        turnId: 'codex-turn-1',
        markdown: '- Inspect event routing',
        status: 'completed',
        isLatest: true,
      });

      expect(onCodexProposedPlan).toHaveBeenCalledWith({
        type: 'proposed_plan',
        turnId: 'codex-turn-1',
        markdown: '- Inspect event routing',
        status: 'completed',
        isLatest: true,
      });
      expect(onUpdateMessage).not.toHaveBeenCalled();
    });

    it('ignores non-standard Codex proposed plan extension method names', async () => {
      const { client, onCodexProposedPlan, onUpdateMessage } = createTestClient();

      await client.extNotification?.('codex_proposed_plan', {
        schemaVersion: 1,
        sessionId: 'acp-test',
        turnId: 'codex-turn-1',
        markdown: '- Inspect event routing',
        status: 'completed',
        isLatest: true,
      });

      expect(onCodexProposedPlan).not.toHaveBeenCalled();
      expect(onUpdateMessage).not.toHaveBeenCalled();
    });

    it('routes in-progress Codex proposed plan deltas through proposed plan updates', async () => {
      const { client, onCodexProposedPlan, onUpdateMessage } = createTestClient();

      await client.extNotification?.('_acp_ext:codex_proposed_plan', {
        schemaVersion: 1,
        sessionId: 'acp-test',
        turnId: 'codex-turn-1',
        markdown: '- Inspect event routing',
        status: 'delta',
        isLatest: true,
      });

      expect(onCodexProposedPlan).toHaveBeenCalledWith({
        type: 'proposed_plan',
        turnId: 'codex-turn-1',
        markdown: '- Inspect event routing',
        status: 'delta',
        isLatest: true,
      });
      expect(onUpdateMessage).not.toHaveBeenCalled();
    });

    it('routes Codex image generation tool calls to begin/end callbacks and suppresses them', async () => {
      const { client, onUpdateMessage, onCodexImageGenerationBegin, onCodexImageGenerationEnd } =
        createTestClient();

      await client.sessionUpdate({
        sessionId: 'acp-test',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'ig-1',
          title: 'Image generation',
          kind: 'other',
          status: 'in_progress',
        },
      } as SessionNotification);

      await client.sessionUpdate({
        sessionId: 'acp-test',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'ig-1',
          status: 'completed',
          content: [
            { type: 'content', content: { type: 'text', text: 'Revised prompt: a calmer prompt' } },
            {
              type: 'content',
              content: {
                type: 'image',
                data: 'aGVsbG8=',
                mimeType: 'image/png',
                uri: '/tmp/codex-image.png',
              },
            },
          ],
        },
      } as SessionNotification);

      expect(onCodexImageGenerationBegin).toHaveBeenCalledWith({
        acpSessionId: 'acp-test',
        callId: 'ig-1',
      });
      expect(onCodexImageGenerationEnd).toHaveBeenCalledWith({
        acpSessionId: 'acp-test',
        callId: 'ig-1',
        status: 'completed',
        revisedPrompt: 'a calmer prompt',
        savedPath: '/tmp/codex-image.png',
        image: {
          data: 'aGVsbG8=',
          mimeType: 'image/png',
          uri: '/tmp/codex-image.png',
        },
      });
      // Image generation notifications must not reach the history pipeline —
      // upload-and-attach happens on the host side via the begin/end callbacks.
      expect(onUpdateMessage).not.toHaveBeenCalled();
    });

    it('extracts Codex image generation output fields from rawOutput fallback', async () => {
      const { client, onUpdateMessage, onCodexImageGenerationEnd } = createTestClient();

      await client.sessionUpdate({
        sessionId: 'acp-test',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'ig-raw-output',
          title: 'Image generation',
          kind: 'other',
          status: 'in_progress',
        },
      } as SessionNotification);

      await client.sessionUpdate({
        sessionId: 'acp-test',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'ig-raw-output',
          status: 'completed',
          rawOutput: {
            call_id: 'ig-raw-output',
            status: 'completed',
            revised_prompt: 'raw output prompt',
            result: 'aGVsbG8=',
            saved_path: '/tmp/codex-image-from-raw-output.png',
          },
        },
      } as SessionNotification);

      expect(onCodexImageGenerationEnd).toHaveBeenCalledWith({
        acpSessionId: 'acp-test',
        callId: 'ig-raw-output',
        status: 'completed',
        revisedPrompt: 'raw output prompt',
        savedPath: '/tmp/codex-image-from-raw-output.png',
        image: {
          data: 'aGVsbG8=',
          mimeType: 'image/png',
          uri: '/tmp/codex-image-from-raw-output.png',
        },
      });
      expect(onUpdateMessage).not.toHaveBeenCalled();
    });

    it('emits in-progress end events for streaming Codex image generation updates', async () => {
      const { client, onCodexImageGenerationEnd } = createTestClient();

      await client.sessionUpdate({
        sessionId: 'acp-test',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'ig-1',
          title: 'Image generation',
          kind: 'other',
          status: 'in_progress',
        },
      } as SessionNotification);

      await client.sessionUpdate({
        sessionId: 'acp-test',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'ig-1',
          status: 'in_progress',
        },
      } as SessionNotification);

      expect(onCodexImageGenerationEnd).toHaveBeenCalledWith({
        acpSessionId: 'acp-test',
        callId: 'ig-1',
        status: 'in_progress',
        revisedPrompt: undefined,
        savedPath: undefined,
      });
    });

    it('handles a fresh terminal tool_call when the begin notification was lost on resume', async () => {
      const { client, onCodexImageGenerationBegin, onCodexImageGenerationEnd } = createTestClient();

      await client.sessionUpdate({
        sessionId: 'acp-test',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'ig-2',
          title: 'Image generation',
          kind: 'other',
          status: 'completed',
          content: [
            {
              type: 'content',
              content: {
                type: 'image',
                data: 'aGVsbG8=',
                mimeType: 'image/png',
                uri: '/tmp/codex-image.png',
              },
            },
          ],
        },
      } as SessionNotification);

      expect(onCodexImageGenerationBegin).toHaveBeenCalledWith({
        acpSessionId: 'acp-test',
        callId: 'ig-2',
      });
      expect(onCodexImageGenerationEnd).toHaveBeenCalledWith({
        acpSessionId: 'acp-test',
        callId: 'ig-2',
        status: 'completed',
        revisedPrompt: undefined,
        savedPath: '/tmp/codex-image.png',
        image: {
          data: 'aGVsbG8=',
          mimeType: 'image/png',
          uri: '/tmp/codex-image.png',
        },
      });
    });

    it('preserves completed-only inline image data when no saved path is available', async () => {
      const { client, onCodexImageGenerationEnd, onUpdateMessage } = createTestClient();

      await client.sessionUpdate({
        sessionId: 'acp-test',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'ig-inline-only',
          title: 'Image generation',
          kind: 'other',
          status: 'completed',
          content: [
            {
              type: 'content',
              content: { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
            },
          ],
        },
      } as SessionNotification);

      expect(onCodexImageGenerationEnd).toHaveBeenCalledWith({
        acpSessionId: 'acp-test',
        callId: 'ig-inline-only',
        status: 'completed',
        revisedPrompt: undefined,
        savedPath: undefined,
        image: { data: 'aGVsbG8=', mimeType: 'image/png' },
      });
      expect(onUpdateMessage).not.toHaveBeenCalled();
    });

    it('ignores image generation tool calls for non-Codex agents', async () => {
      const { client, onUpdateMessage, onCodexImageGenerationBegin, onCodexImageGenerationEnd } =
        createTestClient({
          agentType: 'claude',
        });

      await client.sessionUpdate({
        sessionId: 'acp-test',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'ig-1',
          title: 'Image generation',
          kind: 'other',
          status: 'in_progress',
        },
      } as SessionNotification);

      expect(onCodexImageGenerationBegin).not.toHaveBeenCalled();
      expect(onCodexImageGenerationEnd).not.toHaveBeenCalled();
      // Non-codex agents still see the tool call in their history pipeline.
      expect(onUpdateMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('session close', () => {
    it('uses closeSession when the agent advertises close support', async () => {
      const { client } = createTestClient({ cliType: 'builtin', agentType: 'claude' });
      const closeSessionSpy = vi.fn(async () => ({}));

      // @ts-expect-error - accessing private field for test setup
      client.connection = { closeSession: closeSessionSpy };
      // @ts-expect-error - accessing private field for test setup
      client.supportsClose = true;

      await expect(client.closeSession('acp-test' as ACPSessionId)).resolves.toBe(true);
      expect(closeSessionSpy).toHaveBeenCalledWith({ sessionId: 'acp-test' });
    });

    it('skips closeSession when the agent does not advertise close support', async () => {
      const { client } = createTestClient({ cliType: 'builtin', agentType: 'claude' });
      const closeSessionSpy = vi.fn(async () => ({}));

      // @ts-expect-error - accessing private field for test setup
      client.connection = { closeSession: closeSessionSpy };
      // @ts-expect-error - accessing private field for test setup
      client.supportsClose = false;

      await expect(client.closeSession('acp-test' as ACPSessionId)).resolves.toBe(false);
      expect(closeSessionSpy).not.toHaveBeenCalled();
    });
  });

  describe('config option routing', () => {
    it('routes model changes through setSessionConfigOption for builtin agents', async () => {
      const { client } = createTestClient({ cliType: 'builtin', agentType: 'codex' });
      const unstableSetSessionModelSpy = vi.fn(async () => ({}));
      const setSessionConfigOptionSpy = vi.fn(async () => ({
        configOptions: [],
      }));

      // @ts-expect-error - accessing private field for test setup
      client.connection = {
        unstable_setSessionModel: unstableSetSessionModelSpy,
        setSessionConfigOption: setSessionConfigOptionSpy,
      };
      // @ts-expect-error - accessing private field for test setup
      client.configOptions = [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'gpt-5.4',
          options: [],
        },
      ];

      await client.unstable_setSessionModel('acp-test' as ACPSessionId, 'gpt-5.4');

      expect(setSessionConfigOptionSpy).toHaveBeenCalledTimes(1);
      expect(setSessionConfigOptionSpy).toHaveBeenCalledWith({
        sessionId: 'acp-test',
        configId: 'model',
        value: 'gpt-5.4',
      });
      expect(unstableSetSessionModelSpy).not.toHaveBeenCalled();
    });

    it('codex agents use legacy setSessionMode for mode changes, not setSessionConfigOption', async () => {
      const { client } = createTestClient({ cliType: 'builtin', agentType: 'codex' });
      const setSessionModeSpy = vi.fn(async () => ({}));
      const setSessionConfigOptionSpy = vi.fn(async () => ({
        configOptions: [],
      }));

      // @ts-expect-error - accessing private field for test setup
      client.connection = {
        setSessionMode: setSessionModeSpy,
        setSessionConfigOption: setSessionConfigOptionSpy,
      };
      // @ts-expect-error - accessing private field for test setup
      client.configOptions = [
        {
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          type: 'select',
          currentValue: 'default',
          options: [],
        },
      ];

      await client.setSessionMode('acp-test' as ACPSessionId, 'default');

      // Should use legacy setSessionMode, NOT setSessionConfigOption
      expect(setSessionConfigOptionSpy).not.toHaveBeenCalled();
      expect(setSessionModeSpy).toHaveBeenCalledWith({
        sessionId: 'acp-test',
        modeId: 'default',
      });
    });

    it('non-codex agents use setSessionConfigOption for mode changes', async () => {
      const { client } = createTestClient({ cliType: 'builtin', agentType: 'claude' });
      const setSessionModeSpy = vi.fn(async () => ({}));
      const setSessionConfigOptionSpy = vi.fn(async () => ({
        configOptions: [],
      }));

      // @ts-expect-error - accessing private field for test setup
      client.connection = {
        setSessionMode: setSessionModeSpy,
        setSessionConfigOption: setSessionConfigOptionSpy,
      };
      // @ts-expect-error - accessing private field for test setup
      client.configOptions = [
        {
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          type: 'select',
          currentValue: 'default',
          options: [],
        },
      ];

      await client.setSessionMode('acp-test' as ACPSessionId, 'default');

      // Should use setSessionConfigOption
      expect(setSessionConfigOptionSpy).toHaveBeenCalledWith({
        sessionId: 'acp-test',
        configId: 'mode',
        value: 'default',
      });
      expect(setSessionModeSpy).not.toHaveBeenCalled();
    });

    it('uses config options for registry model changes', async () => {
      const { client } = createTestClient({ cliType: 'registry', agentType: 'opencode' });
      const unstableSetSessionModelSpy = vi.fn(async () => ({}));
      const setSessionConfigOptionSpy = vi.fn(async () => ({
        configOptions: [],
      }));

      // @ts-expect-error - accessing private field for test setup
      client.connection = {
        unstable_setSessionModel: unstableSetSessionModelSpy,
        setSessionConfigOption: setSessionConfigOptionSpy,
      };
      // @ts-expect-error - accessing private field for test setup
      client.configOptions = [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'kimi-k2',
          options: [],
        },
      ];

      await client.unstable_setSessionModel('acp-test' as ACPSessionId, 'kimi-k2');

      expect(setSessionConfigOptionSpy).toHaveBeenCalledWith({
        sessionId: 'acp-test',
        configId: 'model',
        value: 'kimi-k2',
      });
      expect(unstableSetSessionModelSpy).not.toHaveBeenCalled();
    });

    it('uses legacy session/set_model when the session advertises legacy models', async () => {
      const { client } = createTestClient({ cliType: 'registry', agentType: 'grok' });
      const requestSpy = vi.fn(async () => ({}));

      // @ts-expect-error - accessing private field for test setup
      client.connection = { request: requestSpy };
      // @ts-expect-error - accessing private field for test setup
      client.legacySessionModelState = {
        currentModelId: 'grok-4.5',
        availableModels: [
          { modelId: 'grok-4.5', name: 'Grok 4.5' },
          { modelId: 'grok-code-fast-1', name: 'Grok Code Fast 1' },
        ],
      };

      await client.unstable_setSessionModel('acp-test' as ACPSessionId, 'grok-code-fast-1');

      expect(requestSpy).toHaveBeenCalledWith('session/set_model', {
        sessionId: 'acp-test',
        modelId: 'grok-code-fast-1',
      });
      expect(client.currentModel).toEqual({
        modelId: 'grok-code-fast-1',
        name: 'Grok Code Fast 1',
      });
    });

    it('falls back to legacy session/set_model only for method-not-found', async () => {
      const { client } = createTestClient({ cliType: 'registry', agentType: 'hybrid' });
      const setSessionConfigOptionSpy = vi.fn(async () => {
        throw Object.assign(new Error('Method not found'), { code: -32601 });
      });
      const requestSpy = vi.fn(async () => ({}));

      // @ts-expect-error - accessing private field for test setup
      client.connection = {
        request: requestSpy,
        setSessionConfigOption: setSessionConfigOptionSpy,
      };
      // @ts-expect-error - accessing private field for test setup
      client.configOptions = [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'old',
          options: [{ value: 'new', name: 'New' }],
        },
      ];
      // @ts-expect-error - accessing private field for test setup
      client.legacySessionModelState = {
        currentModelId: 'old',
        availableModels: [{ modelId: 'new', name: 'New' }],
      };

      await client.unstable_setSessionModel('acp-test' as ACPSessionId, 'new');

      expect(setSessionConfigOptionSpy).toHaveBeenCalledTimes(1);
      expect(requestSpy).toHaveBeenCalledWith('session/set_model', {
        sessionId: 'acp-test',
        modelId: 'new',
      });
    });

    it('rejects model changes when the session advertises no switching surface', async () => {
      const { client } = createTestClient({ cliType: 'custom', agentType: 'modeless' });
      // @ts-expect-error - accessing private field for test setup
      client.connection = { request: vi.fn() };

      await expect(
        client.unstable_setSessionModel('acp-test' as ACPSessionId, 'unknown')
      ).rejects.toThrow('[ACP_MODEL_SWITCH_UNSUPPORTED]');
      expect(client.currentModel).toBeUndefined();
    });

    it('sends boolean config options with the ACP boolean request type', async () => {
      const { client } = createTestClient({ cliType: 'builtin', agentType: 'codex' });
      const setSessionConfigOptionSpy = vi.fn(async () => ({
        configOptions: [],
      }));

      // @ts-expect-error - accessing private field for test setup
      client.connection = {
        setSessionConfigOption: setSessionConfigOptionSpy,
      };

      await client.setSessionConfigOption('acp-test' as ACPSessionId, 'fast-mode', true);

      expect(setSessionConfigOptionSpy).toHaveBeenCalledWith({
        sessionId: 'acp-test',
        configId: 'fast-mode',
        type: 'boolean',
        value: true,
      });
    });
  });
});

describe('unstable_createElicitation (AskUserQuestion bridge)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Shaped like acp-extension-claude >= 0.44.0's AskUserQuestion form elicitation.
  const askUserQuestionForm = {
    mode: 'form',
    sessionId: 'acp-test',
    toolCallId: 'tc-elicit',
    message: 'Which database should we use?',
    requestedSchema: {
      type: 'object',
      properties: {
        question_0: {
          type: 'string',
          title: 'Database',
          oneOf: [
            { const: 'Postgres', title: 'Postgres — Use PostgreSQL' },
            { const: 'SQLite', title: 'SQLite' },
          ],
        },
        customAnswer: { type: 'string', title: 'Other', description: 'optional' },
      },
    },
  } as unknown as CreateElicitationRequest;

  it('bridges the form onto the permission flow and folds answers back', async () => {
    const { client, onRequestPermission } = createTestClient({ agentType: 'claude' });
    onRequestPermission.mockResolvedValueOnce({
      outcome: {
        outcome: 'selected',
        optionId: 'answer',
        _meta: {
          claudeCode: {
            askUserQuestion: { answers: { 'Which database should we use?': 'Postgres' } },
          },
        },
      },
    } as unknown as Awaited<ReturnType<typeof onRequestPermission>>);

    const result = await client.unstable_createElicitation(askUserQuestionForm);

    expect(onRequestPermission).toHaveBeenCalledTimes(1);
    const calls = onRequestPermission.mock.calls as unknown as Array<
      [string, RequestPermissionRequest]
    >;
    const request = calls[0]?.[1];
    expect(request?.toolCall.toolCallId).toBe('tc-elicit');
    expect(request?.options.map((option) => option.optionId)).toEqual(['answer', 'cancel']);
    const parsed = parseAskUserQuestionPermissionMeta(request?._meta);
    expect(parsed?.questions[0]?.question).toBe('Which database should we use?');
    expect(result).toEqual({ action: 'accept', content: { question_0: 'Postgres' } });
  });

  it('returns cancel when the user dismisses the question', async () => {
    const { client, onRequestPermission } = createTestClient({ agentType: 'claude' });
    onRequestPermission.mockResolvedValueOnce({
      outcome: { outcome: 'cancelled' },
    } as unknown as Awaited<ReturnType<typeof onRequestPermission>>);

    await expect(client.unstable_createElicitation(askUserQuestionForm)).resolves.toEqual({
      action: 'cancel',
    });
  });

  it('declines non-AskUserQuestion elicitations without prompting', async () => {
    const { client, onRequestPermission } = createTestClient({ agentType: 'claude' });

    const result = await client.unstable_createElicitation({
      mode: 'url',
      sessionId: 'acp-test',
      url: 'https://example.com',
      message: 'Open this',
      elicitationId: 'e1',
    } as unknown as CreateElicitationRequest);

    expect(result).toEqual({ action: 'decline' });
    expect(onRequestPermission).not.toHaveBeenCalled();
  });

  it('bridges Codex free-text and Other fields with automatic resolution metadata', async () => {
    const { client, onRequestPermission } = createTestClient();
    onRequestPermission.mockResolvedValueOnce({
      outcome: {
        outcome: 'selected',
        optionId: 'answer',
        _meta: {
          codex: {
            requestUserInput: { answers: { next_step: { answers: ['Custom path'] } } },
          },
        },
      },
    } as unknown as Awaited<ReturnType<typeof onRequestPermission>>);

    const result = await client.unstable_createElicitation({
      mode: 'form',
      sessionId: 'acp-test',
      toolCallId: 'codex-question',
      message: 'What next?',
      requestedSchema: {
        type: 'object',
        properties: {
          next_step: {
            type: 'string',
            title: 'Next step',
            description: 'What next?',
            oneOf: [{ const: 'Ship', title: 'Ship' }],
            _meta: { codex: { isOther: true, isSecret: false } },
          },
          next_step__other: {
            type: 'string',
            title: 'Other',
            _meta: {
              codex: { questionId: 'next_step', isOtherAnswer: true, isSecret: false },
            },
          },
        },
      },
      _meta: { codex: { autoResolutionMs: 60_000 } },
    } as unknown as CreateElicitationRequest);

    const request = (
      onRequestPermission.mock.calls as unknown as [string, RequestPermissionRequest][]
    ).at(0)?.[1];
    const parsed = parseAskUserQuestionPermissionMeta(request?._meta);
    expect(parsed?.source).toBe('codex');
    expect(parsed?.autoResolveAt).toEqual(expect.any(Number));
    expect(parsed?.questions[0]?.allowCustomAnswer).toBe(true);
    expect(result).toEqual({ action: 'accept', content: { next_step__other: 'Custom path' } });
  });
});

describe('AgentClient Codex goal session info', () => {
  it('shows a retry activity until Codex resumes streaming', async () => {
    const { client, onUpdateMessage } = createTestClient();

    await client.sessionUpdate({
      sessionId: 'acp-test',
      update: {
        sessionUpdate: 'session_info_update',
        _meta: {
          codex: {
            error: { message: 'connection lost', turnId: 'turn-1', willRetry: true },
          },
        },
      },
    });
    await client.sessionUpdate({
      sessionId: 'acp-test',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Recovered' },
      },
    });

    expect(onUpdateMessage.mock.calls.map(([notification]) => notification.update)).toEqual([
      expect.objectContaining({
        sessionUpdate: 'tool_call',
        toolCallId: 'codex-retry:turn-1',
        status: 'in_progress',
      }),
      expect.objectContaining({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'codex-retry:turn-1',
        status: 'completed',
      }),
      expect.objectContaining({ sessionUpdate: 'agent_message_chunk' }),
    ]);
  });

  it('normalizes Codex goal metadata into sparse goal message content', async () => {
    const { client, onThreadGoalUpdated, onUpdateMessage } = createTestClient();

    await client.sessionUpdate({
      sessionId: 'acp-test',
      update: {
        sessionUpdate: 'session_info_update',
        _meta: {
          codex: {
            goal: {
              objective: 'ship the release',
              status: 'budgetLimited',
              tokenBudget: 42_000,
            },
          },
        },
      },
    });

    expect(onThreadGoalUpdated).toHaveBeenCalledWith({
      type: 'goal',
      threadId: 'acp-test',
      objective: 'ship the release',
      status: 'budgetLimited',
      tokenBudget: 42_000,
    });
    expect(onUpdateMessage).toHaveBeenCalledTimes(1);
  });

  it('handles a null Codex goal as cleared', async () => {
    const { client, onThreadGoalCleared } = createTestClient();

    await client.sessionUpdate({
      sessionId: 'acp-test',
      update: {
        sessionUpdate: 'session_info_update',
        _meta: { codex: { goal: null } },
      },
    });

    expect(onThreadGoalCleared).toHaveBeenCalledWith('acp-test');
  });

  it('ignores invalid Codex goal metadata without breaking the session stream', async () => {
    const { client, onThreadGoalUpdated, onUpdateMessage } = createTestClient();

    await client.sessionUpdate({
      sessionId: 'acp-test',
      update: {
        sessionUpdate: 'session_info_update',
        _meta: { codex: { goal: { objective: 42, status: 'active' } } },
      },
    } as unknown as SessionNotification);

    expect(onThreadGoalUpdated).not.toHaveBeenCalled();
    expect(onUpdateMessage).toHaveBeenCalledTimes(1);
  });
});
