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

import { AgentClient, AgentSteerNotDeliveredError } from '../src/agent/agent-client';
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
  const onImageGenerationBegin = vi.fn();
  const onImageGenerationEnd = vi.fn();
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
    onImageGenerationBegin,
    onImageGenerationEnd,
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
    onImageGenerationBegin,
    onImageGenerationEnd,
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
        const [server] = client.buildBuiltinMcpServers('/tmp/lody-session');

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
        const [server] = client.buildBuiltinMcpServers('/tmp/lody-session');

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
        const [server] = client.buildBuiltinMcpServers('/tmp/lody-session');

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
        transport: 'prompt',
        promptMetaNamespace: 'claudeCode',
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

    /** Wire an acknowledged-steer-capable Codex client around one steer request. */
    const createSteerClient = (
      request: () => Promise<unknown>,
      completion: Promise<never> = new Promise(() => {})
    ) => {
      const { client } = createTestClient({ agentType: 'codex' });
      const requestSpy = vi.fn(request);
      // @ts-expect-error - focused protocol-boundary setup
      client.connection = { request: requestSpy };
      // @ts-expect-error - focused session-identity setup
      client.acpSessionId = 'acp-test' as ACPSessionId;
      // @ts-expect-error - focused capability-negotiation setup
      client.acknowledgedSteerCapability = {
        transport: 'request',
        requestMethod: '_session/steering',
        appliedNotificationMethod: 'codex/steerApplied',
        upstreamTurn: 'same',
        configPolicy: 'active',
      };
      // @ts-expect-error - the steer rides the turn's own prompt completion
      client.activePromptCompletion = {
        sessionId: 'acp-test' as ACPSessionId,
        promise: completion,
      };
      return { client, request: requestSpy };
    };

    it('reports an acknowledged steer the agent refused as not delivered', async () => {
      // Codex answers `No active Codex turn to steer` once the turn the guide
      // was aimed at has ended — inject-or-refuse, so nothing was taken.
      const { client, request } = createSteerClient(async () => {
        throw Object.assign(new Error('Invalid request: No active Codex turn to steer'), {
          code: -32600,
        });
      });

      const steerRun = client.steerPrompt('acp-test' as ACPSessionId, [
        { type: 'text', text: 'guide' },
      ]);

      await expect(steerRun.applied).rejects.toBeInstanceOf(AgentSteerNotDeliveredError);
      expect(request).toHaveBeenCalledWith(
        '_session/steering',
        expect.objectContaining({ sessionId: 'acp-test', steerId: expect.any(String) })
      );
    });

    it('maps the Core failed outcome to a conclusive not-delivered error', async () => {
      const { client } = createSteerClient(async () => ({ outcome: 'failed' }));

      const steerRun = client.steerPrompt('acp-test' as ACPSessionId, [
        { type: 'text', text: 'guide' },
      ]);

      await expect(steerRun.applied).rejects.toBeInstanceOf(AgentSteerNotDeliveredError);
    });

    it('keeps a steer whose request died in transport ambiguous', async () => {
      // The frame may already have reached the agent, so re-sending this user
      // turn could deliver the same message twice. Only the agent's own
      // `invalid request` answer proves it declined.
      const { client } = createSteerClient(async () => {
        throw new Error('ACP connection closed');
      });

      const steerRun = client.steerPrompt('acp-test' as ACPSessionId, [
        { type: 'text', text: 'guide' },
      ]);

      const error = await steerRun.applied.then(
        () => null,
        (reason: unknown) => reason
      );
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(AgentSteerNotDeliveredError);
    });

    it('lets the refusal win when the steered turn ends before the agent answers', async () => {
      // The Codex adapter drains session notifications before it refuses, so the
      // upstream turn's own response routinely lands first. Rejecting on that
      // response alone would downgrade a provable refusal to an ambiguous
      // failure and strand the user's message.
      let refuse!: (error: unknown) => void;
      let completeTurn!: () => void;
      const completion = new Promise<never>((resolve) => {
        completeTurn = () => resolve(undefined as never);
      });
      const { client } = createSteerClient(
        () =>
          new Promise((_, reject) => {
            refuse = reject;
          }),
        completion
      );

      const steerRun = client.steerPrompt('acp-test' as ACPSessionId, [
        { type: 'text', text: 'guide' },
      ]);
      completeTurn();
      await Promise.resolve();
      refuse(
        Object.assign(new Error('Invalid request: No active Codex turn to steer'), { code: -32600 })
      );

      await expect(steerRun.applied).rejects.toBeInstanceOf(AgentSteerNotDeliveredError);
    });

    it('lets a Core failed outcome win when the steered turn completes first', async () => {
      let answer!: (value: unknown) => void;
      let completeTurn!: () => void;
      const completion = new Promise<never>((resolve) => {
        completeTurn = () => resolve(undefined as never);
      });
      const { client } = createSteerClient(
        () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
        completion
      );

      const steerRun = client.steerPrompt('acp-test' as ACPSessionId, [
        { type: 'text', text: 'guide' },
      ]);
      completeTurn();
      await Promise.resolve();
      answer({ outcome: 'failed' });

      await expect(steerRun.applied).rejects.toBeInstanceOf(AgentSteerNotDeliveredError);
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

      expect(onRateLimitUpdate).toHaveBeenCalledWith({
        limitId: 'codex',
        limitName: null,
        planName: '"pro"',
        scope: { providerId: 'codex' },
        windows: [
          {
            usedPercent: 18,
            windowDurationSeconds: 604800,
            resetsAtEpochSeconds: 1777400602,
          },
        ],
      });
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

      expect(onRateLimitUpdate).toHaveBeenCalledWith({
        limitId: 'codex',
        planName: null,
        scope: { providerId: 'codex' },
        windows: [
          {
            usedPercent: 3,
            windowDurationSeconds: 18000,
            resetsAtEpochSeconds: 1777288209,
          },
          {
            usedPercent: 82,
            windowDurationSeconds: 604800,
            resetsAtEpochSeconds: 1777400602,
          },
        ],
      });
    });

    it('routes completed Codex proposed plan extension notifications through proposed plan updates', async () => {
      const { client, onUpdateMessage } = createTestClient();

      await client.extNotification?.('_acp_ext:codex_proposed_plan', {
        schemaVersion: 1,
        sessionId: 'acp-test',
        turnId: 'codex-turn-1',
        markdown: '- Inspect event routing',
        status: 'completed',
        isLatest: true,
      });

      expect(onUpdateMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'acp-test',
          update: expect.objectContaining({
            sessionUpdate: 'plan_update',
            plan: {
              type: 'markdown',
              planId: 'codex-turn-1',
              content: '- Inspect event routing',
            },
          }),
        })
      );
    });

    it('ignores non-standard Codex proposed plan extension method names', async () => {
      const { client, onUpdateMessage } = createTestClient();

      await client.extNotification?.('codex_proposed_plan', {
        schemaVersion: 1,
        sessionId: 'acp-test',
        turnId: 'codex-turn-1',
        markdown: '- Inspect event routing',
        status: 'completed',
        isLatest: true,
      });

      expect(onUpdateMessage).not.toHaveBeenCalled();
    });

    it('routes in-progress Codex proposed plan deltas through proposed plan updates', async () => {
      const { client, onUpdateMessage } = createTestClient();

      await client.extNotification?.('_acp_ext:codex_proposed_plan', {
        schemaVersion: 1,
        sessionId: 'acp-test',
        turnId: 'codex-turn-1',
        markdown: '- Inspect event routing',
        status: 'delta',
        isLatest: true,
      });

      expect(onUpdateMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: 'plan_update',
            plan: expect.objectContaining({ planId: 'codex-turn-1' }),
          }),
        })
      );
    });

    it('routes image generation tool calls to begin/end callbacks and suppresses them', async () => {
      const { client, onUpdateMessage, onImageGenerationBegin, onImageGenerationEnd } =
        createTestClient();

      await client.sessionUpdate({
        sessionId: 'acp-test',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'ig-1',
          title: 'Image generation',
          _meta: { lody: { toolName: 'ImageGeneration' } },
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

      expect(onImageGenerationBegin).toHaveBeenCalledWith({
        acpSessionId: 'acp-test',
        callId: 'ig-1',
      });
      expect(onImageGenerationEnd).toHaveBeenCalledWith({
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

    it('extracts image generation output fields from rawOutput fallback', async () => {
      const { client, onUpdateMessage, onImageGenerationEnd } = createTestClient();

      await client.sessionUpdate({
        sessionId: 'acp-test',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'ig-raw-output',
          title: 'Image generation',
          _meta: { lody: { toolName: 'ImageGeneration' } },
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

      expect(onImageGenerationEnd).toHaveBeenCalledWith({
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

    it('emits in-progress end events for streaming image generation updates', async () => {
      const { client, onImageGenerationEnd } = createTestClient();

      await client.sessionUpdate({
        sessionId: 'acp-test',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'ig-1',
          title: 'Image generation',
          _meta: { lody: { toolName: 'ImageGeneration' } },
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

      expect(onImageGenerationEnd).toHaveBeenCalledWith({
        acpSessionId: 'acp-test',
        callId: 'ig-1',
        status: 'in_progress',
        revisedPrompt: undefined,
        savedPath: undefined,
      });
    });

    it('handles a fresh terminal tool_call when the begin notification was lost on resume', async () => {
      const { client, onImageGenerationBegin, onImageGenerationEnd } = createTestClient();

      await client.sessionUpdate({
        sessionId: 'acp-test',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'ig-2',
          title: 'Image generation',
          _meta: { lody: { toolName: 'ImageGeneration' } },
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

      expect(onImageGenerationBegin).toHaveBeenCalledWith({
        acpSessionId: 'acp-test',
        callId: 'ig-2',
      });
      expect(onImageGenerationEnd).toHaveBeenCalledWith({
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
      const { client, onImageGenerationEnd, onUpdateMessage } = createTestClient();

      await client.sessionUpdate({
        sessionId: 'acp-test',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'ig-inline-only',
          title: 'Image generation',
          _meta: { lody: { toolName: 'ImageGeneration' } },
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

      expect(onImageGenerationEnd).toHaveBeenCalledWith({
        acpSessionId: 'acp-test',
        callId: 'ig-inline-only',
        status: 'completed',
        revisedPrompt: undefined,
        savedPath: undefined,
        image: { data: 'aGVsbG8=', mimeType: 'image/png' },
      });
      expect(onUpdateMessage).not.toHaveBeenCalled();
    });

    it('routes canonical image generation tool calls without provider branching', async () => {
      const { client, onUpdateMessage, onImageGenerationBegin, onImageGenerationEnd } =
        createTestClient({
          agentType: 'claude',
        });

      await client.sessionUpdate({
        sessionId: 'acp-test',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'ig-1',
          title: 'Image generation',
          _meta: { lody: { toolName: 'ImageGeneration' } },
          kind: 'other',
          status: 'in_progress',
        },
      } as SessionNotification);

      expect(onImageGenerationBegin).toHaveBeenCalledWith({
        acpSessionId: 'acp-test',
        callId: 'ig-1',
      });
      expect(onImageGenerationEnd).toHaveBeenCalledWith({
        acpSessionId: 'acp-test',
        callId: 'ig-1',
        status: 'in_progress',
        revisedPrompt: undefined,
        savedPath: undefined,
      });
      expect(onUpdateMessage).not.toHaveBeenCalled();
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
        question_0_custom: {
          type: 'string',
          title: 'Other',
          description: 'optional',
          _meta: {
            lody: { elicitation: { version: 1, customAnswerFor: 'question_0' } },
          },
        },
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
          lody: {
            elicitation: {
              version: 1,
              answers: { question_0: 'Postgres' },
            },
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
    expect(request?._meta).toMatchObject({
      lody: { elicitation: { version: 1 } },
      claudeCode: {
        requestType: 'askUserQuestion',
        askUserQuestion: {
          questions: [expect.objectContaining({ question: 'Which database should we use?' })],
        },
      },
    });
    expect(result).toEqual({ action: 'accept', content: { question_0: 'Postgres' } });
  });

  it('folds an older renderer Claude answer back into the Core form', async () => {
    const { client, onRequestPermission } = createTestClient({ agentType: 'claude' });
    onRequestPermission.mockResolvedValueOnce({
      outcome: {
        outcome: 'selected',
        optionId: 'answer',
        _meta: {
          claudeCode: {
            askUserQuestion: {
              answers: { 'Which database should we use?': 'Postgres' },
            },
          },
        },
      },
    } as unknown as Awaited<ReturnType<typeof onRequestPermission>>);

    await expect(client.unstable_createElicitation(askUserQuestionForm)).resolves.toEqual({
      action: 'accept',
      content: { question_0: 'Postgres' },
    });
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

  it('bridges Codex fields and folds an older renderer answer into the Core form', async () => {
    const { client, onRequestPermission } = createTestClient();
    onRequestPermission.mockResolvedValueOnce({
      outcome: {
        outcome: 'selected',
        optionId: 'answer',
        _meta: {
          codex: {
            requestUserInput: {
              answers: { next_step: { answers: ['Custom path'] } },
            },
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
            _meta: { lody: { elicitation: { version: 1, secret: false } } },
          },
          next_step__other: {
            type: 'string',
            title: 'Other',
            _meta: {
              lody: {
                elicitation: { version: 1, customAnswerFor: 'next_step', secret: false },
              },
            },
          },
        },
      },
      _meta: { lody: { elicitation: { version: 1, autoResolveAfterSeconds: 60 } } },
    } as unknown as CreateElicitationRequest);

    const request = (
      onRequestPermission.mock.calls as unknown as [string, RequestPermissionRequest][]
    ).at(0)?.[1];
    const parsed = parseAskUserQuestionPermissionMeta(request?._meta);
    expect(parsed?.source).toBe('lody');
    expect(parsed?.autoResolveAt).toEqual(expect.any(Number));
    expect(parsed?.questions[0]?.allowCustomAnswer).toBe(true);
    expect(request?._meta).toMatchObject({
      lody: { elicitation: { version: 1 } },
      codex: {
        requestUserInput: {
          questions: [expect.objectContaining({ id: 'next_step', question: 'What next?' })],
          autoResolveAt: expect.any(Number),
        },
      },
    });
    expect(result).toEqual({ action: 'accept', content: { next_step__other: 'Custom path' } });
  });
});

describe('AgentClient goal session info', () => {
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

  it('normalizes provider-neutral goal metadata for non-canonical agents', async () => {
    const { client, onThreadGoalUpdated, onUpdateMessage } = createTestClient({
      agentType: 'claude',
    });

    await client.sessionUpdate({
      sessionId: 'acp-test',
      update: {
        sessionUpdate: 'session_info_update',
        _meta: {
          goal: {
            objective: 'ship the release',
            status: 'limited',
            tokenBudget: 42_000,
            iterations: 7,
            lastReason: 'waiting for review',
            tokensUsed: 12_000,
            timeUsedSeconds: 90,
            createdAt: 100,
            updatedAt: 200,
            controlMethod: '_session/goal',
          },
        },
      },
    } as unknown as SessionNotification);

    expect(onThreadGoalUpdated).toHaveBeenCalledWith({
      type: 'goal',
      threadId: 'acp-test',
      objective: 'ship the release',
      status: 'blocked',
      tokenBudget: 42_000,
      tokensUsed: 12_000,
      timeUsedSeconds: 90,
      createdAt: 100,
      updatedAt: 200,
    });
    expect(onUpdateMessage).toHaveBeenCalledTimes(1);
  });

  it('prefers valid provider-neutral metadata over a legacy Codex duplicate', async () => {
    const { client, onThreadGoalUpdated } = createTestClient();

    await client.sessionUpdate({
      sessionId: 'acp-test',
      update: {
        sessionUpdate: 'session_info_update',
        _meta: {
          goal: {
            objective: 'neutral objective',
            status: 'active',
            controlMethod: '_session/goal',
          },
          codex: {
            goal: {
              objective: 'legacy objective',
              status: 'paused',
            },
          },
        },
      },
    } as unknown as SessionNotification);

    expect(onThreadGoalUpdated).toHaveBeenCalledWith({
      type: 'goal',
      threadId: 'acp-test',
      objective: 'neutral objective',
      status: 'active',
      tokenBudget: null,
    });
  });

  it('keeps parsing legacy Codex goal metadata', async () => {
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

  it('handles a null provider-neutral goal as cleared', async () => {
    const { client, onThreadGoalCleared } = createTestClient({ agentType: 'claude' });

    await client.sessionUpdate({
      sessionId: 'acp-test',
      update: {
        sessionUpdate: 'session_info_update',
        _meta: {
          goal: null,
          codex: {
            goal: {
              objective: 'legacy objective',
              status: 'active',
            },
          },
        },
      },
    } as unknown as SessionNotification);

    expect(onThreadGoalCleared).toHaveBeenCalledWith('acp-test');
  });

  it('ignores invalid provider-neutral goal metadata without breaking the session stream', async () => {
    const { client, onThreadGoalUpdated, onUpdateMessage } = createTestClient({
      agentType: 'claude',
    });

    await client.sessionUpdate({
      sessionId: 'acp-test',
      update: {
        sessionUpdate: 'session_info_update',
        _meta: {
          goal: {
            objective: 'neutral objective',
            status: 'active',
            controlMethod: '_wrong/goal',
          },
          codex: {
            goal: {
              objective: 'legacy objective',
              status: 'active',
            },
          },
        },
      },
    } as unknown as SessionNotification);

    expect(onThreadGoalUpdated).not.toHaveBeenCalled();
    expect(onUpdateMessage).toHaveBeenCalledTimes(1);
  });
});
