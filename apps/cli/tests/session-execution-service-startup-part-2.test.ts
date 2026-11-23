import { nativeSessionCredentials } from '@/session/session-credentials';
import { type ContentBlock } from '@agentclientprotocol/sdk';
import {
  buildSessionTurnInputConfig,
  inputBlocksToHistoryItems,
  SessionStatusFactory,
  type ACPSessionId,
  type AgentRoleId,
  type LocalProjectId,
  type MachineId,
  type SessionHistoryInput,
  type SessionId,
  type SessionInputBlock,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SessionDocument, type LoroDocumentManager } from '../src/lib/loro/doc';
import { resolveDispatchTurnInput } from '../src/session/session-dispatch-logic';
import {
  SessionExecutionService,
  type SessionExecutionServiceDeps,
} from '../src/session/session-execution-service';
import type { SessionManager } from '../src/session/session-manager';
import type { SessionConfig } from '../src/session/types';
import { withHistoryPort } from './history-port-fixture';
import { composeTestSessionDoc } from './session-doc-fixture';
import {
  capabilityConfigId,
  createBaseDeps,
  createGitLocalProject,
  createLaunchConfig,
  createSilentLogger,
  runGit,
} from './session-execution-service-helpers';

vi.hoisted(() => {
  Object.assign(globalThis, { __LODY_E2E_DAEMON_LOSS__: true });
  process.env.LODY_E2E = '1';
});
describe('SessionExecutionService', () => {
  it('starts create prompt block building only after session creation registers the workspace', async () => {
    const events: string[] = [];
    let history: Array<Record<string, unknown>> = [
      {
        id: 'turn-user-1',
        role: 'user',
        status: 'pending',
        read: false,
      },
    ];
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => ({ isArchived: false })),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(() => history),
      updateHistory: vi.fn(async (updater: (prev: typeof history) => typeof history) => {
        history = updater(history);
      }),
      roomId: 'session-session-create-dag',
    });
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => {
        events.push('prompt');
        return {};
      }),
      currentModel: undefined,
    };
    const createdSession = {
      sessionId: 'session-create-dag' as SessionId,
      acpSessionId: 'acp-create-dag' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getGitHubCredentials: () => nativeSessionCredentials,
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-create-dag'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    let activeSession: typeof createdSession | null = null;
    let releaseCreateSession!: () => void;
    const createSessionGate = new Promise<void>((resolve) => {
      releaseCreateSession = resolve;
    });
    const createSession = vi.fn(async () => {
      events.push('create-start');
      await createSessionGate;
      activeSession = createdSession;
      events.push('create-resolved');
      return createdSession as unknown;
    });
    const buildAcpPromptBlocks = vi.fn(async () => {
      expect(activeSession).toBe(createdSession);
      events.push('build-blocks');
      return [{ type: 'text', text: 'built prompt' }] as any;
    });
    const deps = createBaseDeps({
      sessionManager: {
        getSession: vi.fn(() => activeSession),
        getPendingSession: vi.fn(() => null),
        createSession,
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
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
      buildAcpPromptBlocks,
    });

    const service = new SessionExecutionService(deps);
    const startPromise = service.startSession({
      type: 'session/create',
      sessionId: 'session-create-dag' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: undefined,
      acpSessionConfig: { prompt: 'hi', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-user-1',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    try {
      await vi.waitFor(() => {
        expect(createSession).toHaveBeenCalledTimes(1);
        expect(events).toContain('create-start');
      });
      expect(buildAcpPromptBlocks).not.toHaveBeenCalled();
      expect(events).not.toContain('create-resolved');
      expect(agentClient.prompt).not.toHaveBeenCalled();
    } finally {
      releaseCreateSession();
    }

    await startPromise;

    expect(events.indexOf('build-blocks')).toBeGreaterThan(events.indexOf('create-resolved'));
    expect(agentClient.prompt).toHaveBeenCalledWith(
      'acp-create-dag',
      [{ type: 'text', text: 'built prompt' }],
      { signal: expect.any(AbortSignal) }
    );
  });

  it('delivers attachments and first-task instructions together to a new worktree agent', async () => {
    let history: Array<Record<string, unknown>> = [
      {
        id: 'turn-user-file',
        role: 'user',
        status: 'pending',
        read: false,
      },
    ];
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => ({ isArchived: false })),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(() => history),
      updateHistory: vi.fn(async (updater: (prev: typeof history) => typeof history) => {
        history = updater(history);
      }),
      roomId: 'session-session-file-create',
    });
    let deliveredPrompt: ContentBlock[] = [];
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async (_sessionId: string, blocks: ContentBlock[]) => {
        deliveredPrompt = blocks;
        return {};
      }),
      currentModel: undefined,
    };
    const createdSession = {
      sessionId: 'session-file-create' as SessionId,
      acpSessionId: 'acp-file-create' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getGitHubCredentials: () => nativeSessionCredentials,
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async (_command: string, args: string[]) =>
        args.join(' ') === 'branch --show-current' ? 'session/session-' : ''
      ),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-file-create'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const fileBlock = {
      type: 'file',
      fileId: 'file-12345678',
      fileName: 'trace.json',
      mimeType: 'application/json',
      sizeBytes: 1024,
      sha256: 'a'.repeat(64),
      textPreview: true,
      transport: 'r2',
      uploadedAt: 123,
    } satisfies Extract<SessionInputBlock, { type: 'file' }>;
    const buildAcpPromptBlocks: SessionExecutionServiceDeps['buildAcpPromptBlocks'] = async ({
      inputBlocks,
    }) =>
      inputBlocks.flatMap((block): ContentBlock[] => {
        if (block.type === 'local_attachment') {
          return [{ type: 'resource_link', uri: `file://${block.path}`, name: block.fileName }];
        }
        if (block.type === 'text') return [{ type: 'text', text: block.text }];
        if (block.type === 'file')
          return [{ type: 'text', text: `Attached file: ${block.fileName}` }];
        return [];
      });
    const deps = createBaseDeps({
      sessionManager: {
        getSession: vi.fn(() => null),
        getPendingSession: vi.fn(() => null),
        createSession: vi.fn(async () => createdSession as unknown),
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
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
      buildAcpPromptBlocks,
    });

    const service = new SessionExecutionService(deps);
    await service.startSession({
      type: 'session/create',
      sessionId: 'session-file-create' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: { kind: 'github', repoFullName: 'owner/repo' },
      acpSessionConfig: {
        prompt: 'CONFIG_INSTRUCTION\n\nROLE_INSTRUCTION\n\ninspect the attached trace',
        inputBlocks: [
          { type: 'text', text: 'inspect the attached trace' },
          fileBlock,
          {
            type: 'local_attachment',
            machineId: 'machine-1',
            path: '/tmp/local.txt',
            kind: 'file',
            fileName: 'local.txt',
            mimeType: 'text/plain',
            sizeBytes: 5,
          },
        ],
        cliType: 'builtin',
        agentType: 'codex',
      },
      userTurnId: 'turn-user-file',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(deliveredPrompt).toEqual([
      { type: 'text', text: 'Attached file: trace.json' },
      { type: 'resource_link', uri: 'file:///tmp/local.txt', name: 'local.txt' },
      { type: 'text', text: expect.stringContaining('inspect the attached trace') },
    ]);
    expect(deliveredPrompt[2]).toMatchObject({
      text: expect.stringContaining(
        'Before starting this task, rename the branch session/session-'
      ),
    });
    const executionText = (deliveredPrompt[2] as Extract<ContentBlock, { type: 'text' }>).text;
    for (const instruction of [
      'CONFIG_INSTRUCTION',
      'ROLE_INSTRUCTION',
      'inspect the attached trace',
    ]) {
      expect(executionText.split(instruction)).toHaveLength(2);
    }
  });

  it.each(['create', 'continue', 'restore'] as const)(
    'retains frozen execution input after a failed start retried through %s',
    async (retryPath) => {
      const sessionId = 'session-frozen-retry' as SessionId;
      const userTurnId = 'turn-frozen';
      const fileBlock: SessionInputBlock = {
        type: 'file',
        fileId: 'file-12345678',
        fileName: 'trace.json',
        mimeType: 'application/json',
        sizeBytes: 1024,
        sha256: 'a'.repeat(64),
        textPreview: true,
        transport: 'r2',
        uploadedAt: 123,
      };
      const inputConfig = buildSessionTurnInputConfig({
        inputBlocks: [{ type: 'text', text: 'TASK_TEXT' }, fileBlock],
        prompt: 'CONFIG_INSTRUCTION\n\nROLE_INSTRUCTION\n\nTASK_TEXT',
        cliType: 'builtin',
        agentType: 'codex',
        agentRoleId: 'role-frozen' as AgentRoleId,
        agentRoleRevision: 7,
        agentRoleSnapshot: { id: 'role-frozen', revision: 7, name: 'Reviewer', emoji: '' },
      });
      let meta: Partial<SessionMeta> = { id: sessionId, isArchived: false };
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
        history: [
          {
            id: userTurnId,
            role: 'user',
            userId: 'user-1',
            status: 'pending',
            timestamp: '2026-10-08T00:00:00.000Z',
            items: inputBlocksToHistoryItems(inputConfig.inputBlocks ?? []),
            inputConfig,
          },
        ],
      });
      const requests: ContentBlock[][] = [];
      const agentClient = {
        isCreated: () => true,
        cancel: async () => {},
        prompt: async (_id: string, blocks: ContentBlock[]) => {
          requests.push(blocks);
          if (requests.length === 1) throw new Error('synthetic first-attempt failure');
          return { stopReason: 'end_turn' };
        },
      };
      const session = {
        sessionId,
        acpSessionId: 'acp-frozen' as ACPSessionId,
        agentClient,
        terminalManager: {},
        getWorkdir: () => '/tmp',
        getGitHubCredentials: () => nativeSessionCredentials,
        getHostWorkdir: () => '/tmp',
        getParentSessionId: () => undefined,
        exec: async () => '',
        terminate: async () => {},
        updateGitIdentity: () => {},
        createAgent: async () => 'acp-frozen',
        applyExecutionPlaneLimits: async () => {},
      };
      let live = false;
      const deps = createBaseDeps({
        sessionManager: {
          getSession: () => (live ? session : null),
          getPendingSession: () => null,
          createSession: async () => {
            live = true;
            return session;
          },
          setSessionError: () => {},
          terminateSession: async () => {
            live = false;
          },
          validateSessionCredentials: async () => {},
        } as unknown as SessionManager,
        workspaceDocument: {
          repo,
          getOrCreateSessionDoc: async () => sessionDoc,
          updateAcpCapabilities: async () => {},
        } as unknown as LoroDocumentManager,
        // Attachment I/O is a port; execute the real turn and observe provider payloads.
        buildAcpPromptBlocks: async ({ inputBlocks }) =>
          inputBlocks.flatMap((block): ContentBlock[] => {
            if (block.type === 'text') return [{ type: 'text', text: block.text }];
            if (block.type === 'file')
              return [
                { type: 'resource_link', uri: `file:///${block.fileId}`, name: block.fileName },
              ];
            throw new Error('Unexpected fixture block');
          }),
      });
      const service = new SessionExecutionService(deps);
      const readRequest = async () => {
        const read = await sessionDoc.sessionData.history.readTurn(userTurnId);
        const turn = read.state === 'ready' ? read.turn : undefined;
        if (!turn?.inputConfig) throw new Error('Frozen turn missing');
        expect(turn.inputConfig).toEqual(inputConfig);
        return {
          sessionId,
          machineId: 'machine-1',
          workspaceId: 'workspace-1' as WorkspaceId,
          userTurnId,
          userId: 'user-1',
          userName: 'User',
          userEmail: 'user@example.com',
          acpSessionConfig: { ...inputConfig, ...resolveDispatchTurnInput(turn) },
        };
      };
      await service.startSession({ ...(await readRequest()), type: 'session/create' });
      expect(requests).toHaveLength(1);
      expect(service.getExecutionSnapshot(sessionId)).toMatchObject({ hasActiveTurn: false });
      // A fresh executor has no in-memory prompt cache; only the persisted turn survives.
      const retryService = new SessionExecutionService(deps);
      live = retryPath === 'continue';
      if (retryPath === 'create') {
        await retryService.startSession({ ...(await readRequest()), type: 'session/create' });
      } else {
        await retryService.continueSession({ ...(await readRequest()), type: 'session/chat' });
      }
      await readRequest(); // Frozen config remains intact after both attempts.
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        const text = request
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n');
        for (const instruction of ['CONFIG_INSTRUCTION', 'ROLE_INSTRUCTION', 'TASK_TEXT']) {
          expect(text.split(instruction)).toHaveLength(2);
        }
        expect(request.filter((block) => block.type === 'resource_link')).toEqual([
          { type: 'resource_link', uri: 'file:///file-12345678', name: 'trace.json' },
        ]);
      }
      expect(await sessionDoc.sessionData.history.readTurn(userTurnId)).toMatchObject({
        state: 'ready',
        turn: { items: [{ type: 'text', text: 'TASK_TEXT' }, fileBlock] },
      });
    }
  );

  it.each([
    { scenario: 'missing process', live: false, memory: undefined },
    {
      scenario: 'changed memory identity',
      live: true,
      memory: { providerId: 'nowledge-mem', memoryId: 'reviewer' },
    },
    { scenario: 'unlinked memory identity', live: true, memory: undefined },
    { scenario: 'added MCP', live: true, previousMcp: [], mcp: ['server-a'] },
    { scenario: 'removed MCP', live: true, previousMcp: ['server-a'], mcp: [] },
    { scenario: 'replaced MCP', live: true, previousMcp: ['server-a'], mcp: ['server-b'] },
    {
      scenario: 'reordered MCP',
      live: true,
      previousMcp: ['server-a', 'server-b'],
      mcp: ['server-b', 'server-a'],
      reuse: true,
    },
    {
      scenario: 'unchanged MCP',
      live: true,
      previousMcp: ['server-a'],
      mcp: ['server-a'],
      reuse: true,
    },
  ])(
    'restores ACP with frozen configuration after $scenario',
    async ({ live, memory, previousMcp, mcp, reuse }) => {
      const mcpServerIds = mcp as SessionConfig['mcpServerIds'] | undefined;
      const events: string[] = [];
      const codexAuth = {
        mode: 'chatgpt' as const,
        profileId: '60a84cb4-50fd-4590-9f69-6055ffef0c57',
      };
      const meta = {
        agentConfigId: capabilityConfigId,
        repoFullName: 'owner/repo',
        acpSessionId: 'acp-1' as ACPSessionId,
        branchName: 'feat/resume',
        parentSessionId: 'parent-session-1' as SessionId,
        isArchived: false,
      };
      let history: unknown[] = [];
      const sessionDoc = withHistoryPort({
        getMetaState: vi.fn(async () => meta),
        setStatus: vi.fn(async () => {}),
        setBaseBranch: vi.fn(async () => {}),
        getHistory: vi.fn(() => history),
        updateHistory: vi.fn(async (updater: (prev: unknown[]) => unknown[]) => {
          history = updater(history);
        }),
      });

      const agentClient = {
        isCreated: vi.fn(() => true),
        cancel: vi.fn(async () => {}),
        prompt: vi.fn(async () => {
          events.push('prompt');
          return {};
        }),
        currentModel: undefined,
      };
      const restoredSession = {
        sessionId: 'session-1' as SessionId,
        acpSessionId: 'acp-1' as ACPSessionId,
        agentClient,
        terminalManager: {} as unknown,
        getWorkdir: () => '/tmp',
        getGitHubCredentials: () => nativeSessionCredentials,
        getHostWorkdir: () => '/tmp',
        getParentSessionId: () => undefined,
        exec: vi.fn(async () => ''),
        terminate: vi.fn(async () => {}),
        updateGitIdentity: vi.fn(),
        createAgent: vi.fn(async () => 'acp-1'),
        applyExecutionPlaneLimits: vi.fn(async () => {}),
      };

      let retired = !live;
      const oldSession = {
        ...restoredSession,
        getMemoryBinding: () =>
          previousMcp ? undefined : { providerId: 'nowledge-mem', memoryId: 'previous' },
        getMcpServerIds: () => previousMcp as SessionConfig['mcpServerIds'],
        agentClient: {
          ...agentClient,
          prompt: async () => {
            if (!reuse) throw new Error('Old process must not receive the new prompt');
            events.push('prompt');
            return {};
          },
        },
      };
      const sessionManager = {
        getSession: vi.fn(() => (retired ? null : oldSession)),
        retireSessionForReconfiguration: async (session: unknown) => {
          expect(session).toBe(oldSession);
          retired = true;
          events.push('retire');
        },
        getPendingSession: vi.fn(() => null),
        createSession: vi.fn(async (config, agentStart) => {
          expect(retired).toBe(true);
          events.push('restore');
          expect(config.memory).toEqual(memory);
          expect(config.mcpServerIds).toEqual(mcpServerIds ?? []);
          expect(config.sessionId).toBe('session-1');
          expect(config.resume).toBe(true);
          expect(config.githubRepo).toBe('owner/repo');
          expect(config.restoreBranchName).toBe('feat/resume');
          expect(config.parentSessionId).toBe('parent-session-1');
          expect(config.agentConfigId).toBe(capabilityConfigId);
          expect(config.codexAuth).toEqual(codexAuth);
          expect(agentStart?.resumeSessionId).toBe('acp-1');
          return restoredSession as unknown;
        }),
        setSessionError: vi.fn(),
        terminateSession: vi.fn(),
        validateSessionCredentials: vi.fn(async () => {}),
      } as unknown as SessionManager;

      const deps = createBaseDeps({
        sessionManager,
        workspaceDocument: {
          getAgentConfigById: async () =>
            createLaunchConfig({ cliType: 'builtin', agentType: 'codex', env: {}, codexAuth }),
          repo: {
            upsertDocMeta: vi.fn(async () => {}),
            getDocMeta: vi.fn(async () => undefined),
          },
          getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
          updateAcpCapabilities: vi.fn(async () => {}),
        } as unknown as LoroDocumentManager,
        buildAcpPromptBlocks: vi.fn(async () => [{ type: 'text', text: 'hi' }] as any),
      });

      const service = new SessionExecutionService(deps);
      await service.continueSession({
        type: 'session/chat',
        sessionId: 'session-1' as SessionId,
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        project: { kind: 'github', repoFullName: 'owner/repo', branch: 'main' },
        acpSessionConfig: {
          prompt: 'hi',
          cliType: 'builtin',
          agentType: 'codex',
          memory,
          mcpServerIds,
        },
        userTurnId: 'turn-user-1',
        userId: 'user-1',
        userName: 'User',
        userEmail: 'user@example.com',
      });

      expect(events).toEqual(
        reuse ? ['prompt'] : live ? ['retire', 'restore', 'prompt'] : ['restore', 'prompt']
      );
      if (reuse) {
        expect(sessionDoc.setStatus.mock.calls.map(([status]) => status)).toEqual([
          SessionStatusFactory.initializing(),
          SessionStatusFactory.running(),
          SessionStatusFactory.idle(),
        ]);
        return;
      }
      expect(sessionDoc.setStatus).toHaveBeenCalledWith(
        SessionStatusFactory.initializing('resuming')
      );
      expect(sessionDoc.setStatus.mock.calls.map(([status]) => status)).toEqual([
        SessionStatusFactory.initializing(),
        SessionStatusFactory.initializing('resuming'),
        SessionStatusFactory.running(),
        SessionStatusFactory.idle(),
      ]);
      expect(sessionDoc.setBaseBranch).toHaveBeenCalledWith('main');
      expect(agentClient.prompt).toHaveBeenCalledWith('acp-1', [{ type: 'text', text: 'hi' }], {
        signal: expect.any(AbortSignal),
      });
      expect(deps.startSessionActivePresence).toHaveBeenCalledTimes(1);
      expect(deps.startSessionActivePresence).toHaveBeenCalledWith('session-1', 'initializing');
      expect(deps.clearSessionActivePresence).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    ['create', 'stable'],
    ['continue', 'stable'],
    ['create', 'transferred'],
    ['continue', 'transferred'],
    ['create', 'changed again'],
    ['continue', 'changed again'],
    ['continue', 'transferred before disconnect'],
  ] as const)(
    'replays failed first-turn input through %s dispatch without a resumable ACP id (owner %s)',
    async (mode, ownership) => {
      const meta = {
        repoFullName: 'owner/repo',
        isArchived: false,
        lastHandledUserMsgId: 'turn-startup-failed',
      };
      let history: SessionHistoryInput[] = [
        {
          id: 'turn-startup-failed',
          role: 'user',
          timestamp: '2026-08-05T05:30:00.000Z',
          status: 'failed',
          fileDiff: [],
          items: [{ type: 'text', text: 'Build this on the two MIT packages.' }],
        },
        {
          id: 'turn-current',
          role: 'user',
          timestamp: '2026-08-05T05:31:00.000Z',
          status: 'pending',
          fileDiff: [],
          items: [{ type: 'text', text: '?' }],
        },
        {
          id: 'assistant:turn-current',
          role: 'assistant',
          timestamp: '2026-08-05T05:31:01.000Z',
          fileDiff: [],
          items: [{ type: 'text', text: 'Stale output from this turn.' }],
        },
      ];
      const sessionDoc = withHistoryPort({
        getMetaState: vi.fn(async () => meta),
        setStatus: vi.fn(async () => {}),
        setBaseBranch: vi.fn(async () => {}),
        getHistory: vi.fn(() => history),
        updateHistory: vi.fn(
          async (updater: (prev: SessionHistoryInput[]) => SessionHistoryInput[]) => {
            history = updater(history);
          }
        ),
      });
      const agentClient = {
        isCreated: vi.fn(() => true),
        cancel: vi.fn(async () => {}),
        prompt: vi.fn(
          async (_id: string, _blocks: { type: string; text: string }[], _options: unknown) => {
            if (ownership === 'transferred before disconnect')
              throw new Error('ACP connection closed');
            return {};
          }
        ),
        currentModel: undefined,
      };
      const restoredSession = {
        sessionId: 'session-fresh-restore' as SessionId,
        acpSessionId: 'acp-fresh-restore' as ACPSessionId,
        agentClient,
        terminalManager: {} as unknown,
        getWorkdir: () => '/tmp',
        getGitHubCredentials: () => nativeSessionCredentials,
        getHostWorkdir: () => '/tmp',
        getParentSessionId: () => undefined,
        exec: vi.fn(async () => ''),
        terminate: vi.fn(async () => {}),
        updateGitIdentity: vi.fn(),
        createAgent: vi.fn(async () => 'acp-fresh-restore'),
        applyExecutionPlaneLimits: vi.fn(async () => {}),
      };
      const buildAcpPromptBlocks = vi.fn(async (args: { replayPromptText?: string }) => [
        { type: 'text' as const, text: args.replayPromptText ?? '' },
        { type: 'text' as const, text: '?' },
      ]);
      const stalePrompts: unknown[] = [];
      const oldSession = {
        ...restoredSession,
        agentClient: {
          ...agentClient,
          prompt: async (...args: unknown[]) => {
            stalePrompts.push(args);
            return {};
          },
        },
      };
      let retired = false;
      let validationReached = false;
      const deps = createBaseDeps({
        sessionManager: {
          getSession: vi.fn(() => null),
          getPendingSession: vi.fn(() => null),
          createSession: async (config: SessionConfig) => {
            if (ownership !== 'stable' && !retired) {
              config.env = { ...config.env, LODY_GIT_CRED_CONTEXT_TOKEN: 'old-fixture-lease' };
              return oldSession;
            }
            expect(config.env?.LODY_GIT_CRED_CONTEXT_TOKEN).toBeUndefined();
            return restoredSession;
          },
          retireSessionForReconfiguration: async () => {},
          setSessionError: vi.fn(),
          terminateSession: vi.fn(),
          validateSessionCredentials: async (
            session: unknown,
            _requester: string,
            mode?: string
          ) => {
            if (session === oldSession) {
              if (mode !== 'replace-before-prompt') throw new Error('github_owner_changed');
              retired = true;
              return 'retired';
            }
            validationReached = true;
            if (ownership === 'changed again') throw new Error('github_owner_changed');
          },
        } as unknown as SessionManager,
        workspaceDocument: {
          repo: {
            upsertDocMeta: vi.fn(async () => {}),
            getDocMeta: vi.fn(async () => undefined),
          },
          getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
          updateAcpCapabilities: vi.fn(async () => {}),
        } as unknown as LoroDocumentManager,
        hasPromptEventsForTurn: () => ownership !== 'transferred before disconnect',
        buildAcpPromptBlocks,
      });

      const service = new SessionExecutionService(deps);
      const request = {
        type: 'session/chat' as const,
        sessionId: 'session-fresh-restore' as SessionId,
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        project: { kind: 'github' as const, repoFullName: 'owner/repo', branch: 'main' },
        acpSessionConfig: { prompt: '?', cliType: 'builtin' as const, agentType: 'codex' },
        userTurnId: 'turn-current',
        userId: 'user-1',
        userName: 'User',
        userEmail: 'user@example.com',
      };
      if (mode === 'create') {
        await service.startSession({ ...request, type: 'session/create' });
      } else {
        await service.continueSession(request);
      }

      expect(stalePrompts).toEqual([]);
      expect(validationReached).toBe(true);
      if (ownership === 'changed again') {
        expect(agentClient.prompt.mock.calls).toHaveLength(0);
        expect(deps.recordChatFailure).toHaveBeenCalledWith(
          sessionDoc,
          'turn_pre_prompt_failed',
          expect.stringContaining('github_owner_changed')
        );
        return;
      }
      expect(agentClient.prompt.mock.calls).toHaveLength(1);
      const delivered = agentClient.prompt.mock.calls[0]?.[1];
      expect(delivered).toEqual([
        { type: 'text', text: expect.stringContaining('Build this on the two MIT packages.') },
        { type: 'text', text: '?' },
      ]);
      expect(delivered?.[0]?.text).not.toContain('[User]\n?');
      expect(delivered?.[0]?.text).not.toContain('Stale output from this turn.');
    }
  );

  it('waits for late-syncing history before creating a fresh ACP session', async () => {
    const meta = {
      repoFullName: 'owner/repo',
      isArchived: false,
      latestUserMsgId: 'turn-earlier',
    };
    const currentTurn: SessionHistoryInput = {
      id: 'turn-current',
      role: 'user',
      timestamp: '2026-09-08T05:31:00.000Z',
      status: 'pending',
      fileDiff: [],
      items: [{ type: 'text', text: 'and now?' }],
    };
    const earlierTurn: SessionHistoryInput = {
      id: 'turn-earlier',
      role: 'user',
      timestamp: '2026-09-08T05:30:00.000Z',
      status: 'handled',
      fileDiff: [],
      items: [{ type: 'text', text: 'Build this on the two MIT packages.' }],
    };
    const currentAssistant: SessionHistoryInput = {
      id: 'assistant:turn-current',
      role: 'assistant',
      timestamp: '2026-09-08T05:31:01.000Z',
      fileDiff: [],
      items: [{ type: 'text', text: 'Stale output from this turn.' }],
    };
    let history: SessionHistoryInput[] = [currentTurn, currentAssistant];
    let notifyMirror: (() => void) | undefined;
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => meta),
      setStatus: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(() => history),
      updateHistory: vi.fn(
        async (updater: (prev: SessionHistoryInput[]) => SessionHistoryInput[]) => {
          history = updater(history);
        }
      ),
      mirror: {
        subscribe: (listener: () => void) => {
          notifyMirror = listener;
          queueMicrotask(() => {
            history = [earlierTurn, currentTurn, currentAssistant];
            notifyMirror?.();
          });
          return () => {
            notifyMirror = undefined;
          };
        },
      },
      sessionData: {
        history: {
          count: async () => 0,
          readAt: async () => ({ state: 'missing' as const }),
          readTurn: async () => ({ state: 'missing' as const }),
          readRange: async () => [],
          readDirectory: async () => [],
          observe: () => ({ initial: Promise.resolve([]), unsubscribe: () => {} }),
        },
        commands: {},
        durability: { waitDurable: async () => {} },
      },
    });
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({})),
      currentModel: undefined,
    };
    const createdSession = {
      sessionId: 'session-late-history-create' as SessionId,
      acpSessionId: 'acp-created' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getGitHubCredentials: () => nativeSessionCredentials,
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-created'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const buildAcpPromptBlocks = vi.fn(async (args: { replayPromptText?: string }) => [
      { type: 'text' as const, text: args.replayPromptText ?? '' },
    ]);
    const deps = createBaseDeps({
      sessionManager: {
        getSession: vi.fn(() => null),
        getPendingSession: vi.fn(() => null),
        createSession: vi.fn(async () => createdSession as unknown),
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
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
      buildAcpPromptBlocks,
    });

    const service = new SessionExecutionService(deps);
    await service.startSession({
      type: 'session/create',
      sessionId: 'session-late-history-create' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: { kind: 'github', repoFullName: 'owner/repo', branch: 'main' },
      acpSessionConfig: { prompt: 'and now?', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-current',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(buildAcpPromptBlocks).toHaveBeenCalledWith(
      expect.objectContaining({
        replayPromptText: expect.stringContaining('Build this on the two MIT packages.'),
      })
    );
  });

  it('does not read history for a brand-new create turn', async () => {
    const currentTurn: SessionHistoryInput = {
      id: 'turn-current',
      role: 'user',
      timestamp: '2026-09-08T05:31:00.000Z',
      status: 'pending',
      fileDiff: [],
      items: [{ type: 'text', text: 'hello' }],
    };
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => ({ repoFullName: 'owner/repo', isArchived: false })),
      setStatus: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(() => [currentTurn]),
      updateHistory: vi.fn(async () => {}),
    });
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({})),
      currentModel: undefined,
    };
    const createdSession = {
      sessionId: 'session-brand-new' as SessionId,
      acpSessionId: 'acp-brand-new' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getGitHubCredentials: () => nativeSessionCredentials,
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-brand-new'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const buildAcpPromptBlocks = vi.fn(async () => [{ type: 'text', text: 'built' }] as any);
    const deps = createBaseDeps({
      sessionManager: {
        getSession: vi.fn(() => null),
        getPendingSession: vi.fn(() => null),
        createSession: vi.fn(async () => createdSession as unknown),
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
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
      buildAcpPromptBlocks,
    });

    const service = new SessionExecutionService(deps);
    await service.startSession({
      type: 'session/create',
      sessionId: 'session-brand-new' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: { kind: 'github', repoFullName: 'owner/repo', branch: 'main' },
      acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-current',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(buildAcpPromptBlocks).toHaveBeenCalledWith(
      expect.objectContaining({ replayPromptText: undefined })
    );
  });

  it('continues without replay when expected create history cannot be read', async () => {
    const currentTurn: SessionHistoryInput = {
      id: 'turn-current',
      role: 'user',
      timestamp: '2026-09-08T05:31:00.000Z',
      status: 'pending',
      fileDiff: [],
      items: [{ type: 'text', text: 'and now?' }],
    };
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => ({
        repoFullName: 'owner/repo',
        isArchived: false,
        lastHandledUserMsgId: 'turn-earlier',
      })),
      setStatus: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(() => [currentTurn]),
      updateHistory: vi.fn(async () => {}),
    });
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({})),
      currentModel: undefined,
    };
    const createdSession = {
      sessionId: 'session-history-unavailable' as SessionId,
      acpSessionId: 'acp-history-unavailable' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getGitHubCredentials: () => nativeSessionCredentials,
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-history-unavailable'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const createSession = vi.fn(async () => createdSession as unknown);
    const buildAcpPromptBlocks = vi.fn(async () => [{ type: 'text' as const, text: 'and now?' }]);
    const deps = createBaseDeps({
      sessionManager: {
        getSession: vi.fn(() => null),
        getPendingSession: vi.fn(() => null),
        createSession,
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
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
      buildAcpPromptBlocks,
    });

    const service = new SessionExecutionService(deps);
    vi.spyOn(
      service as unknown as {
        waitForReplayableHistory: (...args: unknown[]) => Promise<unknown>;
      },
      'waitForReplayableHistory'
    ).mockRejectedValue(new Error('history unavailable'));

    await service.startSession({
      type: 'session/create',
      sessionId: 'session-history-unavailable' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: { kind: 'github', repoFullName: 'owner/repo', branch: 'main' },
      acpSessionConfig: { prompt: 'and now?', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-current',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(buildAcpPromptBlocks).toHaveBeenCalledWith(
      expect.objectContaining({ replayPromptText: undefined })
    );
    expect(agentClient.prompt).toHaveBeenCalledWith(
      'acp-history-unavailable',
      [{ type: 'text', text: 'and now?' }],
      { signal: expect.any(AbortSignal) }
    );
    expect(deps.recordChatFailure).not.toHaveBeenCalled();
  });

  it('waits for late-syncing history before replacing an unresumable ACP session', async () => {
    // Reproduces the daemon-restart race: the turn is delivered over RPC before
    // the history CRDT catches up, so the first read sees only the new turn.
    // Replacing the agent against that read would answer as if the earlier
    // conversation never happened.
    const meta = { repoFullName: 'owner/repo', isArchived: false };
    const currentTurn: SessionHistoryInput = {
      id: 'turn-current',
      role: 'user',
      timestamp: '2026-09-08T05:31:00.000Z',
      status: 'pending',
      fileDiff: [],
      items: [{ type: 'text', text: 'and now?' }],
    };
    const earlierTurn: SessionHistoryInput = {
      id: 'turn-earlier',
      role: 'user',
      timestamp: '2026-09-08T05:30:00.000Z',
      status: 'handled',
      fileDiff: [],
      items: [{ type: 'text', text: 'Build this on the two MIT packages.' }],
    };
    let history: SessionHistoryInput[] = [currentTurn];
    let notifyMirror: (() => void) | undefined;
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => meta),
      setStatus: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(() => history),
      updateHistory: vi.fn(
        async (updater: (prev: SessionHistoryInput[]) => SessionHistoryInput[]) => {
          history = updater(history);
        }
      ),
      mirror: {
        subscribe: (listener: () => void) => {
          notifyMirror = listener;
          // Deliver the backlog on the next microtask, the way a room join
          // does — no timers, so the wait resolves on the signal alone.
          queueMicrotask(() => {
            history = [earlierTurn, currentTurn];
            notifyMirror?.();
          });
          return () => {
            notifyMirror = undefined;
          };
        },
      },
      // `subscribeSessionChanges` needs the session-data surface; the fake drives
      // the late-sync signal through the raw Mirror's subscribe.
      sessionData: {
        history: {
          count: async () => 0,
          readAt: async () => ({ state: 'missing' as const }),
          readTurn: async () => ({ state: 'missing' as const }),
          readRange: async () => [],
          readDirectory: async () => [],
          observe: () => ({ initial: Promise.resolve([]), unsubscribe: () => {} }),
        },
        commands: {},
        durability: { waitDurable: async () => {} },
      },
    });
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({})),
      currentModel: undefined,
    };
    const restoredSession = {
      sessionId: 'session-late-history' as SessionId,
      acpSessionId: 'acp-replacement' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getGitHubCredentials: () => nativeSessionCredentials,
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-replacement'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const createSession = vi
      .fn(async () => restoredSession as unknown)
      .mockImplementationOnce(async () => {
        throw new Error('[ACP_RESUME_FAILED] loadSession: session artifact missing');
      });
    const buildAcpPromptBlocks = vi.fn(async () => [{ type: 'text', text: 'built prompt' }] as any);
    const deps = createBaseDeps({
      sessionManager: {
        getSession: vi.fn(() => null),
        getPendingSession: vi.fn(() => null),
        createSession,
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
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
      buildAcpPromptBlocks,
    });

    const service = new SessionExecutionService(deps);
    await service.continueSession({
      type: 'session/chat',
      sessionId: 'session-late-history' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: { kind: 'github', repoFullName: 'owner/repo', branch: 'main' },
      acpSessionConfig: {
        prompt: 'and now?',
        cliType: 'builtin',
        agentType: 'codex',
        resume: 'acp-existing' as ACPSessionId,
      },
      userTurnId: 'turn-current',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(createSession).toHaveBeenCalledTimes(2);
    expect(deps.recordChatFailure).not.toHaveBeenCalled();
    expect(buildAcpPromptBlocks).toHaveBeenCalledWith(
      expect.objectContaining({
        replayPromptText: expect.stringContaining('Build this on the two MIT packages.'),
      })
    );
    expect(agentClient.prompt).toHaveBeenCalledWith(
      'acp-replacement',
      [{ type: 'text', text: 'built prompt' }],
      { signal: expect.any(AbortSignal) }
    );
  });

  it('resumes a worktree without resolving its deleted recorded base branch', async () => {
    const rootPath = createGitLocalProject();
    runGit(rootPath, ['remote', 'add', 'origin', 'https://github.com/example/project.git']);
    const remoteCommit = runGit(rootPath, ['rev-parse', 'main']);
    runGit(rootPath, ['update-ref', 'refs/remotes/origin/remote-base', remoteCommit]);
    runGit(rootPath, ['checkout', '-b', 'lody-session-restore', 'refs/remotes/origin/remote-base']);
    fs.writeFileSync(path.join(rootPath, 'session-change.txt'), 'session change\n', 'utf8');
    runGit(rootPath, ['add', 'session-change.txt']);
    runGit(rootPath, ['commit', '-m', 'session change']);
    runGit(rootPath, ['update-ref', 'refs/remotes/origin/foo', remoteCommit]);
    runGit(rootPath, ['checkout', '--track', '-b', 'other', 'refs/remotes/origin/foo']);
    runGit(rootPath, ['update-ref', '-d', 'refs/remotes/origin/remote-base']);
    const localProjectId = 'local-project-restore' as LocalProjectId;
    const project = {
      kind: 'local' as const,
      localProjectId,
      branch: 'remote-base',
      githubRepoFullName: 'example/project',
      useWorktree: true,
    };
    const meta = {
      project,
      baseBranch: 'refs/remotes/origin/remote-base',
      branchName: 'lody-session-restore',
      acpSessionId: 'acp-local-restore' as ACPSessionId,
      isWorktree: true,
      isArchived: false,
    };
    let history: unknown[] = [];
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => meta),
      setStatus: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(() => history),
      updateHistory: vi.fn(async (updater: (prev: unknown[]) => unknown[]) => {
        history = updater(history);
      }),
    });
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({})),
      currentModel: undefined,
    };
    const restoredSession = {
      sessionId: 'session-local-restore' as SessionId,
      acpSessionId: 'acp-local-restore' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => rootPath,
      getGitHubCredentials: () => nativeSessionCredentials,
      getHostWorkdir: () => rootPath,
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-local-restore'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const createSession = vi.fn(async (config) => {
      expect(config.workdir).toBe(rootPath);
      expect(config.branch).toBe('remote-base');
      expect(config.resume).toBe(true);
      expect(runGit(rootPath, ['symbolic-ref', '--short', 'HEAD'])).toBe('other');
      return restoredSession as unknown;
    });
    const upsertDocMeta = vi.fn(async () => {});
    const deps = createBaseDeps({
      sessionManager: {
        getSession: vi.fn(() => null),
        getPendingSession: vi.fn(() => null),
        createSession,
        setSessionError: vi.fn(),
        terminateSession: vi.fn(),
        validateSessionCredentials: vi.fn(async () => {}),
      } as unknown as SessionManager,
      workspaceDocument: {
        repo: {
          upsertDocMeta,
          getDocMeta: vi.fn(async () => ({
            meta: {
              localProjects: {
                [localProjectId]: {
                  id: localProjectId,
                  name: 'Local Project',
                  rootPath,
                  createdAtMs: 1,
                },
              },
            },
          })),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
      buildAcpPromptBlocks: vi.fn(async () => [{ type: 'text', text: 'continue' }] as any),
    });

    const service = new SessionExecutionService(deps);
    await service.continueSession({
      type: 'session/chat',
      sessionId: 'session-local-restore' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project,
      acpSessionConfig: { prompt: 'continue', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-local-restore',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(createSession).toHaveBeenCalledOnce();
    expect(sessionDoc.setBaseBranch).not.toHaveBeenCalled();
    expect(upsertDocMeta).not.toHaveBeenCalledWith(
      'session-session-local-restore',
      expect.objectContaining({ baseBranch: expect.anything() })
    );
  });

  it('resumes a non-worktree local project on its current dirty branch without checkout', async () => {
    const rootPath = createGitLocalProject();
    runGit(rootPath, ['remote', 'add', 'origin', 'https://github.com/example/project.git']);
    const remoteCommit = runGit(rootPath, ['rev-parse', 'main']);
    runGit(rootPath, ['update-ref', 'refs/remotes/origin/foo', remoteCommit]);
    runGit(rootPath, ['checkout', '--track', '-b', 'session-branch', 'refs/remotes/origin/foo']);
    runGit(rootPath, ['checkout', 'main']);
    fs.writeFileSync(path.join(rootPath, 'README.md'), 'dirty local change\n', 'utf8');

    const localProjectId = 'local-project-tracking-restore' as LocalProjectId;
    const project = {
      kind: 'local' as const,
      localProjectId,
      branch: 'foo',
      githubRepoFullName: 'example/project',
      useWorktree: false,
    };
    let meta = {
      project,
      baseBranch: 'foo',
      branchName: 'session-branch',
      acpSessionId: 'acp-local-tracking-restore' as ACPSessionId,
      isWorktree: false,
      isArchived: false,
    };
    let history: unknown[] = [];
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => meta),
      setStatus: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(() => history),
      updateHistory: vi.fn(async (updater: (prev: unknown[]) => unknown[]) => {
        history = updater(history);
      }),
    });
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({})),
      currentModel: undefined,
    };
    const restoredSession = {
      sessionId: 'session-local-tracking-restore' as SessionId,
      acpSessionId: 'acp-local-tracking-restore' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => rootPath,
      getGitHubCredentials: () => nativeSessionCredentials,
      getHostWorkdir: () => rootPath,
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-local-tracking-restore'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const createSession = vi.fn(async (config) => {
      expect(config.workdir).toBe(rootPath);
      expect(config.branch).toBe('foo');
      expect(config.resume).toBe(true);
      expect(runGit(rootPath, ['symbolic-ref', '--short', 'HEAD'])).toBe('main');
      expect(fs.readFileSync(path.join(rootPath, 'README.md'), 'utf8')).toBe(
        'dirty local change\n'
      );
      return restoredSession as unknown;
    });
    const upsertDocMeta = vi.fn(async (_roomId: string, patch: Record<string, unknown>) => {
      meta = { ...meta, ...patch };
    });
    const persistPendingChanges = vi.fn(async () => {});
    const deps = createBaseDeps({
      sessionManager: {
        getSession: vi.fn(() => null),
        getPendingSession: vi.fn(() => null),
        createSession,
        setSessionError: vi.fn(),
        terminateSession: vi.fn(),
        validateSessionCredentials: vi.fn(async () => {}),
      } as unknown as SessionManager,
      workspaceDocument: {
        repo: {
          upsertDocMeta,
          getDocMeta: vi.fn(async () => ({
            meta: {
              localProjects: {
                [localProjectId]: {
                  id: localProjectId,
                  name: 'Local Project',
                  rootPath,
                  createdAtMs: 1,
                },
              },
            },
          })),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
        persistPendingChanges,
      } as unknown as LoroDocumentManager,
      buildAcpPromptBlocks: vi.fn(async () => [{ type: 'text', text: 'continue' }] as any),
    });

    const service = new SessionExecutionService(deps);
    await service.continueSession({
      type: 'session/chat',
      sessionId: 'session-local-tracking-restore' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project,
      acpSessionConfig: { prompt: 'continue', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-local-tracking-restore',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(createSession).toHaveBeenCalledOnce();
    expect(sessionDoc.setBaseBranch).not.toHaveBeenCalled();
    expect(upsertDocMeta).not.toHaveBeenCalledWith(
      'session-session-local-tracking-restore',
      expect.objectContaining({ baseBranch: expect.anything() })
    );
    expect(persistPendingChanges).not.toHaveBeenCalledWith('session-local-base-ref');
  });

  it('releases ACP replay suppression when a restore turn is interrupted before prompt', async () => {
    let createStarted!: () => void;
    const createStartedPromise = new Promise<void>((resolve) => {
      createStarted = resolve;
    });
    let resolveCreateSession!: (session: unknown) => void;
    const createSessionPromise = new Promise<unknown>((resolve) => {
      resolveCreateSession = resolve;
    });
    let meta: Record<string, unknown> = {};
    const upsertDocMeta = vi.fn(async (_roomId: string, patch: Record<string, unknown>) => {
      meta = { ...meta, ...patch };
    });
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => ({
        repoFullName: 'owner/repo',
        acpSessionId: 'acp-restore-interrupt' as ACPSessionId,
        isArchived: false,
      })),
      setStatus: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(() => []),
      updateHistory: vi.fn(async () => {}),
      roomId: 'session-session-restore-interrupt',
    });
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({})),
      currentModel: undefined,
    };
    const restoredSession = {
      sessionId: 'session-restore-interrupt' as SessionId,
      acpSessionId: 'acp-restore-interrupt' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getGitHubCredentials: () => nativeSessionCredentials,
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-restore-interrupt'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const sessionManager = {
      getSession: vi.fn(() => null),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(() => {
        createStarted();
        return createSessionPromise;
      }),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      validateSessionCredentials: vi.fn(async () => {}),
    } as unknown as SessionManager;
    const deps = createBaseDeps({
      sessionManager,
      beginConversationTurn: vi.fn(() => 'assistant-restore-interrupt'),
      workspaceDocument: {
        repo: {
          upsertDocMeta,
          getDocMeta: vi.fn(async () => ({
            meta,
          })),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
      processMessageQueue: vi.fn(async () => {}),
    });

    const service = new SessionExecutionService(deps);
    const continuePromise = service.continueSession({
      type: 'session/chat',
      sessionId: 'session-restore-interrupt' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: { kind: 'github', repoFullName: 'owner/repo', branch: 'main' },
      acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-restore-interrupt',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    await createStartedPromise;
    expect(deps.beginACPReplaySuppression).toHaveBeenCalledTimes(1);

    await expect(
      service.cancelSession({
        type: 'session/cancel',
        sessionId: 'session-restore-interrupt' as SessionId,
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        turnId: 'assistant-restore-interrupt',
      })
    ).resolves.toEqual({ success: true });
    await continuePromise;

    expect(deps.endACPReplaySuppression).toHaveBeenCalledTimes(1);
    expect(agentClient.prompt).not.toHaveBeenCalled();
    expect(deps.processMessageQueue).not.toHaveBeenCalled();

    resolveCreateSession(restoredSession);
    await vi.waitFor(() => {
      expect(restoredSession.terminate).toHaveBeenCalledWith(true);
    });
  });

  it('creates and starts a new session turn', async () => {
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => undefined),
      getHistory: vi.fn(() => []),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      updateHistory: vi.fn(async () => {}),
      roomId: 'session-session-2',
    });
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({})),
      currentModel: undefined,
    };
    const createdSession = {
      sessionId: 'session-2' as SessionId,
      acpSessionId: 'acp-2' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getGitHubCredentials: () => nativeSessionCredentials,
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-2'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const sessionManager = {
      getSession: vi.fn(() => null),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(async () => createdSession as unknown),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      validateSessionCredentials: vi.fn(async () => {}),
    } as unknown as SessionManager;
    const upsertDocMeta = vi.fn(async () => {});
    const deps = createBaseDeps({
      sessionManager,
      workspaceDocument: {
        repo: {
          upsertDocMeta,
          getDocMeta: vi.fn(async () => undefined),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
      buildAcpPromptBlocks: vi.fn(async () => [{ type: 'text', text: 'built prompt' }] as any),
    });

    const service = new SessionExecutionService(deps);
    await service.startSession({
      type: 'session/create',
      sessionId: 'session-2' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: { kind: 'github', repoFullName: 'owner/repo', branch: 'main' },
      acpSessionConfig: {
        // Execution prompt carries Config/Role instructions; the blocks keep the authored task.
        prompt: 'CONFIG_INSTRUCTION\n\nROLE_INSTRUCTION\n\nhello',
        inputBlocks: [{ type: 'text', text: 'hello' }],
        cliType: 'builtin',
        agentType: 'codex',
      },
      userTurnId: 'turn-create-1',
      userId: 'user-2',
      userName: 'User 2',
      userEmail: 'user2@example.com',
      parentSessionId: 'parent-session-2' as SessionId,
    });

    expect(sessionManager.createSession).toHaveBeenCalledTimes(1);
    // The local title generator names the authored task, never the composed instructions.
    expect(deps.maybeGenerateAndStoreSessionTitle).toHaveBeenCalledWith(
      'session-2',
      'builtin',
      'codex',
      'hello',
      undefined,
      undefined,
      undefined
    );
    expect(sessionManager.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionId: 'parent-session-2',
        requesterUserId: 'user-2',
      })
    );
    expect(sessionDoc.setStatus.mock.calls.map(([status]) => status).slice(0, 3)).toEqual([
      SessionStatusFactory.initializing(),
      SessionStatusFactory.initializing('git-clone'),
      SessionStatusFactory.running(),
    ]);
    expect(agentClient.prompt).toHaveBeenCalledWith(
      'acp-2',
      [{ type: 'text', text: 'built prompt' }],
      { signal: expect.any(AbortSignal) }
    );
    expect(deps.turnFinalization.onTurnOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-2',
        scope: { workspaceId: 'workspace-1', recipientId: 'user-2' },
        assistantTurnId: 'turn-1',
        outcome: { kind: 'succeeded' },
      })
    );
    expect(deps.startSessionActivePresence).toHaveBeenCalledTimes(1);
    expect(deps.startSessionActivePresence).toHaveBeenCalledWith('session-2', 'initializing');
    expect(deps.clearSessionActivePresence).toHaveBeenCalledTimes(1);
    expect(sessionDoc.setStatus).toHaveBeenCalledWith(
      SessionStatusFactory.initializing(),
      expect.objectContaining({
        latestUserMsgId: 'turn-create-1',
        baseBranch: 'main',
      })
    );
    expect(upsertDocMeta).toHaveBeenCalledWith('session-session-2', {
      processingUserMsgId: 'turn-create-1',
    });
    expect(upsertDocMeta).toHaveBeenCalledWith('session-session-2', {
      lastHandledUserMsgId: 'turn-create-1',
      processingUserMsgId: undefined,
    });
  });

  it('checks out the requested local project branch on the target machine before creating a session', async () => {
    const rootPath = createGitLocalProject();
    const localProjectId = 'local-project-branch' as LocalProjectId;
    const project = {
      kind: 'local' as const,
      localProjectId,
      branch: 'feature/remote-local',
    };
    const sessionDoc = withHistoryPort({
      // This is the metadata createSessionResult writes before it dispatches
      // session/create. It identifies the project but has no ACP session yet.
      getMetaState: vi.fn(async () => ({
        id: 'session-local-project-branch' as SessionId,
        machineId: 'machine-1' as MachineId,
        createdAt: '2026-08-24T00:00:00.000Z',
        userId: 'user-1',
        status: SessionStatusFactory.idle(),
        isArchived: false,
        cliType: 'builtin' as const,
        agentType: 'codex' as const,
        agentConfigId: capabilityConfigId,
        project,
        latestUserMsgId: 'turn-local-branch',
      })),
      getHistory: vi.fn(() => []),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      updateHistory: vi.fn(async () => {}),
      roomId: 'session-local-project-branch',
    });
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({})),
      currentModel: undefined,
    };
    const createdSession = {
      sessionId: 'session-local-project-branch' as SessionId,
      acpSessionId: 'acp-local-project-branch' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => rootPath,
      getGitHubCredentials: () => nativeSessionCredentials,
      getHostWorkdir: () => rootPath,
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-local-project-branch'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const createSession = vi.fn(async (config) => {
      expect(config.workdir).toBe(rootPath);
      expect(config.branch).toBe('feature/remote-local');
      expect(runGit(rootPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('feature/remote-local');
      return createdSession as unknown;
    });
    const upsertDocMeta = vi.fn(async (_roomId: string, patch: Record<string, unknown>) => {
      if (patch.baseBranch === 'refs/heads/feature/remote-local') {
        expect(runGit(rootPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
      }
    });
    const persistPendingChanges = vi.fn(async () => {
      expect(runGit(rootPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
    });
    const deps = createBaseDeps({
      sessionManager: {
        getSession: vi.fn(() => null),
        getPendingSession: vi.fn(() => null),
        createSession,
        setSessionError: vi.fn(),
        terminateSession: vi.fn(),
        validateSessionCredentials: vi.fn(async () => {}),
      } as unknown as SessionManager,
      workspaceDocument: {
        repo: {
          upsertDocMeta,
          getDocMeta: vi.fn(async () => ({
            meta: {
              localProjects: {
                [localProjectId]: {
                  id: localProjectId,
                  name: 'Local Project',
                  rootPath,
                  createdAtMs: 1,
                },
              },
            },
          })),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        getOrOpenSessionCode: vi.fn(async () => null),
        updateAcpCapabilities: vi.fn(async () => {}),
        persistPendingChanges,
      } as unknown as LoroDocumentManager,
      buildAcpPromptBlocks: vi.fn(async () => [{ type: 'text', text: 'hello' }] as any),
    });

    const service = new SessionExecutionService(deps);
    await service.startSession({
      type: 'session/create',
      sessionId: 'session-local-project-branch' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project,
      acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-local-branch',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(sessionDoc.setStatus).toHaveBeenCalledWith(
      SessionStatusFactory.initializing(),
      expect.not.objectContaining({ baseBranch: expect.anything() })
    );
    expect(upsertDocMeta).toHaveBeenCalledWith('session-session-local-project-branch', {
      baseBranch: 'refs/heads/feature/remote-local',
    });
    expect(persistPendingChanges).toHaveBeenCalledWith('session-local-base-ref');
    expect(deps.recordChatFailure).not.toHaveBeenCalled();
  });

  it('does not reuse a diverged tracking branch for a new local project session', async () => {
    const rootPath = createGitLocalProject();
    runGit(rootPath, ['remote', 'add', 'origin', 'https://github.com/example/project.git']);
    const remoteCommit = runGit(rootPath, ['rev-parse', 'main']);
    runGit(rootPath, ['update-ref', 'refs/remotes/origin/foo', remoteCommit]);
    runGit(rootPath, ['checkout', '--track', '-b', 'foo', 'refs/remotes/origin/foo']);
    fs.writeFileSync(path.join(rootPath, 'old-session.txt'), 'old session\n', 'utf8');
    runGit(rootPath, ['add', 'old-session.txt']);
    runGit(rootPath, ['commit', '-m', 'old session']);

    const localProjectId = 'local-project-diverged-tracking' as LocalProjectId;
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => undefined),
      getHistory: vi.fn(() => []),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      updateHistory: vi.fn(async () => {}),
      roomId: 'session-local-project-diverged-tracking',
    });
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({})),
      currentModel: undefined,
    };
    const createdSession = {
      sessionId: 'session-local-project-diverged-tracking' as SessionId,
      acpSessionId: 'acp-local-project-diverged-tracking' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => rootPath,
      getGitHubCredentials: () => nativeSessionCredentials,
      getHostWorkdir: () => rootPath,
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-local-project-diverged-tracking'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const createSession = vi.fn(async (config) => {
      expect(config.branch).not.toBe('foo');
      expect(runGit(rootPath, ['rev-parse', 'HEAD'])).toBe(remoteCommit);
      expect(fs.existsSync(path.join(rootPath, 'old-session.txt'))).toBe(false);
      return createdSession as unknown;
    });
    const persistPendingChanges = vi.fn(async () => {
      expect(runGit(rootPath, ['symbolic-ref', '--short', 'HEAD'])).toBe('foo');
    });
    const deps = createBaseDeps({
      sessionManager: {
        getSession: vi.fn(() => null),
        getPendingSession: vi.fn(() => null),
        createSession,
        setSessionError: vi.fn(),
        terminateSession: vi.fn(),
        validateSessionCredentials: vi.fn(async () => {}),
      } as unknown as SessionManager,
      workspaceDocument: {
        repo: {
          upsertDocMeta: vi.fn(async () => {}),
          getDocMeta: vi.fn(async () => ({
            meta: {
              localProjects: {
                [localProjectId]: {
                  id: localProjectId,
                  name: 'Local Project',
                  rootPath,
                  createdAtMs: 1,
                },
              },
            },
          })),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        getOrOpenSessionCode: vi.fn(async () => null),
        updateAcpCapabilities: vi.fn(async () => {}),
        persistPendingChanges,
      } as unknown as LoroDocumentManager,
      buildAcpPromptBlocks: vi.fn(async () => [{ type: 'text', text: 'hello' }] as any),
    });

    const service = new SessionExecutionService(deps);
    await service.startSession({
      type: 'session/create',
      sessionId: 'session-local-project-diverged-tracking' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: {
        kind: 'local',
        localProjectId,
        branch: 'lody:branch:remote:origin:foo',
      },
      acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-local-diverged-tracking',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(createSession).toHaveBeenCalledOnce();
    expect(persistPendingChanges).toHaveBeenCalledWith('session-local-base-ref');
    expect(deps.recordChatFailure).not.toHaveBeenCalled();
  });

  it('fails a local project branch switch on a dirty target worktree', async () => {
    const rootPath = createGitLocalProject();
    fs.writeFileSync(path.join(rootPath, 'dirty.txt'), 'dirty\n', 'utf8');
    const localProjectId = 'local-project-dirty' as LocalProjectId;
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => undefined),
      getHistory: vi.fn(() => []),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      updateHistory: vi.fn(async () => {}),
      roomId: 'session-local-project-dirty',
    });
    const createSession = vi.fn();
    const deps = createBaseDeps({
      sessionManager: {
        getSession: vi.fn(() => null),
        getPendingSession: vi.fn(() => null),
        createSession,
        setSessionError: vi.fn(),
        terminateSession: vi.fn(),
        validateSessionCredentials: vi.fn(async () => {}),
      } as unknown as SessionManager,
      workspaceDocument: {
        repo: {
          upsertDocMeta: vi.fn(async () => {}),
          getDocMeta: vi.fn(async () => ({
            meta: {
              localProjects: {
                [localProjectId]: {
                  id: localProjectId,
                  name: 'Dirty Local Project',
                  rootPath,
                  createdAtMs: 1,
                },
              },
            },
          })),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        getOrOpenSessionCode: vi.fn(async () => null),
        updateAcpCapabilities: vi.fn(async () => {}),
        persistPendingChanges: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
    });

    const service = new SessionExecutionService(deps);
    await service.startSession({
      type: 'session/create',
      sessionId: 'session-local-project-dirty' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: { kind: 'local', localProjectId, branch: 'feature/remote-local' },
      acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-local-dirty',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(createSession).not.toHaveBeenCalled();
    expect(deps.recordChatFailure).toHaveBeenCalledWith(
      sessionDoc,
      'turn_pre_prompt_failed',
      expect.stringContaining('Cannot switch branches with local changes')
    );
  });
});
