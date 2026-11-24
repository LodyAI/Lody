import { nativeSessionCredentials } from '@/session/session-credentials';
import { MessageHandler } from '../src/lib/message-handler';
import { lazyExecutionJournal, makeEncryptedAgentExecution } from '../src/lib/e2ee/agent-execution';
import {
  getSessionRoomId,
  type ACPSessionId,
  type AgentConfigMeta,
  type MachineId,
  type McpServerId,
  type SessionGoalMessage,
  type SessionHistoryInput,
  type SessionId,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';
import { Effect } from 'effect';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as piDiscovery from '../src/agent/pi-extensions';
import { SessionDocument, type LoroDocumentManager } from '../src/lib/loro/doc';
import { applyAcpSessionRunConfig } from '../src/session/acp-session-config-applier';
import { findNextDispatchableUserTurn } from '../src/session/session-dispatch-logic';
import { SessionExecutionService } from '../src/session/session-execution-service';
import type { SessionManager } from '../src/session/session-manager';
import { withHistoryPort } from './history-port-fixture';
import { composeTestSessionDoc } from './session-doc-fixture';
import {
  capabilityConfigId,
  createBaseDeps,
  createDeferred,
  createLaunchConfig,
  createSilentLogger,
  runProductionSignedTurn,
  runSilentPromptTurn,
} from './session-execution-service-helpers';

vi.hoisted(() => {
  Object.assign(globalThis, { __LODY_E2E_DAEMON_LOSS__: true });
  process.env.LODY_E2E = '1';
});
describe('SessionExecutionService', () => {
  it('rejects a result continuation without a durable Inbox batch before owning a turn', async () => {
    const service = new SessionExecutionService(createBaseDeps({}));
    const sessionId = 'unowned-inbox' as SessionId;
    await expect(
      service.continueSession(
        {
          type: 'session/chat',
          sessionId,
          machineId: 'machine-1',
          workspaceId: 'workspace-1' as WorkspaceId,
          userTurnId: 'no-batch',
          userId: 'user-1',
          userName: 'User',
          userEmail: 'user@example.com',
          acpSessionConfig: { cliType: 'builtin', agentType: 'codex', prompt: 'old continuation' },
        },
        { dispatchSource: 'inbox' }
      )
    ).rejects.toThrow('INBOX_BATCH_REQUIRED');
    expect(service.getExecutionSnapshot(sessionId).hasActiveTurn).toBe(false);
    expect(service.getActiveInvocationContext(sessionId)).toBeUndefined();
  });

  it('cancels an active descendant and prevents late turns while the tree is stopped', async () => {
    const sessionId = 'collaboration-child' as SessionId;
    const rootId = 'collaboration-root' as SessionId;
    let stopped = false;
    let history: SessionHistoryInput[] = [
      {
        id: 'collaboration-user',
        role: 'user',
        status: 'pending',
        items: [{ type: 'text', text: 'work' }],
      },
    ];
    let started!: () => void;
    let finish!: () => void;
    const promptStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const promptFinished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const prompts: string[] = [];
    const agentClient = {
      isCreated: () => true,
      currentModel: undefined,
      prompt: async () => {
        prompts.push('work');
        started();
        await promptFinished;
        return {};
      },
      cancel: async () => {
        finish();
      },
    };
    const activeSession = {
      sessionId,
      acpSessionId: 'acp-collaboration' as ACPSessionId,
      agentClient,
      getWorkdir: () => '/tmp',
      getGitHubCredentials: () => nativeSessionCredentials,
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: async () => '',
      terminate: async () => {},
      updateGitIdentity: () => {},
      applyExecutionPlaneLimits: async () => {},
      terminalManager: {},
    };
    const sessionDoc = withHistoryPort({
      getMetaState: async () => ({ id: sessionId, openedBySessionId: rootId }),
      setStatus: async () => {},
      setLastMessageAt: async () => {},
      getHistory: () => history,
      updateHistory: async (update: (value: SessionHistoryInput[]) => SessionHistoryInput[]) => {
        history = update(history);
      },
    });
    const deps = createBaseDeps({
      beginConversationTurn: (_id, userTurnId) => `assistant:${userTurnId}`,
      sessionManager: {
        getSession: () => activeSession,
        getPendingSession: () => null,
        createSession: async () => activeSession,
        setSessionError: () => {},
        terminateSession: async () => {},
        validateSessionCredentials: async () => {},
      } as unknown as SessionManager,
      workspaceDocument: {
        repo: {
          getDocMeta: async (roomId: string) => ({
            meta:
              roomId === getSessionRoomId(rootId)
                ? { id: rootId, collaborationStopped: stopped }
                : { id: sessionId, openedBySessionId: rootId },
          }),
          upsertDocMeta: async () => {},
        },
        getOrCreateSessionDoc: async () => sessionDoc,
        getOrOpenSessionCode: async () => null,
        updateAcpCapabilities: async () => {},
      } as unknown as LoroDocumentManager,
    });
    const service = new SessionExecutionService(deps);
    const message = {
      type: 'session/chat' as const,
      sessionId,
      machineId: 'machine-1' as MachineId,
      workspaceId: 'workspace-1' as WorkspaceId,
      acpSessionConfig: {
        prompt: 'work',
        cliType: 'builtin' as const,
        agentType: 'codex',
        chainDepth: 1,
      },
      userTurnId: 'collaboration-user',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    };
    const running = service.continueSession(message);
    await promptStarted;
    stopped = true;
    await service.reconcileCollaborationStops();
    await running;
    expect(service.getExecutionSnapshot(sessionId).hasActiveTurn).toBe(false);
    expect(history.find((turn) => turn.id === 'collaboration-user')?.status).toBe('canceled');
    history.push({
      id: 'late-user',
      role: 'user',
      status: 'pending',
      items: [{ type: 'text', text: 'late' }],
    });
    await service.continueSession({ ...message, userTurnId: 'late-user' });
    expect(history.find((turn) => turn.id === 'late-user')?.status).toBe('canceled');
    expect(prompts).toEqual(['work']);
  });

  it('scans the saved Pi profile and rejects missing or non-Pi providers', async () => {
    const deps = createBaseDeps({});
    let config: AgentConfigMeta | null = createLaunchConfig({
      cliType: 'builtin',
      agentType: 'pi',
      env: { PI_CODING_AGENT_DIR: '/saved/profile' },
    });
    deps.workspaceDocument.getAgentConfigForMachineLaunch = async () => config;
    const scan = vi
      .spyOn(piDiscovery, 'discoverManagedPiExtensions')
      .mockImplementation(async (env) => ({
        version: 1,
        agentDir: env?.PI_CODING_AGENT_DIR ?? '/default/profile',
        extensions: [],
        warnings: [],
      }));
    const service = new SessionExecutionService(deps);
    try {
      expect(await service.listMachinePiExtensions(capabilityConfigId)).toMatchObject({
        success: true,
        discovery: { agentDir: '/saved/profile' },
      });
      config = createLaunchConfig();
      expect(await service.listMachinePiExtensions(capabilityConfigId)).toMatchObject({
        success: false,
      });
      config = null;
      expect(await service.listMachinePiExtensions(capabilityConfigId)).toMatchObject({
        success: false,
      });
      expect(await service.listMachinePiExtensions()).toMatchObject({
        success: true,
        discovery: { agentDir: '/default/profile' },
      });
    } finally {
      scan.mockRestore();
    }
  });

  it('cancels only the named native child and rejects a stale parent turn', async () => {
    const runningChildren = new Set(['child-1', 'child-2']);
    const sessionManager = {
      getSession: () => ({
        agentClient: {
          isCreated: () => true,
          cancelSubagent: async (id: string) => {
            runningChildren.delete(id);
          },
        },
      }),
    } as unknown as SessionManager;
    const deps = createBaseDeps({ sessionManager, getActiveTurnId: () => 'parent-1' });
    // A child control must never enter the parent Stop/history mutation path.
    deps.workspaceDocument.getOrCreateSessionDoc = async () => {
      throw new Error('Parent Stop was invoked');
    };
    const service = new SessionExecutionService(deps);
    const request = {
      type: 'session/cancel' as const,
      sessionId: 'session-1' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      turnId: 'parent-1',
      subagentTaskId: 'child-1',
    };
    expect(await service.cancelSession({ ...request, turnId: 'old-parent' })).toMatchObject({
      success: false,
    });
    expect([...runningChildren]).toEqual(['child-1', 'child-2']);
    expect(await service.cancelSession(request)).toEqual({ success: true });
    expect([...runningChildren]).toEqual(['child-2']);
    expect(deps.getActiveTurnId(request.sessionId)).toBe('parent-1');
  });

  it('advances one session owner through consecutive prompt handoffs', async () => {
    const frozenInput = {
      prompt: 'ROLE_INSTRUCTION\n\nchange direction',
      inputBlocks: [{ type: 'text' as const, text: 'change direction' }],
    };
    const steerPrompt = vi.fn(() => ({
      completion: new Promise(() => {}),
      outcome: Promise.resolve({
        outcome: 'applied' as const,
        application: { steerId: 'steer-application', release: vi.fn() },
      }),
    }));
    const cancel = vi.fn(async () => {});
    const agentClient = {
      isCreated: vi.fn(() => true),
      getAcknowledgedSteerCapability: vi.fn(() => ({
        provider: 'claudeCode',
        appliedNotificationMethod: 'claude/steerApplied',
        upstreamTurn: 'handoff',
        configPolicy: 'apply',
      })),
      cancel,
      steerPrompt,
      currentModel: undefined,
    };
    const sessionDoc = withHistoryPort({
      updateHistory: vi.fn(async () => {}),
    });
    const upsertDocMeta = vi.fn(async () => {});
    const deps = createBaseDeps({
      workspaceDocument: {
        repo: { upsertDocMeta, getDocMeta: vi.fn(async () => undefined) },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
      } as unknown as LoroDocumentManager,
      buildAcpPromptBlocks: async ({ inputBlocks }) =>
        inputBlocks.filter((block) => block.type === 'text'),
      beginConversationTurn: vi.fn((_sessionId, userTurnId) => `assistant:${userTurnId}`),
    });
    const service = new SessionExecutionService(deps);
    const sessionId = 'session-steer' as SessionId;
    const activeSession = {
      agentClient,
      acpSessionId: 'acp-steer' as ACPSessionId,
    };
    type TestPromptRun = {
      turnId: string;
      promptOutcome: Promise<{ status: 'fulfilled' } | { status: 'rejected'; error: unknown }>;
      successor?: TestPromptRun;
      successorReady: Promise<void>;
      signalSuccessor: () => void;
    };
    const createPromptHandoffRun = (
      service as unknown as {
        createPromptHandoffRun: (options: {
          turnId: string;
          promptPromise: Promise<unknown>;
        }) => TestPromptRun;
      }
    ).createPromptHandoffRun.bind(service);
    const initialPromptRun = createPromptHandoffRun({
      turnId: 'assistant:user-1',
      promptPromise: new Promise(() => {}),
    });
    const runtime = {
      sessionId,
      turnId: 'assistant:user-1',
      userTurnId: 'user-1',
      session: activeSession,
      promptInFlight: true,
      invocation: {
        sourceTurnId: 'user-1',
        requesterUserId: 'user-1',
        inputConfig: { prompt: 'initial prompt' },
        notificationAudience: {
          kind: 'agent' as const,
          sessionId: 'original-sender' as SessionId,
          turnId: 'original-turn',
        },
      },
      activePromptRun: initialPromptRun,
      yieldedFinalization: Promise.resolve(),
    };
    (
      service as unknown as {
        turnRuntimeBySession: Map<SessionId, typeof runtime>;
      }
    ).turnRuntimeBySession.set(sessionId, runtime);

    expect(service.getActiveInvocationContext(sessionId)?.sender).toEqual({
      kind: 'agent',
      sessionId: 'original-sender',
    });

    await expect(
      service.steerSession({
        sessionId,
        expectedTurnId: 'assistant:user-1',
        userTurnId: 'user-2',
        userId: 'user-1',
        timestamp: '2026-07-11T00:00:00.000Z',
        inputConfig: frozenInput,
      })
    ).resolves.toMatchObject({ applied: true, disposition: 'applied' });

    expect(deps.turnFinalization.finalizeACPState).toHaveBeenCalledWith(
      sessionId,
      'assistant:user-1'
    );
    expect(deps.beginConversationTurn).toHaveBeenCalledWith(sessionId, 'user-2', {
      dispatchSource: 'rpc',
      sessionDoc,
    });
    expect(steerPrompt).toHaveBeenCalledWith('acp-steer', [
      { type: 'text', text: frozenInput.prompt },
    ]);
    expect(deps.applyAcpModeAndModel).toHaveBeenCalledOnce();
    expect(steerPrompt.mock.invocationCallOrder[0]).toBeLessThan(
      upsertDocMeta.mock.invocationCallOrder.at(-1) ?? Number.POSITIVE_INFINITY
    );
    expect(runtime.turnId).toBe('assistant:user-2');
    expect(runtime.userTurnId).toBe('user-2');
    expect(runtime.invocation).toEqual({
      requesterUserId: 'user-1',
      sourceTurnId: 'user-2',
      inputConfig: frozenInput,
    });
    expect(service.getActiveInvocationContext(sessionId)).toEqual({
      notificationOriginTurnIds: [],
      notificationProvenancePending: true,
      requesterUserId: 'user-1',
      sourceTurnId: 'user-2',
      inputConfig: frozenInput,
    });
    expect(initialPromptRun.successor?.turnId).toBe('assistant:user-2');
    expect(runtime.activePromptRun.turnId).toBe('assistant:user-2');

    await expect(
      service.steerSession({
        sessionId,
        expectedTurnId: 'assistant:user-1',
        userTurnId: 'stale-user-turn',
        userId: 'user-1',
        timestamp: '2026-07-11T00:00:00.000Z',
        inputConfig: { prompt: 'stale guide' },
      })
    ).resolves.toMatchObject({ applied: false, disposition: 'stale-turn' });
    expect(steerPrompt).toHaveBeenCalledTimes(1);

    await expect(
      service.steerSession({
        sessionId,
        expectedTurnId: 'assistant:user-2',
        userTurnId: 'user-3',
        userId: 'user-1',
        timestamp: '2026-07-11T00:00:00.000Z',
        inputConfig: { prompt: 'change direction again' },
      })
    ).resolves.toMatchObject({ applied: true, disposition: 'applied' });
    expect(steerPrompt).toHaveBeenCalledTimes(2);
    expect(deps.turnFinalization.finalizeACPState).toHaveBeenNthCalledWith(
      2,
      sessionId,
      'assistant:user-2'
    );
    expect(runtime.turnId).toBe('assistant:user-3');
    expect(runtime.userTurnId).toBe('user-3');
    expect(runtime.activePromptRun.turnId).toBe('assistant:user-3');
    expect(service.getExecutionSnapshot(sessionId)).toMatchObject({
      activeTurnId: 'assistant:user-3',
      hasActiveTurn: true,
    });
    expect(service.getActiveUserTurnId(sessionId)).toBe('user-3');
    expect(upsertDocMeta).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        lastHandledUserMsgId: 'user-2',
        processingUserMsgId: 'user-3',
      })
    );

    await expect(
      service.steerSession({
        sessionId,
        expectedTurnId: 'assistant:user-3',
        userTurnId: 'user-3',
        userId: 'user-1',
        timestamp: '2026-07-11T00:00:00.000Z',
        inputConfig: { prompt: 'change direction again' },
      })
    ).resolves.toMatchObject({ applied: true, disposition: 'applied' });
    expect(steerPrompt).toHaveBeenCalledTimes(2);

    await expect(
      service.cancelSession({
        type: 'session/cancel',
        sessionId,
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        turnId: 'assistant:user-2',
      })
    ).resolves.toEqual({ success: true });
    expect(cancel).not.toHaveBeenCalled();

    await expect(
      service.cancelSession({
        type: 'session/cancel',
        sessionId,
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        turnId: 'assistant:user-3',
      })
    ).resolves.toEqual({ success: true });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith('acp-steer'));
  });

  it('completes A to B to C when yielded prompts never settle', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const sessionId = 'session-steer-lifecycle' as SessionId;
      const first = createDeferred<unknown>();
      const second = createDeferred<unknown>();
      const third = createDeferred<unknown>();
      const fourth = createDeferred<unknown>();
      const promptResults = [first, second, third, fourth];
      const nextPrompt = () => {
        const next = promptResults.shift();
        if (!next) {
          throw new Error('Unexpected prompt');
        }
        return next.promise;
      };
      const prompt = vi.fn(nextPrompt);
      const applicationB = createDeferred<{ steerId: string; release: () => void }>();
      const applicationC = createDeferred<{ steerId: string; release: () => void }>();
      const applicationD = createDeferred<{ steerId: string; release: () => void }>();
      const applications = [applicationB, applicationC, applicationD];
      const steerPrompt = vi.fn(() => {
        const application = applications.shift();
        if (!application) {
          throw new Error('Unexpected steer application');
        }
        return {
          completion: nextPrompt(),
          outcome: application.promise.then((lease) => ({
            outcome: 'applied' as const,
            application: lease,
          })),
        };
      });
      const agentClient = {
        isCreated: vi.fn(() => true),
        getAcknowledgedSteerCapability: vi.fn(() => ({
          provider: 'claudeCode',
          appliedNotificationMethod: 'claude/steerApplied',
          upstreamTurn: 'handoff',
          configPolicy: 'apply',
        })),
        cancel: vi.fn(async () => {}),
        prompt,
        steerPrompt,
        currentModel: undefined,
      };
      const activeSession = {
        sessionId,
        acpSessionId: 'acp-steer-lifecycle' as ACPSessionId,
        agentClient,
        terminalManager: {} as unknown,
        getWorkdir: () => '/tmp',
        getGitHubCredentials: () => nativeSessionCredentials,
        getHostWorkdir: () => '/tmp',
        getParentSessionId: () => undefined,
        exec: vi.fn(async () => ''),
        terminate: vi.fn(async () => {}),
        updateGitIdentity: vi.fn(),
        createAgent: vi.fn(async () => 'acp-steer-lifecycle'),
        applyExecutionPlaneLimits: vi.fn(async () => {}),
      };
      let history: Array<Record<string, unknown>> = [
        { id: 'user-a', role: 'user', status: 'pending', read: false },
        { id: 'user-b', role: 'user', status: 'pending_apply', read: false },
        { id: 'user-c', role: 'user', status: 'pending_apply', read: false },
        { id: 'user-d', role: 'user', status: 'pending_apply', read: false },
      ];
      const sessionDoc = withHistoryPort({
        getMetaState: vi.fn(async () => ({ isArchived: false })),
        setStatus: vi.fn(async () => {}),
        setLastMessageAt: vi.fn(async () => {}),
        getHistory: vi.fn(() => history),
        updateHistory: vi.fn(async (updater: (prev: typeof history) => typeof history) => {
          history = updater(history);
        }),
        waitUntilSynced: vi.fn(async () => {}),
      });
      let meta: Record<string, unknown> = {};
      const upsertDocMeta = vi.fn(async (_roomId: string, patch: Record<string, unknown>) => {
        meta = { ...meta, ...patch };
      });
      const deps = createBaseDeps({
        sessionManager: {
          getSession: vi.fn(() => activeSession),
          getPendingSession: vi.fn(() => null),
          createSession: vi.fn(),
          setSessionError: vi.fn(),
          terminateSession: vi.fn(),
          validateSessionCredentials: vi.fn(async () => {}),
        } as unknown as SessionManager,
        workspaceDocument: {
          repo: {
            upsertDocMeta,
            getDocMeta: vi.fn(async () => ({ meta })),
          },
          getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
          getOrOpenSessionCode: vi.fn(async () => null),
          updateAcpCapabilities: vi.fn(async () => {}),
        } as unknown as LoroDocumentManager,
        beginConversationTurn: vi.fn((_sessionId: SessionId, userTurnId?: string) =>
          userTurnId ? `assistant:${userTurnId}` : 'assistant:unknown'
        ),
      });
      const service = new SessionExecutionService(deps);
      const lifecycle = service.continueSession(
        {
          type: 'session/chat',
          sessionId,
          machineId: 'machine-1',
          workspaceId: 'workspace-1' as WorkspaceId,
          project: undefined,
          acpSessionConfig: { prompt: 'A', cliType: 'builtin', agentType: 'claude' },
          userTurnId: 'user-a',
          userId: 'user-1',
          userName: 'User',
          userEmail: 'user@example.com',
        },
        {}
      );

      await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
      const steerB = service.steerSession({
        sessionId,
        expectedTurnId: 'assistant:user-a',
        userTurnId: 'user-b',
        userId: 'user-1',
        timestamp: '2026-07-12T00:00:00.000Z',
        inputConfig: { prompt: 'B' },
      });
      await vi.waitFor(() => expect(steerPrompt).toHaveBeenCalledTimes(1));
      expect(history).toContainEqual(
        expect.objectContaining({ id: 'user-b', status: 'pending_apply' })
      );
      expect(service.getExecutionSnapshot(sessionId).activeTurnId).toBe('assistant:user-a');
      expect(deps.turnFinalization.finalizeACPState).not.toHaveBeenCalled();
      expect(deps.activateConversationTurnForACPUpdates).toHaveBeenCalledTimes(1);
      const releaseB = vi.fn();
      applicationB.resolve({ steerId: 'steer-b', release: releaseB });
      await expect(steerB).resolves.toMatchObject({ applied: true, disposition: 'applied' });
      expect(releaseB).toHaveBeenCalledOnce();
      expect(deps.activateConversationTurnForACPUpdates).toHaveBeenCalledTimes(2);
      expect(
        vi.mocked(deps.activateConversationTurnForACPUpdates).mock.invocationCallOrder[1]
      ).toBeLessThan(releaseB.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY);

      const steerC = service.steerSession({
        sessionId,
        expectedTurnId: 'assistant:user-b',
        userTurnId: 'user-c',
        userId: 'user-1',
        timestamp: '2026-07-12T00:00:01.000Z',
        inputConfig: { prompt: 'C' },
      });
      await vi.waitFor(() => expect(steerPrompt).toHaveBeenCalledTimes(2));
      expect(history).toContainEqual(
        expect.objectContaining({ id: 'user-c', status: 'pending_apply' })
      );
      expect(service.getExecutionSnapshot(sessionId).activeTurnId).toBe('assistant:user-b');
      const releaseC = vi.fn();
      applicationC.resolve({ steerId: 'steer-c', release: releaseC });
      await expect(steerC).resolves.toMatchObject({ applied: true, disposition: 'applied' });
      expect(releaseC).toHaveBeenCalledOnce();

      const steerD = service.steerSession({
        sessionId,
        expectedTurnId: 'assistant:user-c',
        userTurnId: 'user-d',
        userId: 'user-1',
        timestamp: '2026-07-12T00:00:02.000Z',
        inputConfig: { prompt: 'D' },
      });
      await vi.waitFor(() => expect(steerPrompt).toHaveBeenCalledTimes(3));
      applicationD.reject(new Error('steer application failed'));
      await expect(steerD).resolves.toMatchObject({
        applied: false,
        disposition: 'delivery-unknown',
      });
      expect(history).toContainEqual(
        expect.objectContaining({ id: 'user-d', status: 'delivery_unknown' })
      );
      expect(service.getExecutionSnapshot(sessionId).activeTurnId).toBe('assistant:user-c');

      expect(service.getExecutionSnapshot(sessionId)).toMatchObject({
        activeTurnId: 'assistant:user-c',
        hasActiveTurn: true,
      });
      third.resolve({});
      await vi.runAllTimersAsync();
      await lifecycle;

      expect(prompt).toHaveBeenCalledTimes(1);
      expect(steerPrompt).toHaveBeenCalledTimes(3);
      expect(deps.turnFinalization.finalizeACPState).toHaveBeenNthCalledWith(
        1,
        sessionId,
        'assistant:user-a'
      );
      expect(deps.turnFinalization.finalizeACPState).toHaveBeenNthCalledWith(
        2,
        sessionId,
        'assistant:user-b'
      );
      expect(deps.turnFinalization.finalizeACPState).toHaveBeenNthCalledWith(
        3,
        sessionId,
        'assistant:user-c'
      );
      expect(deps.turnFinalization.flushSessionUsage).toHaveBeenCalledTimes(3);
      expect(history).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'user-a', status: 'handled' }),
          expect.objectContaining({ id: 'user-b', status: 'handled' }),
          expect.objectContaining({ id: 'user-c', status: 'handled' }),
        ])
      );
      expect(meta).toMatchObject({
        lastHandledUserMsgId: 'user-c',
        processingUserMsgId: undefined,
      });
      const drained = service.drainInboxExecutions();
      await vi.advanceTimersByTimeAsync(5_000);
      await drained;
      expect(deps.turnFinalization.onTurnOutcome).toHaveBeenCalledTimes(1);
      expect(deps.processMessageQueue).toHaveBeenCalledTimes(1);
      expect(service.getExecutionSnapshot(sessionId)).toMatchObject({ hasActiveTurn: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['applied', 'not-applied'] as const)(
    'waits for a handoff steer verdict that trails the yielded prompt (%s)',
    async (verdict) => {
      // Claude answers the yielded prompt first and confirms the steer only when
      // the SDK replays it; the steered prompt is the next turn, not drain work.
      const sessionId = 'session-steer-trailing-verdict' as SessionId;
      const yielded = createDeferred<unknown>();
      const steered = createDeferred<unknown>();
      const unsettled = new Set<Promise<unknown>>();
      const track = (promise: Promise<unknown>) => {
        unsettled.add(promise);
        const release = () => unsettled.delete(promise);
        void promise.then(release, release);
        return promise;
      };
      const outcome = createDeferred<
        | { outcome: 'applied'; application: { release: () => void } }
        | { outcome: 'not-applied'; error: unknown }
      >();
      const prompt = vi.fn(() => track(yielded.promise));
      const steerPrompt = vi.fn(() => ({
        completion: track(steered.promise),
        outcome: outcome.promise,
      }));
      const agentClient = {
        isCreated: vi.fn(() => true),
        getAcknowledgedSteerCapability: vi.fn(() => ({
          provider: 'claudeCode',
          appliedNotificationMethod: 'claude/steerApplied',
          upstreamTurn: 'handoff',
          configPolicy: 'apply',
        })),
        get pendingPromptCompletion(): Promise<void> | null {
          return unsettled.size > 0
            ? Promise.allSettled([...unsettled]).then(() => undefined)
            : null;
        },
        cancel: vi.fn(async () => {}),
        prompt,
        steerPrompt,
        currentModel: undefined,
      };
      const terminate = vi.fn(async () => {});
      const activeSession = {
        sessionId,
        acpSessionId: 'acp-steer-trailing-verdict' as ACPSessionId,
        agentClient,
        terminalManager: {} as unknown,
        getWorkdir: () => '/tmp',
        getGitHubCredentials: () => nativeSessionCredentials,
        getHostWorkdir: () => '/tmp',
        getParentSessionId: () => undefined,
        exec: vi.fn(async () => ''),
        terminate,
        updateGitIdentity: vi.fn(),
        createAgent: vi.fn(async () => 'acp-steer-trailing-verdict'),
        applyExecutionPlaneLimits: vi.fn(async () => {}),
      };
      let history: Array<Record<string, unknown>> = [
        { id: 'user-a', role: 'user', status: 'pending', read: false },
        { id: 'user-b', role: 'user', status: 'pending_apply', read: false },
      ];
      const sessionDoc = withHistoryPort({
        getMetaState: vi.fn(async () => ({ isArchived: false })),
        setStatus: vi.fn(async () => {}),
        setLastMessageAt: vi.fn(async () => {}),
        getHistory: vi.fn(() => history),
        updateHistory: vi.fn(async (updater: (prev: typeof history) => typeof history) => {
          history = updater(history);
        }),
        waitUntilSynced: vi.fn(async () => {}),
      });
      let meta: Record<string, unknown> = {};
      const deps = createBaseDeps({
        sessionManager: {
          getSession: vi.fn(() => activeSession),
          getPendingSession: vi.fn(() => null),
          createSession: vi.fn(),
          setSessionError: vi.fn(),
          terminateSession: vi.fn(),
          validateSessionCredentials: vi.fn(async () => {}),
        } as unknown as SessionManager,
        workspaceDocument: {
          repo: {
            upsertDocMeta: vi.fn(async (_roomId: string, patch: Record<string, unknown>) => {
              meta = { ...meta, ...patch };
            }),
            getDocMeta: vi.fn(async () => ({ meta })),
          },
          getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
          getOrOpenSessionCode: vi.fn(async () => null),
          updateAcpCapabilities: vi.fn(async () => {}),
        } as unknown as LoroDocumentManager,
        beginConversationTurn: vi.fn((_sessionId: SessionId, userTurnId?: string) =>
          userTurnId ? `assistant:${userTurnId}` : 'assistant:unknown'
        ),
      });
      const service = new SessionExecutionService(deps);
      const lifecycle = service.continueSession(
        {
          type: 'session/chat',
          sessionId,
          machineId: 'machine-1',
          workspaceId: 'workspace-1' as WorkspaceId,
          project: undefined,
          acpSessionConfig: { prompt: 'A', cliType: 'builtin', agentType: 'claude' },
          userTurnId: 'user-a',
          userId: 'user-1',
          userName: 'User',
          userEmail: 'user@example.com',
        },
        {}
      );

      await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
      const steerB = service.steerSession({
        sessionId,
        expectedTurnId: 'assistant:user-a',
        userTurnId: 'user-b',
        userId: 'user-1',
        timestamp: '2026-09-19T00:00:00.000Z',
        inputConfig: { prompt: 'B' },
      });
      await vi.waitFor(() => expect(steerPrompt).toHaveBeenCalledTimes(1));

      // The yielded prompt answers before the adapter reports the verdict.
      yielded.resolve({ stopReason: 'end_turn' });
      await new Promise((resolve) => setImmediate(resolve));
      expect(service.getExecutionSnapshot(sessionId)).toMatchObject({
        activeTurnId: 'assistant:user-a',
        hasActiveTurn: true,
      });

      if (verdict === 'applied') {
        const release = vi.fn();
        outcome.resolve({ outcome: 'applied', application: { release } });
        await expect(steerB).resolves.toMatchObject({ applied: true, disposition: 'applied' });
        expect(release).toHaveBeenCalledOnce();
        await vi.waitFor(() =>
          expect(service.getExecutionSnapshot(sessionId)).toMatchObject({
            activeTurnId: 'assistant:user-b',
            hasActiveTurn: true,
          })
        );
        expect(deps.processMessageQueue).not.toHaveBeenCalled();

        steered.resolve({ stopReason: 'end_turn' });
        await lifecycle;
        expect(deps.turnFinalization.finalizeACPState).toHaveBeenNthCalledWith(
          2,
          sessionId,
          'assistant:user-b'
        );
        expect(history).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: 'user-a', status: 'handled' }),
            expect.objectContaining({ id: 'user-b', status: 'handled' }),
          ])
        );
        expect(meta).toMatchObject({ lastHandledUserMsgId: 'user-b' });
      } else {
        // A prompt-transport refusal is only proven once its own prompt settles.
        steered.resolve({ stopReason: 'end_turn' });
        outcome.resolve({ outcome: 'not-applied', error: new Error('steer refused') });
        await expect(steerB).resolves.toMatchObject({
          applied: false,
          disposition: 'no-active-turn',
        });
        await lifecycle;
        expect(meta).toMatchObject({
          lastHandledUserMsgId: 'user-a',
          steerTurnStatuses: { 'user-b': 'pending' },
        });
        expect(deps.turnFinalization.finalizeACPState).toHaveBeenCalledTimes(1);
      }

      expect(terminate).not.toHaveBeenCalled();
      expect(deps.processMessageQueue).toHaveBeenCalledTimes(1);
      expect(service.getExecutionSnapshot(sessionId)).toMatchObject({ hasActiveTurn: false });
    }
  );

  it('rejects steer without mutating the active turn when the agent lacks support', async () => {
    const deps = createBaseDeps({});
    vi.mocked(deps.workspaceDocument.getOrCreateSessionDoc).mockResolvedValue(
      withHistoryPort({ updateHistory: vi.fn(async () => {}) }) as never
    );
    const service = new SessionExecutionService(deps);
    const sessionId = 'session-no-steer' as SessionId;
    const runtime = {
      sessionId,
      turnId: 'assistant:user-1',
      session: {
        agentClient: { getAcknowledgedSteerCapability: vi.fn(() => null) },
        acpSessionId: 'acp-no-steer' as ACPSessionId,
      },
      promptInFlight: true,
    };
    (
      service as unknown as {
        turnRuntimeBySession: Map<SessionId, typeof runtime>;
      }
    ).turnRuntimeBySession.set(sessionId, runtime);

    await expect(
      service.steerSession({
        sessionId,
        expectedTurnId: 'assistant:user-1',
        userTurnId: 'user-2',
        userId: 'user-1',
        timestamp: '2026-07-11T00:00:00.000Z',
        inputConfig: { prompt: 'change direction' },
      })
    ).resolves.toMatchObject({ applied: false, disposition: 'unsupported' });
    expect(deps.turnFinalization.finalizeACPState).not.toHaveBeenCalled();
    expect(deps.beginConversationTurn).not.toHaveBeenCalled();
  });

  it('reports no active turn when the target prompt ends before steer submission', async () => {
    const promptBlocks = createDeferred<Array<{ type: 'text'; text: string }>>();
    const steerPrompt = vi.fn();
    const sessionId = 'session-steer-ended-before-submit' as SessionId;
    const deps = createBaseDeps({
      workspaceDocument: {
        repo: { upsertDocMeta: vi.fn(async () => {}), getDocMeta: vi.fn(async () => undefined) },
        getOrCreateSessionDoc: vi.fn(async () =>
          withHistoryPort({ updateHistory: vi.fn(async () => {}) })
        ),
      } as unknown as LoroDocumentManager,
      buildAcpPromptBlocks: vi.fn(() => promptBlocks.promise),
    });
    const service = new SessionExecutionService(deps);
    const runtime = {
      sessionId,
      turnId: 'assistant:user-1',
      session: {
        agentClient: {
          getAcknowledgedSteerCapability: vi.fn(() => ({
            provider: 'claudeCode',
            appliedNotificationMethod: 'claude/steerApplied',
            upstreamTurn: 'handoff',
            configPolicy: 'apply',
          })),
          steerPrompt,
        },
        acpSessionId: 'acp-steer-ended-before-submit' as ACPSessionId,
      },
      promptInFlight: true,
    };
    (
      service as unknown as {
        turnRuntimeBySession: Map<SessionId, typeof runtime>;
      }
    ).turnRuntimeBySession.set(sessionId, runtime);

    const steer = service.steerSession({
      sessionId,
      expectedTurnId: 'assistant:user-1',
      userTurnId: 'user-2',
      userId: 'user-1',
      timestamp: '2026-07-17T00:00:00.000Z',
      inputConfig: { prompt: 'continue as a new turn' },
    });
    await vi.waitFor(() => expect(deps.buildAcpPromptBlocks).toHaveBeenCalledOnce());
    runtime.promptInFlight = false;
    promptBlocks.resolve([{ type: 'text', text: 'continue as a new turn' }]);

    await expect(steer).resolves.toMatchObject({
      applied: false,
      disposition: 'no-active-turn',
    });
    expect(deps.applyAcpModeAndModel).not.toHaveBeenCalled();
    expect(steerPrompt).not.toHaveBeenCalled();
  });

  it.each([
    { selection: 'model', configPolicy: 'active' },
    { selection: 'MCP', configPolicy: 'active' },
    { selection: 'MCP', configPolicy: 'apply' },
  ] as const)(
    'promotes steer with changed $selection under $configPolicy policy',
    async ({ selection, configPolicy }) => {
      const upsertDocMeta = vi.fn(async () => {});
      const deps = createBaseDeps({
        workspaceDocument: {
          repo: { upsertDocMeta, getDocMeta: vi.fn(async () => undefined) },
          getOrCreateSessionDoc: vi.fn(async () =>
            withHistoryPort({ updateHistory: vi.fn(async () => {}) })
          ),
        } as unknown as LoroDocumentManager,
      });
      const service = new SessionExecutionService(deps);
      const sessionId = 'session-codex-steer-config' as SessionId;
      const findSteerConfigMismatch = vi.fn(() =>
        selection === 'model' ? 'model requested gpt-next, active gpt-current' : null
      );
      const runtime = {
        sessionId,
        turnId: 'assistant:user-1',
        session: {
          agentClient: {
            getAcknowledgedSteerCapability: vi.fn(() => ({
              provider: 'codex',
              appliedNotificationMethod: 'codex/steerApplied',
              upstreamTurn: 'same',
              configPolicy,
            })),
            findSteerConfigMismatch,
          },
          acpSessionId: 'acp-codex-steer-config' as ACPSessionId,
        },
        promptInFlight: true,
      };
      (
        service as unknown as {
          turnRuntimeBySession: Map<SessionId, typeof runtime>;
        }
      ).turnRuntimeBySession.set(sessionId, runtime);

      await expect(
        service.steerSession({
          sessionId,
          expectedTurnId: 'assistant:user-1',
          userTurnId: 'user-2',
          userId: 'user-1',
          timestamp: '2026-07-11T00:00:00.000Z',
          inputConfig: {
            prompt: 'change direction',
            ...(selection === 'model'
              ? { modelId: 'gpt-next' }
              : { mcpServerIds: ['server-a' as McpServerId] }),
          },
        })
      ).resolves.toMatchObject({
        applied: false,
        disposition: 'unsupported',
        error: expect.stringContaining(
          selection === 'model'
            ? 'Active turn configuration differs'
            : 'MCP selection requires a new turn'
        ),
      });
      if (selection === 'model') expect(findSteerConfigMismatch).toHaveBeenCalledOnce();
      expect(deps.applyAcpModeAndModel).not.toHaveBeenCalled();
      expect(deps.beginConversationTurn).not.toHaveBeenCalled();

      findSteerConfigMismatch.mockReturnValue(null);
      await expect(
        service.steerSession({
          sessionId,
          expectedTurnId: 'assistant:user-1',
          userTurnId: 'user-3',
          userId: 'user-1',
          timestamp: '2026-07-11T00:00:01.000Z',
          inputConfig: { prompt: 'same configuration' },
        })
      ).resolves.toMatchObject({ applied: false, disposition: 'busy' });
      // Neither guide reached Codex, so both are handed back to dispatch instead
      // of being stranded in `pending_apply`.
      const promoted = Object.assign(
        {},
        ...upsertDocMeta.mock.calls.map(
          (call) => (call[1] as Partial<SessionMeta>).steerTurnStatuses
        )
      );
      expect(promoted).toEqual({ 'user-2': 'pending', 'user-3': 'pending' });
    }
  );

  it.each(['before', 'during-build'] as const)(
    'promotes a user-Stop steer before provider submission (Stop: %s)',
    async (cancelStage) => {
      let history: SessionHistoryInput[] = [
        { id: 'user-1', role: 'user', status: 'handled', read: true } as SessionHistoryInput,
        {
          id: 'user-2',
          role: 'user',
          status: 'pending_apply',
          read: false,
          inputConfig: { prompt: 'do it differently' },
        } as SessionHistoryInput,
      ];
      const sessionDoc = withHistoryPort({
        updateHistory: vi.fn(
          async (update: (entries: SessionHistoryInput[]) => SessionHistoryInput[]) => {
            history = update(history);
          }
        ),
      });
      const upsertDocMeta = vi.fn(async () => {});
      const deps = createBaseDeps({
        workspaceDocument: {
          repo: { upsertDocMeta, getDocMeta: vi.fn(async () => undefined) },
          getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        } as unknown as LoroDocumentManager,
      });
      const service = new SessionExecutionService(deps);
      const sessionId = 'session-steer-refused-before-provider' as SessionId;
      const steerPrompt = vi.fn(() => ({
        completion: new Promise(() => {}),
        outcome: Promise.resolve({
          outcome: 'not-applied' as const,
          error: new Error('Codex adapter reported not-applied'),
        }),
      }));
      const runtime = {
        sessionId,
        turnId: 'assistant:user-1',
        userTurnId: 'user-1',
        session: {
          agentClient: {
            getAcknowledgedSteerCapability: vi.fn(() => ({
              provider: 'codex',
              appliedNotificationMethod: 'codex/steerApplied',
              upstreamTurn: 'same',
              configPolicy: 'active',
            })),
            findSteerConfigMismatch: vi.fn(() => null),
            steerPrompt,
          },
          acpSessionId: 'acp-steer-refused' as ACPSessionId,
        },
        promptInFlight: true,
        activePromptRun: { turnId: 'assistant:user-1' },
        cancelRequested: cancelStage === 'before',
        pendingInputOnCancel: 'promote' as const,
      };
      vi.mocked(deps.buildAcpPromptBlocks).mockImplementation(async () => {
        if (cancelStage === 'during-build') runtime.cancelRequested = true;
        return [{ type: 'text', text: 'do it differently' }];
      });
      (
        service as unknown as {
          turnRuntimeBySession: Map<SessionId, typeof runtime>;
        }
      ).turnRuntimeBySession.set(sessionId, runtime);

      await expect(
        service.steerSession({
          sessionId,
          expectedTurnId: 'assistant:user-1',
          userTurnId: 'user-2',
          userId: 'user-1',
          timestamp: '2026-07-19T00:00:00.000Z',
          inputConfig: { prompt: 'do it differently' },
        })
      ).resolves.toMatchObject({ applied: false, disposition: 'no-active-turn' });

      expect(steerPrompt).not.toHaveBeenCalled();
      expect(history.find((entry) => entry.id === 'user-2')).toMatchObject({
        status: cancelStage === 'before' ? 'pending_apply' : 'pending',
        read: false,
      });
      expect(history.find((entry) => entry.id === 'user-1')).toMatchObject({ status: 'handled' });
      expect(upsertDocMeta).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ steerTurnStatuses: { 'user-2': 'pending' } })
      );
      expect(deps.turnFinalization.finalizeACPState).not.toHaveBeenCalled();
      expect(deps.beginConversationTurn).not.toHaveBeenCalled();
    }
  );

  it('does not submit a steer when Stop wins during the submitted marker write', async () => {
    let history: SessionHistoryInput[] = [
      { id: 'user-1', role: 'user', status: 'handled', read: true } as SessionHistoryInput,
      {
        id: 'user-2',
        role: 'user',
        status: 'pending_apply',
        read: false,
        inputConfig: { prompt: 'do it differently' },
      } as SessionHistoryInput,
    ];
    const submittedWriteStarted = createDeferred<void>();
    const releaseSubmittedWrite = createDeferred<void>();
    let lastOperation: unknown;
    const setSteerOperationRecord = vi.fn(async (_operationId: string, record: unknown) => {
      if (
        record &&
        typeof record === 'object' &&
        'phase' in record &&
        record.phase === 'submitted'
      ) {
        submittedWriteStarted.resolve();
        await releaseSubmittedWrite.promise;
      }
      lastOperation = record;
    });
    const sessionDoc = withHistoryPort({
      setSteerOperationRecord,
      updateHistory: vi.fn(
        async (update: (entries: SessionHistoryInput[]) => SessionHistoryInput[]) => {
          history = update(history);
        }
      ),
    });
    const upsertDocMeta = vi.fn(async () => {});
    const steerPrompt = vi.fn(() => ({
      completion: new Promise(() => {}),
      outcome: Promise.resolve({
        outcome: 'applied' as const,
        application: { steerId: 'steer-after-stop', release: vi.fn() },
      }),
    }));
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      pendingPromptCompletion: null,
      getAcknowledgedSteerCapability: vi.fn(() => ({
        provider: 'codex',
        appliedNotificationMethod: 'codex/steerApplied',
        upstreamTurn: 'same',
        configPolicy: 'active',
      })),
      findSteerConfigMismatch: vi.fn(() => null),
      steerPrompt,
    };
    const deps = createBaseDeps({
      workspaceDocument: {
        repo: { upsertDocMeta, getDocMeta: vi.fn(async () => undefined) },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
      } as unknown as LoroDocumentManager,
    });
    const service = new SessionExecutionService(deps);
    const sessionId = 'session-steer-stop-during-marker' as SessionId;
    const runtime = {
      sessionId,
      turnId: 'assistant:user-1',
      userTurnId: 'user-1',
      session: { agentClient, acpSessionId: 'acp-steer-stop' as ACPSessionId },
      promptInFlight: true,
      activePromptRun: { turnId: 'assistant:user-1' },
      cancelRequested: false,
      pendingInputOnCancel: 'preserve' as const,
    };
    (
      service as unknown as {
        turnRuntimeBySession: Map<SessionId, typeof runtime>;
      }
    ).turnRuntimeBySession.set(sessionId, runtime);

    const steering = service.steerSession({
      sessionId,
      expectedTurnId: 'assistant:user-1',
      userTurnId: 'user-2',
      userId: 'user-1',
      timestamp: '2026-09-14T00:00:00.000Z',
      inputConfig: { prompt: 'do it differently' },
    });
    await submittedWriteStarted.promise;

    await expect(
      service.cancelSession(
        {
          type: 'session/cancel',
          sessionId,
          machineId: 'machine-1',
          workspaceId: 'workspace-1' as WorkspaceId,
          turnId: 'assistant:user-1',
        },
        { pendingInput: 'preserve' }
      )
    ).resolves.toEqual({ success: true });
    releaseSubmittedWrite.resolve();

    await expect(steering).resolves.toMatchObject({
      applied: false,
      disposition: 'stale-turn',
    });
    expect(steerPrompt).not.toHaveBeenCalled();
    expect(history.find((entry) => entry.id === 'user-2')).toMatchObject({
      status: 'pending_apply',
      read: false,
    });
    expect(lastOperation).toMatchObject({
      phase: 'settled',
      delivery: 'not_applied',
      status: 'pending',
      cancellationPolicy: 'preserve',
    });
  });

  it.each([false, true])(
    'recovers a not-applied steer after ESC (meta write failure: %s)',
    async (failMetaWrite) => {
      let history: SessionHistoryInput[] = [
        { id: 'user-1', role: 'user', status: 'handled', read: true } as SessionHistoryInput,
        {
          id: 'user-2',
          role: 'user',
          status: 'pending_apply',
          read: false,
          inputConfig: { prompt: 'do it differently' },
        } as SessionHistoryInput,
      ];
      const sessionDoc = withHistoryPort({
        getMetaState: vi.fn(async () => ({ isArchived: false })),
        setStatus: vi.fn(async () => {}),
        getHistory: vi.fn(() => history),
        updateHistory: vi.fn(
          async (update: (entries: SessionHistoryInput[]) => SessionHistoryInput[]) => {
            history = update(history);
          }
        ),
      });
      let meta: Record<string, unknown> = { latestUserMsgId: 'user-1' };
      let failurePending = failMetaWrite;
      const upsertDocMeta = vi.fn(async (_roomId: string, patch: Record<string, unknown>) => {
        if (
          (patch.steerTurnStatuses as Record<string, string> | undefined)?.['user-2'] ===
            'pending' &&
          failurePending
        ) {
          failurePending = false;
          throw new Error('Injected activation write failure');
        }
        meta = { ...meta, ...patch };
      });
      const outcome = createDeferred<{ outcome: 'not-applied'; error: Error }>();
      const steerSubmitted = createDeferred();
      const steerPrompt = vi.fn(() => {
        steerSubmitted.resolve();
        return {
          completion: new Promise(() => {}),
          outcome: outcome.promise,
        };
      });
      const agentClient = {
        isCreated: vi.fn(() => true),
        cancel: vi.fn(async () => {}),
        prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
        pendingPromptCompletion: null,
        currentModel: undefined,
        getAcknowledgedSteerCapability: vi.fn(() => ({
          provider: 'codex',
          appliedNotificationMethod: 'codex/steerApplied',
          upstreamTurn: 'same',
          configPolicy: 'active',
        })),
        findSteerConfigMismatch: vi.fn(() => null),
        steerPrompt,
      };
      const session = {
        sessionId: 'session-steer-refused' as SessionId,
        acpSessionId: 'acp-steer-refused' as ACPSessionId,
        agentClient,
        terminalManager: {} as unknown,
        getWorkdir: () => '/tmp',
        getGitHubCredentials: () => nativeSessionCredentials,
        getHostWorkdir: () => '/tmp',
        getParentSessionId: () => undefined,
        exec: vi.fn(async () => ''),
        terminate: vi.fn(async () => {}),
        updateGitIdentity: vi.fn(),
        createAgent: vi.fn(async () => 'acp-steer-refused'),
        applyExecutionPlaneLimits: vi.fn(async () => {}),
      };
      const deps = createBaseDeps({
        sessionManager: {
          getSession: vi.fn(() => session),
          getPendingSession: vi.fn(() => null),
          createSession: vi.fn(),
          setSessionError: vi.fn(),
          terminateSession: vi.fn(),
          validateSessionCredentials: vi.fn(async () => {}),
        } as unknown as SessionManager,
        workspaceDocument: {
          repo: { upsertDocMeta, getDocMeta: vi.fn(async () => ({ meta })) },
          getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        } as unknown as LoroDocumentManager,
      });
      const service = new SessionExecutionService(deps);
      const sessionId = 'session-steer-refused' as SessionId;
      const runtime = {
        sessionId,
        turnId: 'assistant:user-1',
        userTurnId: 'user-1',
        session: { agentClient, acpSessionId: 'acp-steer-refused' as ACPSessionId },
        promptInFlight: true,
        activePromptRun: { turnId: 'assistant:user-1' },
        cancelRequested: false,
        pendingInputOnCancel: 'preserve' as const,
      };
      (
        service as unknown as {
          turnRuntimeBySession: Map<SessionId, typeof runtime>;
        }
      ).turnRuntimeBySession.set(sessionId, runtime);

      const steerRequest = {
        sessionId,
        expectedTurnId: 'assistant:user-1',
        userTurnId: 'user-2',
        userId: 'user-1',
        timestamp: '2026-07-19T00:00:00.000Z',
        inputConfig: { prompt: 'do it differently' },
      };
      const steering = service.steerSession(steerRequest);
      await steerSubmitted.promise;
      await service.cancelSession(
        {
          type: 'session/cancel',
          sessionId,
          machineId: 'machine-1',
          workspaceId: 'workspace-1' as WorkspaceId,
          turnId: 'assistant:user-1',
        },
        { pendingInput: 'promote' }
      );
      outcome.resolve({
        outcome: 'not-applied',
        error: new Error('Codex adapter reported not-applied after interrupt'),
      });

      await expect(steering).resolves.toMatchObject({
        applied: false,
        disposition: failMetaWrite ? 'promotion-failed' : 'no-active-turn',
        ...(failMetaWrite ? { error: 'Injected activation write failure' } : {}),
      });
      expect(history.find((entry) => entry.id === 'user-2')).toMatchObject({
        status: 'pending',
        read: false,
      });
      if (failMetaWrite) {
        expect(meta.latestUserMsgId).toBe('user-1');
        // Retrying proven non-delivery repairs the activation of an already
        // pending entry. It never submits a second provider steer after Stop.
        await expect(service.steerSession(steerRequest)).resolves.toMatchObject({
          applied: false,
          disposition: 'no-active-turn',
        });
      }
      expect(meta.latestUserMsgId).toBe('user-1');
      expect(meta.steerTurnStatuses).toEqual({ 'user-2': 'pending' });
      expect(deps.turnFinalization.finalizeACPState).not.toHaveBeenCalled();
      expect(deps.beginConversationTurn).not.toHaveBeenCalled();

      (
        service as unknown as {
          turnRuntimeBySession: Map<SessionId, typeof runtime>;
        }
      ).turnRuntimeBySession.delete(sessionId);
      const nextMessage = {
        type: 'session/chat' as const,
        sessionId,
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        project: undefined,
        acpSessionConfig: {
          prompt: 'do it differently',
          cliType: 'builtin' as const,
          agentType: 'codex',
        },
        userTurnId: 'user-2',
        userId: 'user-1',
        userName: 'User',
        userEmail: 'user@example.com',
      };
      await service.continueSession(nextMessage);
      expect(agentClient.prompt).toHaveBeenCalledOnce();
      expect(history.find((entry) => entry.id === 'user-2')).toMatchObject({ status: 'handled' });
    }
  );

  it('preserves pending steer input when an internal cancellation wins before delivery', async () => {
    let history: SessionHistoryInput[] = [
      {
        id: 'user-2',
        role: 'user',
        status: 'pending_apply',
        read: false,
        inputConfig: { prompt: 'do it differently' },
      } as SessionHistoryInput,
    ];
    const sessionDoc = withHistoryPort({
      updateHistory: vi.fn(
        async (update: (entries: SessionHistoryInput[]) => SessionHistoryInput[]) => {
          history = update(history);
        }
      ),
    });
    const upsertDocMeta = vi.fn(async () => {});
    const outcome = createDeferred<{
      outcome: 'not-applied';
      error: Error;
    }>();
    const steerSubmitted = createDeferred();
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      pendingPromptCompletion: null,
      getAcknowledgedSteerCapability: vi.fn(() => ({
        provider: 'codex',
        appliedNotificationMethod: 'codex/steerApplied',
        upstreamTurn: 'same',
        configPolicy: 'active',
      })),
      findSteerConfigMismatch: vi.fn(() => null),
      steerPrompt: vi.fn(() => {
        steerSubmitted.resolve();
        return { completion: new Promise(() => {}), outcome: outcome.promise };
      }),
    };
    const deps = createBaseDeps({
      workspaceDocument: {
        repo: { upsertDocMeta, getDocMeta: vi.fn(async () => undefined) },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
      } as unknown as LoroDocumentManager,
    });
    const service = new SessionExecutionService(deps);
    const sessionId = 'session-internal-cancel-steer' as SessionId;
    const runtime = {
      sessionId,
      turnId: 'assistant:user-1',
      userTurnId: 'user-1',
      session: { agentClient, acpSessionId: 'acp-internal-cancel' as ACPSessionId },
      promptInFlight: true,
      activePromptRun: { turnId: 'assistant:user-1' },
      cancelRequested: false,
      pendingInputOnCancel: 'preserve' as const,
    };
    (
      service as unknown as {
        turnRuntimeBySession: Map<SessionId, typeof runtime>;
      }
    ).turnRuntimeBySession.set(sessionId, runtime);

    const steering = service.steerSession({
      sessionId,
      expectedTurnId: 'assistant:user-1',
      userTurnId: 'user-2',
      userId: 'user-1',
      timestamp: '2026-09-14T00:00:00.000Z',
      inputConfig: { prompt: 'do it differently' },
    });
    await steerSubmitted.promise;
    await service.cancelSession(
      {
        type: 'session/cancel',
        sessionId,
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        turnId: 'assistant:user-1',
      },
      { pendingInput: 'preserve' }
    );
    outcome.resolve({ outcome: 'not-applied', error: new Error('provider declined') });

    await expect(steering).resolves.toMatchObject({
      applied: false,
      disposition: 'stale-turn',
    });
    runtime.promptInFlight = false;
    await expect(
      service.steerSession({
        sessionId,
        expectedTurnId: 'assistant:user-1',
        userTurnId: 'user-2',
        userId: 'user-1',
        timestamp: '2026-09-14T00:00:00.000Z',
        inputConfig: { prompt: 'do it differently' },
      })
    ).resolves.toMatchObject({ applied: false, disposition: 'stale-turn' });
    expect(history[0]).toMatchObject({ status: 'pending_apply' });
    expect(upsertDocMeta).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ latestUserMsgId: 'user-2' })
    );
  });

  it('does not requeue an undelivered steer whose turn already left the pending state', async () => {
    let history: SessionHistoryInput[] = [
      { id: 'user-2', role: 'user', status: 'processing', read: true } as SessionHistoryInput,
    ];
    const sessionDoc = withHistoryPort({
      getHistory: () => history,
      updateHistory: vi.fn(
        async (update: (entries: SessionHistoryInput[]) => SessionHistoryInput[]) => {
          history = update(history);
        }
      ),
    });
    let meta: Partial<SessionMeta> = {};
    const upsertDocMeta = vi.fn(async (_room: string, patch: Partial<SessionMeta>) => {
      meta = { ...meta, ...patch };
    });
    const deps = createBaseDeps({
      workspaceDocument: {
        repo: { upsertDocMeta, getDocMeta: vi.fn(async () => ({ meta })) },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
      } as unknown as LoroDocumentManager,
    });
    const service = new SessionExecutionService(deps);
    const sessionId = 'session-steer-duplicate' as SessionId;

    // No runtime at all: a duplicate steer request landing after the turn it
    // targeted already ran.
    await expect(
      service.steerSession({
        sessionId,
        expectedTurnId: 'assistant:user-1',
        userTurnId: 'user-2',
        userId: 'user-1',
        timestamp: '2026-07-19T00:00:00.000Z',
        inputConfig: { prompt: 'do it differently' },
      })
    ).resolves.toMatchObject({ applied: false, disposition: 'no-active-turn' });
    await service.reconcileSteerHistory(sessionId, sessionDoc);
    expect(history[0]).toMatchObject({ status: 'processing' });
    expect(meta.steerTurnStatuses).toEqual({});
  });

  it('leaves the producer-owned dispatch pointer untouched when execution takes ownership', async () => {
    let meta: Partial<SessionMeta> = { latestUserMsgId: 'user-3' };
    const upsertDocMeta = vi.fn(async (_room: string, patch: Partial<SessionMeta>) => {
      meta = { ...meta, ...patch };
    });
    const getDocMeta = vi.fn(async () => ({ meta }));
    const deps = createBaseDeps({
      workspaceDocument: {
        repo: {
          upsertDocMeta,
          getDocMeta,
        },
        getOrCreateSessionDoc: vi.fn(async () =>
          withHistoryPort({ updateHistory: vi.fn(async () => {}) })
        ),
      } as unknown as LoroDocumentManager,
    });
    const service = new SessionExecutionService(deps);
    const sessionDoc = withHistoryPort({ updateHistory: vi.fn(async () => {}) });
    const setDispatchProcessing = (
      service as unknown as {
        setDispatchProcessing: (
          sessionId: SessionId,
          doc: unknown,
          userTurnId: string
        ) => Promise<void>;
      }
    ).setDispatchProcessing.bind(service);

    await setDispatchProcessing('session-pointer' as SessionId, sessionDoc, 'user-2');

    expect(upsertDocMeta).toHaveBeenCalledWith(expect.any(String), {
      processingUserMsgId: 'user-2',
    });
    expect(meta).toMatchObject({ latestUserMsgId: 'user-3', processingUserMsgId: 'user-2' });
  });

  it('cannot overwrite a newer activation while an earlier turn becomes terminal', async () => {
    let releaseHistoryWrite!: () => void;
    const historyWriteBlocked = new Promise<void>((resolve) => {
      releaseHistoryWrite = resolve;
    });
    const updateHistory = vi.fn(async () => {
      await historyWriteBlocked;
    });
    let meta: Partial<SessionMeta> = { latestUserMsgId: 'user-new' };
    const upsertDocMeta = vi.fn(async (_room: string, patch: Partial<SessionMeta>) => {
      meta = { ...meta, ...patch };
    });
    const getDocMeta = vi.fn(async () => ({ meta }));
    const service = new SessionExecutionService(
      createBaseDeps({
        workspaceDocument: {
          repo: { upsertDocMeta, getDocMeta },
        } as unknown as LoroDocumentManager,
      })
    );
    const setDispatchHandled = (
      service as unknown as {
        setDispatchHandled: (
          sessionId: SessionId,
          doc: unknown,
          userTurnId: string
        ) => Promise<void>;
      }
    ).setDispatchHandled.bind(service);

    const completion = setDispatchHandled(
      'session-terminal-pointer' as SessionId,
      withHistoryPort({ updateHistory }),
      'user-old'
    );
    await vi.waitFor(() => expect(updateHistory).toHaveBeenCalledTimes(1));
    releaseHistoryWrite();
    await completion;

    expect(upsertDocMeta).toHaveBeenCalledWith(expect.any(String), {
      lastHandledUserMsgId: 'user-old',
      processingUserMsgId: undefined,
    });
    expect(meta).toMatchObject({ latestUserMsgId: 'user-new', lastHandledUserMsgId: 'user-old' });
  });

  it('keeps a steer that failed after submission out of the dispatch queue', async () => {
    let meta: Partial<SessionMeta> = { latestUserMsgId: 'user-3' };
    const upsertDocMeta = vi.fn(async (_room: string, patch: Partial<SessionMeta>) => {
      meta = { ...meta, ...patch };
    });
    const deps = createBaseDeps({
      workspaceDocument: {
        repo: { upsertDocMeta, getDocMeta: vi.fn(async () => ({ meta })) },
        getOrCreateSessionDoc: vi.fn(async () =>
          withHistoryPort({ updateHistory: vi.fn(async () => {}) })
        ),
      } as unknown as LoroDocumentManager,
    });
    const service = new SessionExecutionService(deps);
    const sessionId = 'session-steer-ambiguous' as SessionId;
    // A plain failure after submission is ambiguous — the provider may already
    // have committed the steer, so re-sending it would duplicate the message.
    const steerPrompt = vi.fn(() => ({
      completion: new Promise(() => {}),
      outcome: Promise.resolve({
        outcome: 'unknown' as const,
        error: new Error('Steer steer-1 completed before application'),
      }),
    }));
    const runtime = {
      sessionId,
      turnId: 'assistant:user-1',
      userTurnId: 'user-1',
      session: {
        agentClient: {
          getAcknowledgedSteerCapability: vi.fn(() => ({
            provider: 'claudeCode',
            appliedNotificationMethod: 'claude/steerApplied',
            upstreamTurn: 'handoff',
            configPolicy: 'apply',
          })),
          steerPrompt,
        },
        acpSessionId: 'acp-steer-ambiguous' as ACPSessionId,
      },
      promptInFlight: true,
      activePromptRun: { turnId: 'assistant:user-1' },
    };
    (
      service as unknown as {
        turnRuntimeBySession: Map<SessionId, typeof runtime>;
      }
    ).turnRuntimeBySession.set(sessionId, runtime);

    await expect(
      service.steerSession({
        sessionId,
        expectedTurnId: 'assistant:user-1',
        userTurnId: 'user-2',
        userId: 'user-1',
        timestamp: '2026-07-19T00:00:00.000Z',
        inputConfig: { prompt: 'do it differently' },
      })
    ).resolves.toMatchObject({ applied: false, disposition: 'delivery-unknown' });
    expect(meta).toMatchObject({
      latestUserMsgId: 'user-3',
      steerTurnStatuses: { 'user-2': 'delivery_unknown' },
    });
    expect(
      findNextDispatchableUserTurn(
        [{ id: 'user-2', role: 'user', status: 'delivery_unknown' } as SessionHistoryInput],
        meta as SessionMeta
      )
    ).toBeNull();
  });

  it.each([
    ['document', 'stop'],
    ['blocks', 'stop'],
    ['config', 'stop'],
    ['document', 'complete'],
    ['blocks', 'complete'],
    ['config', 'complete'],
  ] as const)('releases the steer lane during stalled %s on %s', async (stage, ending) => {
    const sessionId = 'session-steer-waits' as SessionId;
    let meta: Partial<SessionMeta> = {
      latestUserMsgId: 'newer-input',
      lastMissingHistoryUserMsgId: 'missing-input',
    };
    const repo = {
      getDocMeta: async () => ({ meta }),
      upsertDocMeta: async (_room: string, patch: Partial<SessionMeta>) => {
        meta = { ...meta, ...patch };
      },
    };
    const sessionDoc = new SessionDocument(
      repo as never,
      sessionId,
      async () => {},
      createSilentLogger()
    );
    composeTestSessionDoc(sessionDoc, {
      history: ['guide', 'queued-guide'].map((id) => ({
        id,
        role: 'user',
        status: 'pending_apply',
        timestamp: '2026-09-16T00:00:00Z',
        items: [{ type: 'text', text: id }],
        inputConfig: { prompt: id },
      })),
    });
    const entered = createDeferred();
    const release = createDeferred();
    const prompt = createDeferred();
    const mutations: string[] = [];
    const prepared: string[] = [];
    const block = async () => {
      entered.resolve();
      await release.promise;
    };
    const agentClient = {
      isCreated: () => true,
      cancel: async () => {},
      pendingPromptCompletion: null,
      getAcknowledgedSteerCapability: () => ({ configPolicy: 'apply', upstreamTurn: 'handoff' }),
      steerPrompt: () => {
        throw new Error('A stopped preparation must never submit');
      },
      setSessionMode: async () => {
        mutations.push('mode');
        if (stage === 'config') await block();
      },
      unstable_setSessionModel: async () => {
        mutations.push('model');
      },
    };
    const session = { sessionId, acpSessionId: 'acp-waits' as ACPSessionId, agentClient };
    const deps = createBaseDeps({
      workspaceDocument: {
        repo,
        getOrCreateSessionDoc: async () => {
          if (stage === 'document') await block();
          return sessionDoc;
        },
      } as unknown as LoroDocumentManager,
      buildAcpPromptBlocks: async ({ inputBlocks }) => {
        prepared.push(JSON.stringify(inputBlocks));
        if (stage === 'blocks') await block();
        return [{ type: 'text', text: 'guide' }];
      },
      applyAcpModeAndModel: async (_session, config, options) => {
        await applyAcpSessionRunConfig({
          session: session as never,
          config,
          signal: options?.signal,
          logger: createSilentLogger(),
        });
      },
    });
    const service = new SessionExecutionService(deps);
    const run = service['createPromptHandoffRun']({
      turnId: 'assistant:source',
      promptPromise: prompt.promise,
    });
    const runtime = {
      sessionId,
      turnId: run.turnId,
      userTurnId: 'source',
      session,
      promptStarted: true,
      promptInFlight: true,
      cancelRequested: false,
      pendingInputOnCancel: 'preserve',
    };
    service['turnRuntimeBySession'].set(sessionId, runtime as never);
    const tail = service['awaitPromptHandoffTail'](runtime as never, run);
    const request = {
      sessionId,
      expectedTurnId: run.turnId,
      userTurnId: 'guide',
      userId: 'user',
      timestamp: '2026-09-16T00:00:00Z',
      inputConfig: { prompt: 'guide', modeId: 'mode', modelId: 'model' },
    };
    const steering = service.steerSession(request);
    await entered.promise;
    const queued = service.steerSession({ ...request, userTurnId: 'queued-guide' });
    if (ending === 'stop') {
      await service.cancelSession(
        {
          type: 'session/cancel',
          sessionId,
          turnId: run.turnId,
          machineId: 'machine-1',
          workspaceId: 'workspace-1' as WorkspaceId,
        },
        { pendingInput: 'promote' }
      );
    }
    prompt.resolve();
    await expect(steering).resolves.toMatchObject({ applied: false, recoveryOwned: true });
    await expect(queued).resolves.toMatchObject({ applied: false, recoveryOwned: true });
    const releaseRewrite = service.tryAcquireSessionRewriteBarrier(sessionId);
    expect(releaseRewrite).not.toBeNull();
    releaseRewrite?.();
    expect(meta).toMatchObject({
      latestUserMsgId: 'newer-input',
      lastMissingHistoryUserMsgId: 'missing-input',
      steerTurnStatuses: { guide: 'pending', 'queued-guide': 'pending' },
    });
    expect(prepared).toHaveLength(stage === 'document' ? 0 : 1);
    release.resolve();
    await tail;
    expect(mutations).toEqual(stage === 'config' ? ['mode'] : []);
    await service.reconcileSteerHistory(sessionId, sessionDoc);
    expect(
      findNextDispatchableUserTurn(
        (await sessionDoc.sessionData.history.readAll()) as SessionHistoryInput[],
        meta as SessionMeta
      )?.id
    ).toBe('guide');
  });

  it.each(['not-applied', 'applied', 'unknown'] as const)(
    'projects a late %s verdict by exact identity when history arrives after Stop',
    async (outcome) => {
      const sessionId = 'late-steer-history' as SessionId;
      let meta: Partial<SessionMeta> = { latestUserMsgId: 'C', lastHandledUserMsgId: 'A' };
      const repo = {
        getDocMeta: async () => ({ meta }),
        upsertDocMeta: async (_room: string, patch: Partial<SessionMeta>) => {
          meta = { ...meta, ...patch };
        },
      };
      const sessionDoc = new SessionDocument(
        repo as never,
        sessionId,
        async () => {},
        createSilentLogger()
      );
      composeTestSessionDoc(sessionDoc);
      const submitted = createDeferred();
      const verdict = createDeferred<import('../src/agent/agent-client').SteerOutcomeResult>();
      let released = false;
      const agentClient = {
        isCreated: () => true,
        cancel: async () => {},
        pendingPromptCompletion: null,
        getAcknowledgedSteerCapability: () => ({ configPolicy: 'active', upstreamTurn: 'same' }),
        findSteerConfigMismatch: () => null,
        steerPrompt: () => {
          submitted.resolve();
          return { completion: new Promise(() => {}), outcome: verdict.promise };
        },
      };
      const deps = createBaseDeps({
        workspaceDocument: {
          repo,
          getOrCreateSessionDoc: async () => sessionDoc,
        } as unknown as LoroDocumentManager,
      });
      const service = new SessionExecutionService(deps);
      service['turnRuntimeBySession'].set(sessionId, {
        sessionId,
        turnId: 'assistant:A',
        userTurnId: 'A',
        session: { sessionId, agentClient, acpSessionId: 'acp' },
        promptStarted: true,
        promptInFlight: true,
        activePromptRun: { turnId: 'assistant:A' },
        cancelRequested: false,
      } as never);
      const steering = service.steerSession({
        sessionId,
        expectedTurnId: 'assistant:A',
        userTurnId: 'B',
        userId: 'user',
        timestamp: '2026-09-16T00:00:00Z',
        inputConfig: { prompt: 'guide' },
      });
      await submitted.promise;
      await service.cancelSession(
        {
          type: 'session/cancel',
          sessionId,
          turnId: 'assistant:A',
          machineId: 'machine-1',
          workspaceId: 'workspace-1' as WorkspaceId,
        },
        { pendingInput: 'promote' }
      );
      verdict.resolve(
        outcome === 'applied'
          ? {
              outcome,
              application: {
                steerId: 'steer-B',
                release: () => {
                  released = true;
                },
              },
            }
          : { outcome, error: new Error('Synthetic verdict') }
      );
      await steering;
      expect(released).toBe(outcome === 'applied');
      expect(meta.steerOperationLedger?.['steer:B']).toMatchObject({
        operationId: 'steer:B',
        userTurnId: 'B',
        expectedTurnId: 'assistant:A',
        phase: 'settled',
        delivery:
          outcome === 'not-applied' ? 'not_applied' : outcome === 'applied' ? 'applied' : 'unknown',
      });
      const expected =
        outcome === 'not-applied'
          ? 'pending'
          : outcome === 'applied'
            ? 'canceled'
            : 'delivery_unknown';
      expect(meta).toMatchObject({ latestUserMsgId: 'C', steerTurnStatuses: { B: expected } });
      const restarted = new SessionExecutionService(deps);
      await sessionDoc.sessionData.commands.appendTurn({
        id: 'B',
        role: 'user',
        status: 'pending_apply',
        timestamp: '2026-09-16T00:00:00Z',
        items: [{ type: 'text', text: 'guide' }],
      });
      await restarted.reconcileSteerHistory(sessionId, sessionDoc);
      expect(await sessionDoc.sessionData.history.readTurn('B')).toMatchObject({
        state: 'ready',
        turn: { status: outcome === 'not-applied' ? 'seen' : expected },
      });
      expect(meta.latestUserMsgId).toBe('C');
      expect(
        findNextDispatchableUserTurn(
          (await sessionDoc.sessionData.history.readAll()) as SessionHistoryInput[],
          meta as SessionMeta
        )?.id
      ).toBe(outcome === 'not-applied' ? 'B' : undefined);
      expect(meta.steerTurnStatuses).toEqual(outcome === 'not-applied' ? { B: 'pending' } : {});
    }
  );

  it('recovers provider-confirmed steer delivery without degrading it to unknown', async () => {
    const sessionId = 'recover-applied-steer' as SessionId;
    let meta: Partial<SessionMeta> = {
      latestUserMsgId: 'newer-user',
      steerTurnStatuses: { 'steer-user': 'processing' },
      steerOperationLedger: {
        'steer:steer-user': {
          operationId: 'steer:steer-user',
          userTurnId: 'steer-user',
          expectedTurnId: 'assistant:previous-user',
          cancellationPolicy: 'promote',
          phase: 'submitted',
          delivery: 'applied',
          status: 'processing',
          updatedAt: 10,
        },
      },
    };
    const repo = {
      getDocMeta: async () => ({ meta }),
      upsertDocMeta: async (_roomId: string, patch: Partial<SessionMeta>) => {
        meta = { ...meta, ...patch };
      },
    };
    const sessionDoc = new SessionDocument(
      repo as never,
      sessionId,
      async () => {},
      createSilentLogger()
    );
    composeTestSessionDoc(sessionDoc, {
      history: [
        {
          id: 'steer-user',
          role: 'user',
          timestamp: '2026-09-30T00:00:00.000Z',
          status: 'pending_apply',
          items: [{ type: 'text', text: 'continue the accepted steer' }],
        } as SessionHistoryInput,
      ],
    });
    const service = new SessionExecutionService(
      createBaseDeps({
        workspaceDocument: {
          repo,
          getOrCreateSessionDoc: async () => sessionDoc,
        } as unknown as LoroDocumentManager,
      })
    );

    await service.reconcileSteerHistory(sessionId, sessionDoc);

    expect(meta.steerOperationLedger?.['steer:steer-user']).toMatchObject({
      phase: 'settled',
      delivery: 'applied',
      status: 'handled',
    });
    expect(meta.steerTurnStatuses).toEqual({});
    expect(await sessionDoc.sessionData.history.readTurn('steer-user')).toMatchObject({
      state: 'ready',
      turn: { status: 'handled' },
    });
    expect(meta.latestUserMsgId).toBe('newer-user');
  });

  it('notifies when a prompt completes while a persistent goal remains active', async () => {
    let history: Array<Record<string, unknown>> = [
      {
        id: 'turn-user-1',
        role: 'user',
        status: 'pending',
        read: false,
      },
    ];
    const activeGoal: SessionGoalMessage = {
      type: 'goal',
      threadId: 'thread-1',
      turnId: 'assistant-goal-1',
      objective: 'Keep working until explicitly complete',
      status: 'active',
      tokenBudget: null,
      tokensUsed: 100,
      timeUsedSeconds: 60,
      createdAt: 100,
      updatedAt: 200,
    };
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({})),
      currentModel: undefined,
    };
    const activeSession = {
      sessionId: 'session-goal-active' as SessionId,
      acpSessionId: 'acp-goal-active' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getGitHubCredentials: () => nativeSessionCredentials,
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-goal-active'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => ({ isArchived: false, latestGoal: activeGoal })),
      setStatus: vi.fn(async () => {}),
      setLastMessageAt: vi.fn(async () => {}),
      getHistory: vi.fn(() => history),
      updateHistory: vi.fn(async (updater: (prev: typeof history) => typeof history) => {
        history = updater(history);
      }),
    });
    const onTurnOutcome = vi.fn(async () => {});
    const deps = createBaseDeps({
      sessionManager: {
        getSession: vi.fn(() => activeSession),
        getPendingSession: vi.fn(() => null),
        createSession: vi.fn(),
        setSessionError: vi.fn(),
        terminateSession: vi.fn(),
        validateSessionCredentials: vi.fn(async () => {}),
      } as unknown as SessionManager,
      workspaceDocument: {
        repo: {
          upsertDocMeta: vi.fn(async () => {}),
          getDocMeta: vi.fn(async () => undefined),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        getOrOpenSessionCode: vi.fn(async () => null),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
      turnFinalization: {
        ...createBaseDeps({}).turnFinalization,
        onTurnOutcome,
      },
    });

    const service = new SessionExecutionService(deps);
    await service.continueSession({
      type: 'session/chat',
      sessionId: 'session-goal-active' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: undefined,
      acpSessionConfig: { prompt: '/goal Keep working', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-user-1',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(agentClient.prompt).toHaveBeenCalled();
    expect(history[0]?.status).toBe('handled');
    await service.drainInboxExecutions();
    expect(onTurnOutcome).toHaveBeenCalledTimes(1);
  });

  it('restores the ACP process before prompting when the turn Git identity changed', async () => {
    const sessionId = 'session-requester-switch' as SessionId;
    let history: Array<Record<string, unknown>> = [
      { id: 'turn-user-2', role: 'user', status: 'pending', read: false },
    ];
    const oldPrompt = vi.fn(async () => ({}));
    const oldSession = {
      sessionId,
      acpSessionId: 'acp-owner' as ACPSessionId,
      agentClient: {
        isCreated: vi.fn(() => true),
        cancel: vi.fn(async () => {}),
        prompt: oldPrompt,
        currentModel: undefined,
      },
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getGitHubCredentials: () => nativeSessionCredentials,
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-owner'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => ({
        isArchived: false,
        acpSessionId: 'acp-owner' as ACPSessionId,
      })),
      setStatus: vi.fn(async () => {}),
      setLastMessageAt: vi.fn(async () => {}),
      getHistory: vi.fn(() => history),
      updateHistory: vi.fn(async (updater: (prev: typeof history) => typeof history) => {
        history = updater(history);
      }),
    });
    const terminateSession = vi.fn(async () => {});
    const createSession = vi.fn();
    const deps = createBaseDeps({
      sessionManager: {
        getSession: vi.fn(() => oldSession),
        getPendingSession: vi.fn(() => null),
        createSession,
        setSessionError: vi.fn(),
        terminateSession,
        validateSessionCredentials: vi.fn(async () => {}),
      } as unknown as SessionManager,
      workspaceDocument: {
        repo: {
          upsertDocMeta: vi.fn(async () => {}),
          getDocMeta: vi.fn(async () => undefined),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        getOrOpenSessionCode: vi.fn(async () => null),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
    });

    const service = new SessionExecutionService(deps);
    await service.continueSession({
      type: 'session/chat',
      sessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: undefined,
      acpSessionConfig: { prompt: 'continue', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-user-2',
      userId: 'user-2',
      userName: 'Teammate',
      userEmail: 'teammate@example.com',
    });

    expect(terminateSession).not.toHaveBeenCalled();
    expect(oldSession.terminate).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(oldPrompt).toHaveBeenCalledOnce();
    expect(oldSession.updateGitIdentity).toHaveBeenCalledWith(
      'Teammate',
      'teammate@example.com',
      'user-2',
      { preferMachineIdentity: false, personalIdentityEnabled: false }
    );
  });

  it('lets a claimed derived turn delegate through the daemon with its root member identity', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-derived-invocation-'));
    const root = { sessionId: 'human-session', userTurnId: 'human-turn' };
    const member = 'aa'.repeat(32);
    const machine = 'bb'.repeat(32);
    const requester = 'e2ee-member:member';
    let allowed = true;
    const gate = makeEncryptedAgentExecution({
      genesis: 'genesis',
      workspaceId: 'workspace-1',
      targetMachineId: 'machine-1',
      machineUserId: 'user-1',
      selfDevice: machine,
      journal: lazyExecutionJournal(path.join(directory, 'journal.sqlite'), () => 100),
      resolveVerifiedOriginal: (intent) =>
        Effect.succeed(
          intent.sessionId === root.sessionId
            ? { requesterDevice: member, requesterCryptoUserId: 'member' }
            : { requesterDevice: machine, requesterCryptoUserId: 'owner', derivedFrom: root }
        ),
      authorizeExecution: () =>
        Effect.succeed(
          allowed
            ? { _tag: 'Authorized', principal: 'member' }
            : { _tag: 'Denied', reason: 'not-authorized' }
        ),
    });
    const delegated: unknown[] = [];
    let allChecksCompleted = false;
    try {
      const result = await runSilentPromptTurn({
        sessionId: 'derived-session',
        requesterUserId: requester,
        hasPromptEventsForTurn: true,
        prepared: true,
        encryptedExecution: gate,
        onPrompt: async (service) => {
          expect(
            service.getActiveInvocationContext('derived-session' as SessionId)?.requesterUserId
          ).toBe(requester);
          expect(
            service.getEncryptedControlPrincipal('derived-session' as SessionId)
          ).toMatchObject({ kind: 'member', requesterDevice: member });
          const handler = Object.assign(Object.create(MessageHandler.prototype), {
            encryptedExecution: gate,
            executionService: service,
            machineId: 'machine-1',
          }) as {
            classifyEncryptedDerivation: (
              ref: { sessionId: string; userTurnId: string },
              target: { machineId: string; userTurnId: string }
            ) => Promise<unknown>;
          };
          const driving = { sessionId: 'derived-session', userTurnId: 'turn-user-1' };
          // Refused targets never spend a slot, even with different request IDs.
          for (let i = 0; i < 25; i++)
            await expect(
              handler.classifyEncryptedDerivation(driving, {
                machineId: 'other-machine',
                userTurnId: `rejected-${i}`,
              })
            ).rejects.toThrow('e2ee_derivation_cross_machine_unsupported');
          // One accepted operation can retry without spending the remaining slots.
          for (let i = 0; i < 25; i++) {
            const result = await handler.classifyEncryptedDerivation(driving, {
              machineId: 'machine-1',
              userTurnId: 'accepted-0',
            });
            expect(result).toEqual({ principal: 'member', origin: root });
            if (i === 0) delegated.push(result);
          }
          for (let i = 1; i < 20; i++)
            expect(
              await handler.classifyEncryptedDerivation(driving, {
                machineId: 'machine-1',
                userTurnId: `accepted-${i}`,
              })
            ).toEqual({ principal: 'member', origin: root });
          await expect(
            handler.classifyEncryptedDerivation(driving, {
              machineId: 'machine-1',
              userTurnId: 'overflow',
            })
          ).rejects.toThrow('e2ee_derivation_denied');
          expect(
            await handler.classifyEncryptedDerivation(driving, {
              machineId: 'machine-1',
              userTurnId: 'accepted-0',
            })
          ).toEqual({ principal: 'member', origin: root });
          allowed = false;
          await expect(
            handler.classifyEncryptedDerivation(driving, {
              machineId: 'machine-1',
              userTurnId: 'accepted-0',
            })
          ).rejects.toThrow('e2ee_derivation_denied');
          allChecksCompleted = true;
        },
      });
      expect(allChecksCompleted).toBe(true);
      expect(result.failureMessages).toEqual([]);
      expect(result.getHistory()[0]?.status).toBe('handled');
      expect(delegated).toEqual([{ principal: 'member', origin: root }]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('executes the real UI account ID through production Lody construction without injected authorization', () =>
    runProductionSignedTurn('account'));

  it.each([
    'snapshot',
    'late',
    'unsigned',
    'same-member',
    'other-member',
    'other-member-shared',
    'other-member-closed',
    'revoked-device',
    'guest',
    'removed-member',
  ] as const)(
    'executes a signed durable turn through production Lody construction (%s)',
    runProductionSignedTurn
  );
});
