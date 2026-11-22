import { nativeSessionCredentials } from '@/session/session-credentials';
import {
  RequestError,
  type ContentBlock,
  type PromptRequest,
  type PromptResponse,
} from '@agentclientprotocol/sdk';
import {
  SessionStatusFactory,
  type ACPSessionId,
  type ChatFailedReason,
  type LocalProjectId,
  type MachineId,
  type SessionHistoryInput,
  type SessionId,
  type SessionStatus,
  type WorkspaceId,
} from '@lody/shared';
import { type TurnOutcomeFact } from '@lody/shared/notifications';
import { Effect, Fiber } from 'effect';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AcpStartupProcessError } from '../src/agent/acp-startup-monitor';
import { AcpAuthenticationRequiredError, AgentClient } from '../src/agent/agent-client';
import { markAssistantTurnFinished } from '../src/lib/assistant-turn-finalize';
import { SessionDocument, type LoroDocumentManager } from '../src/lib/loro/doc';
import { SessionActivePresenceControllerLegacy } from '../src/lib/loro/session-active-presence-legacy';
import { applyAcpSessionRunConfig } from '../src/session/acp-session-config-applier';
import { Session } from '../src/session/session';
import { SessionEditAndResendService } from '../src/session/session-edit-and-resend-service';
import { SessionExecutionService } from '../src/session/session-execution-service';
import type { SessionManager } from '../src/session/session-manager';
import {
  recordIncompleteStartCleanup,
  type SessionStartStage,
} from '../src/session/session-start-stage';
import type { SessionConfig } from '../src/session/types';
import { GitExecutableNotFoundError } from '../src/session/worktree/git-process-error';
import { withHistoryPort } from './history-port-fixture';
import { composeTestSessionDoc } from './session-doc-fixture';
import {
  cancelCompletions,
  createBaseDeps,
  createDeferred,
  createGitLocalProject,
  createRetryFixture,
  createSilentLogger,
  MessagelessStartFailure,
  PRIOR_CONVERSATION_HISTORY,
  runGit,
  temporarySpawnFailure,
} from './session-execution-service-helpers';

vi.hoisted(() => {
  Object.assign(globalThis, { __LODY_E2E_DAEMON_LOSS__: true });
  process.env.LODY_E2E = '1';
});
describe('SessionExecutionService', () => {
  it('uses the current dirty branch when initializing an existing direct local session', async () => {
    const rootPath = createGitLocalProject();
    fs.writeFileSync(path.join(rootPath, 'dirty.txt'), 'dirty\n', 'utf8');
    const localProjectId = 'local-project-existing-dirty' as LocalProjectId;
    const project = {
      kind: 'local' as const,
      localProjectId,
      branch: 'feature/remote-local',
    };
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => ({
        project,
        acpSessionId: 'acp-local-project-existing-dirty' as ACPSessionId,
      })),
      getHistory: vi.fn(() => []),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      updateHistory: vi.fn(async () => {}),
      roomId: 'session-local-project-existing-dirty',
    });
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({})),
      currentModel: undefined,
    };
    const createdSession = {
      sessionId: 'session-local-project-existing-dirty' as SessionId,
      acpSessionId: 'acp-local-project-existing-dirty' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => rootPath,
      getGitHubCredentials: () => nativeSessionCredentials,
      getHostWorkdir: () => rootPath,
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-local-project-existing-dirty'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const createSession = vi.fn(async (config) => {
      expect(config.project).toEqual({ kind: 'local', localProjectId });
      expect(config.branch).toBeUndefined();
      expect(runGit(rootPath, ['symbolic-ref', '--short', 'HEAD'])).toBe('main');
      expect(fs.readFileSync(path.join(rootPath, 'dirty.txt'), 'utf8')).toBe('dirty\n');
      return createdSession as unknown;
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
                  name: 'Existing Dirty Local Project',
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
      } as unknown as LoroDocumentManager,
    });

    const service = new SessionExecutionService(deps);
    await service.startSession({
      type: 'session/create',
      sessionId: 'session-local-project-existing-dirty' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project,
      acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-local-existing-dirty',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(createSession).toHaveBeenCalledOnce();
    expect(deps.recordChatFailure).not.toHaveBeenCalled();
    expect(runGit(rootPath, ['symbolic-ref', '--short', 'HEAD'])).toBe('main');
    expect(fs.readFileSync(path.join(rootPath, 'dirty.txt'), 'utf8')).toBe('dirty\n');
  });

  it('records an actionable diagnostic when Git is unavailable for a GitHub worktree', async () => {
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => undefined),
      getHistory: vi.fn(() => []),
      setStatus: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      updateHistory: vi.fn(async () => {}),
      roomId: 'session-github-git-missing',
    });
    const gitError = new GitExecutableNotFoundError(
      Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })
    );
    const createSession = vi.fn(async () => {
      throw new Error('[github---owner---repo] Failed to clone bare repository', {
        cause: gitError,
      });
    });
    const deps = createBaseDeps({
      sessionManager: {
        getSession: vi.fn(() => null),
        getPendingSession: vi.fn(() => null),
        createSession,
        setSessionError: vi.fn(async () => {}),
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
    });

    const service = new SessionExecutionService(deps);
    await service.startSession({
      type: 'session/create',
      sessionId: 'session-github-git-missing' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: { kind: 'github', repoFullName: 'owner/repo', branch: 'main' },
      acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-github-git-missing',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(deps.recordChatFailure).toHaveBeenCalledWith(
      sessionDoc,
      'turn_pre_prompt_failed',
      '[github---owner---repo] Failed to clone bare repository',
      'git_executable_not_found'
    );
    expect(deps.buildAcpPromptBlocks).not.toHaveBeenCalled();
  });

  it('fails a local project worktree when the requested base branch no longer exists', async () => {
    const rootPath = createGitLocalProject();
    const localProjectId = 'local-project-missing-worktree-branch' as LocalProjectId;
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => undefined),
      getHistory: vi.fn(() => []),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      updateHistory: vi.fn(async () => {}),
      roomId: 'session-local-project-missing-worktree-branch',
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
      } as unknown as LoroDocumentManager,
    });

    const service = new SessionExecutionService(deps);
    await service.startSession({
      type: 'session/create',
      sessionId: 'session-local-project-missing-worktree-branch' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: {
        kind: 'local',
        localProjectId,
        branch: 'feature/deleted',
        useWorktree: true,
      },
      acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-local-missing-worktree-branch',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(createSession).not.toHaveBeenCalled();
    expect(deps.recordChatFailure).toHaveBeenCalledWith(
      sessionDoc,
      'turn_pre_prompt_failed',
      expect.stringContaining('Local project branch not found: feature/deleted')
    );
  });

  it('does not prompt a startSession turn that was cancelled before the first prompt runs', async () => {
    const upsertDocMeta = vi.fn(async () => {});
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => undefined),
      getHistory: vi.fn(() => [
        {
          id: 'turn-create-cancelled',
          role: 'user',
          timestamp: new Date().toISOString(),
          status: 'canceled',
          read: true,
          userId: 'user-2',
          items: [{ type: 'text', text: 'hello' }],
          fileDiff: [],
        },
      ]),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      updateHistory: vi.fn(async () => {}),
      roomId: 'session-session-create-cancelled',
    });
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({})),
      currentModel: undefined,
    };
    const createdSession = {
      sessionId: 'session-create-cancelled' as SessionId,
      acpSessionId: 'acp-create-cancelled' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getGitHubCredentials: () => nativeSessionCredentials,
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-create-cancelled'),
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
      sessionId: 'session-create-cancelled' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-create-cancelled',
      userId: 'user-2',
      userName: 'User 2',
      userEmail: 'user2@example.com',
    });

    expect(sessionManager.createSession).not.toHaveBeenCalled();
    expect(createdSession.terminate).not.toHaveBeenCalled();
    expect(agentClient.prompt).not.toHaveBeenCalled();
    expect(deps.turnFinalization.finalizeACPState).not.toHaveBeenCalled();
    expect(sessionDoc.setStatus).toHaveBeenCalledWith(SessionStatusFactory.idle());
  });

  it('terminates a pending start session when the owner fiber is interrupted during creation', async () => {
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
      getMetaState: vi.fn(async () => undefined),
      getHistory: vi.fn(() => []),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      updateHistory: vi.fn(async () => {}),
      roomId: 'session-session-create-interrupt',
    });
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({})),
      currentModel: undefined,
    };
    const createdSession = {
      sessionId: 'session-create-interrupt' as SessionId,
      acpSessionId: 'acp-create-interrupt' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getGitHubCredentials: () => nativeSessionCredentials,
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-create-interrupt'),
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
      beginConversationTurn: vi.fn(() => 'assistant-create-interrupt'),
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
      buildAcpPromptBlocks: vi.fn(async () => [{ type: 'text', text: 'built prompt' }] as any),
      processMessageQueue: vi.fn(async () => {}),
    });

    const service = new SessionExecutionService(deps);
    const startPromise = service.startSession({
      type: 'session/create',
      sessionId: 'session-create-interrupt' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-create-interrupt',
      userId: 'user-2',
      userName: 'User 2',
      userEmail: 'user2@example.com',
    });

    await createStartedPromise;
    await expect(
      service.cancelSession({
        type: 'session/cancel',
        sessionId: 'session-create-interrupt' as SessionId,
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        turnId: 'assistant-create-interrupt',
      })
    ).resolves.toEqual({ success: true });
    expect(createdSession.terminate).not.toHaveBeenCalled();

    await startPromise;

    expect(deps.turnFinalization.finalizeACPState).toHaveBeenCalledTimes(1);
    expect(deps.processMessageQueue).not.toHaveBeenCalled();
    expect(upsertDocMeta).toHaveBeenCalledWith('session-session-create-interrupt', {
      lastHandledUserMsgId: 'turn-create-interrupt',
      processingUserMsgId: undefined,
    });

    resolveCreateSession(createdSession);
    await vi.waitFor(() => {
      expect(createdSession.terminate).toHaveBeenCalledWith(true);
    });
    expect(agentClient.prompt).not.toHaveBeenCalled();
  });

  it('releases active presence and marks dispatch failed when start session creation fails', async () => {
    const upsertDocMeta = vi.fn(async () => {});
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => undefined),
      getHistory: vi.fn(() => []),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      updateHistory: vi.fn(async () => {}),
      roomId: 'session-session-create-fail',
    });
    const sessionManager = {
      getSession: vi.fn(() => null),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(async () => {
        throw new Error('docker failed');
      }),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      validateSessionCredentials: vi.fn(async () => {}),
    } as unknown as SessionManager;
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
    });

    const service = new SessionExecutionService(deps);
    await service.startSession({
      type: 'session/create',
      sessionId: 'session-create-fail' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-create-fail',
      userId: 'user-2',
      userName: 'User 2',
      userEmail: 'user2@example.com',
    });

    expect(deps.startSessionActivePresence).toHaveBeenCalledTimes(1);
    expect(deps.clearSessionActivePresence).toHaveBeenCalledTimes(1);
    expect(deps.beginConversationTurn).toHaveBeenCalledTimes(1);
    expect(deps.createAssistantEntryForTurn).toHaveBeenCalledWith(
      'session-create-fail',
      sessionDoc,
      'turn-1',
      undefined,
      'turn-create-fail'
    );
    expect(deps.recordChatFailure).toHaveBeenCalledWith(
      sessionDoc,
      'turn_pre_prompt_failed',
      'docker failed'
    );
    expect(sessionDoc.setStatus).toHaveBeenCalledWith(
      SessionStatusFactory.initializing(),
      expect.objectContaining({ latestUserMsgId: 'turn-create-fail' })
    );
    expect(deps.turnFinalization.finalizeACPState).toHaveBeenCalledTimes(1);
  });

  it('reports authentication required when a first turn cannot create its session', async () => {
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => undefined),
      getHistory: vi.fn(() => []),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      updateHistory: vi.fn(async () => {}),
      roomId: 'session-session-create-auth',
    });
    const sessionManager = {
      getSession: vi.fn(() => null),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(async () => {
        throw new AcpAuthenticationRequiredError([{ id: 'oauth-personal', name: 'Google' }]);
      }),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      validateSessionCredentials: vi.fn(async () => {}),
    } as unknown as SessionManager;
    const deps = createBaseDeps({
      sessionManager,
      workspaceDocument: {
        repo: {
          upsertDocMeta: vi.fn(async () => {}),
          getDocMeta: vi.fn(async () => undefined),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
    });

    const service = new SessionExecutionService(deps);
    await service.startSession({
      type: 'session/create',
      sessionId: 'session-create-auth' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      acpSessionConfig: { prompt: 'hello', cliType: 'registry', agentType: 'antigravity-acp' },
      userTurnId: 'turn-create-auth',
      userId: 'user-2',
      userName: 'User 2',
      userEmail: 'user2@example.com',
    });

    // The generic pre-prompt reason would leave the client with no way to sign in.
    expect(deps.recordChatFailure).toHaveBeenCalledWith(
      sessionDoc,
      'acp_auth_required',
      'Authentication required'
    );
  });

  it.each<{
    name: string;
    error: unknown;
    expectedReason: ChatFailedReason;
    expectedMessage: string;
    expectedCode?: string;
    expectedTerminateForce?: boolean;
    stage?: SessionStartStage;
  }>([
    {
      name: 'JSON-RPC internal error',
      error: new RequestError(-32603, 'Internal error', {
        details: 'workspace routing discovery failed',
      }),
      expectedReason: 'acp_internal_error',
      expectedMessage: 'workspace routing discovery failed',
      expectedTerminateForce: true,
    },
    {
      name: 'authentication required error',
      error: new AcpAuthenticationRequiredError([{ id: 'oauth-personal', name: 'Google' }]),
      expectedReason: 'acp_auth_required',
      expectedMessage: 'Authentication required',
      expectedTerminateForce: false,
    },
    {
      name: 'agent disconnect',
      error: new Error('Connection is disposed'),
      expectedReason: 'agent_disconnected',
      expectedMessage: 'The agent process disconnected unexpectedly. Please try again.',
      expectedTerminateForce: true,
    },
    {
      name: 'startup transport failure with npm diagnostics',
      error: new AcpStartupProcessError({
        sessionId: 'synthetic-startup',
        command: 'npx',
        args: [],
        stderrTail: 'npm error EBADDEVENGINES: requires Node >=22.23.4',
        cause: new Error('ACP connection closed'),
      }),
      stage: 'agent-start',
      expectedReason: 'turn_pre_prompt_failed',
      expectedMessage:
        'Starting the agent failed: [ACP_STARTUP_FAILED] ACP agent process failed before startup completed (command=npx): ACP connection closed; stderr tail: npm error EBADDEVENGINES: requires Node >=22.23.4',
    },
    {
      name: 'ordinary non-ACP failure',
      error: new Error('docker failed'),
      expectedReason: 'turn_pre_prompt_failed',
      expectedMessage: 'docker failed',
    },
    {
      name: 'missing Git executable',
      error: new GitExecutableNotFoundError(new Error('spawn git ENOENT')),
      expectedReason: 'turn_pre_prompt_failed',
      expectedMessage: 'Git is unavailable: Lody could not find the Git executable in PATH.',
      expectedCode: 'git_executable_not_found',
    },
    {
      name: 'message-less failure while preparing the worktree',
      error: new MessagelessStartFailure({ cause: new Error("Operation timed out after '5s'") }),
      stage: 'worktree',
      expectedReason: 'turn_pre_prompt_failed',
      expectedMessage:
        "Preparing the worktree failed: MessagelessStartFailure: Operation timed out after '5s'",
    },
    {
      // A setup script is not known to be safe to run twice, so nothing repeats it.
      name: 'temporary system error while the worktree setup script ran',
      error: temporarySpawnFailure(),
      stage: 'worktree-setup',
      expectedReason: 'turn_pre_prompt_failed',
      expectedMessage: 'Running the worktree setup script failed: spawnSync /usr/bin/git EAGAIN',
    },
  ])('records exactly one visible chat_failed for a pre-prompt $name', async (testCase) => {
    let history: SessionHistoryInput[] = [];
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => undefined),
      getHistory: vi.fn(() => history),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      updateHistory: vi.fn(
        async (update: (entries: SessionHistoryInput[]) => SessionHistoryInput[]) => {
          history = update(history);
        }
      ),
      roomId: 'session-session-pre-prompt-fail',
    });
    const sessionManager = {
      getSession: vi.fn(() => null),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(async (config: SessionConfig) => {
        if (testCase.stage) config.onStartStage?.(testCase.stage);
        throw testCase.error;
      }),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      validateSessionCredentials: vi.fn(async () => {}),
    } as unknown as SessionManager;
    const deps = createBaseDeps({
      sessionManager,
      // Append through the history port the same system turn the real
      // `recordChatFailure` writes, so the assertions read visible history
      // instead of counting mock calls.
      recordChatFailure: vi.fn(
        async (_sessionDoc: unknown, reason: string, message?: string, code?: string) => {
          await sessionDoc.updateHistory?.((entries: SessionHistoryInput[]) => [
            ...entries,
            {
              id: `system-notice-${entries.length}`,
              role: 'system',
              timestamp: '2026-09-10T00:00:00.000Z',
              fileDiff: [],
              items: [
                {
                  type: 'system_notice',
                  name: 'chat_failed',
                  meta: { reason, ...(code ? { code } : {}), message },
                },
              ],
            } as SessionHistoryInput,
          ]);
        }
      ),
      workspaceDocument: {
        repo: {
          upsertDocMeta: vi.fn(async () => {}),
          getDocMeta: vi.fn(async () => undefined),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
    });

    const service = new SessionExecutionService(deps);
    await service.startSession({
      type: 'session/create',
      sessionId: 'session-pre-prompt-fail' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-pre-prompt-fail',
      userId: 'user-2',
      userName: 'User 2',
      userEmail: 'user2@example.com',
    });

    const notices = history
      .flatMap((entry) => entry.items ?? [])
      .filter((item) => item.type === 'system_notice' && item.name === 'chat_failed');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.meta).toMatchObject({
      reason: testCase.expectedReason,
      message: testCase.expectedMessage,
    });
    expect(sessionManager.createSession).toHaveBeenCalledTimes(1);
    if (testCase.expectedCode) {
      expect(notices[0]?.meta).toMatchObject({ code: testCase.expectedCode });
    }
    if (testCase.expectedTerminateForce === undefined) {
      expect(sessionManager.terminateSession).not.toHaveBeenCalled();
    } else {
      expect(sessionManager.terminateSession).toHaveBeenCalledWith(
        'session-pre-prompt-fail',
        testCase.expectedTerminateForce
      );
    }
    expect(sessionManager.setSessionError).toHaveBeenCalledWith(
      'session-pre-prompt-fail',
      'execution_error'
    );
  });

  it('records exactly one visible chat_failed when an ACP error hits after the prompt started', async () => {
    let history: SessionHistoryInput[] = [];
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => ({ isArchived: false })),
      setStatus: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(() => history),
      updateHistory: vi.fn(
        async (update: (entries: SessionHistoryInput[]) => SessionHistoryInput[]) => {
          history = update(history);
        }
      ),
    });
    const agentClient = {
      isCreated: vi.fn(() => true),
      prompt: vi.fn(async () => {
        throw new RequestError(-32603, 'Internal error', {
          details: 'model exploded mid-turn',
        });
      }),
      currentModel: undefined,
    };
    const session = {
      sessionId: 'session-mid-turn-acp' as SessionId,
      acpSessionId: 'acp-mid-turn' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getGitHubCredentials: () => nativeSessionCredentials,
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-mid-turn'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const sessionManager = {
      getSession: vi.fn(() => session),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      validateSessionCredentials: vi.fn(async () => {}),
    } as unknown as SessionManager;
    const deps = createBaseDeps({
      sessionManager,
      recordChatFailure: vi.fn(
        async (_sessionDoc: unknown, reason: string, message?: string, code?: string) => {
          await sessionDoc.updateHistory?.((entries: SessionHistoryInput[]) => [
            ...entries,
            {
              id: `system-notice-${entries.length}`,
              role: 'system',
              timestamp: '2026-09-10T00:00:00.000Z',
              fileDiff: [],
              items: [
                {
                  type: 'system_notice',
                  name: 'chat_failed',
                  meta: { reason, ...(code ? { code } : {}), message },
                },
              ],
            } as SessionHistoryInput,
          ]);
        }
      ),
      workspaceDocument: {
        repo: {
          upsertDocMeta: vi.fn(async () => {}),
          getDocMeta: vi.fn(async () => undefined),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
    });

    const service = new SessionExecutionService(deps);
    await service.continueSession({
      type: 'session/chat',
      sessionId: 'session-mid-turn-acp' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: { kind: 'github', repoFullName: 'owner/repo', branch: 'main' },
      acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-mid-turn-acp',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    const notices = history
      .flatMap((entry) => entry.items ?? [])
      .filter((item) => item.type === 'system_notice' && item.name === 'chat_failed');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.meta).toMatchObject({
      reason: 'acp_internal_error',
      message: 'model exploded mid-turn',
    });
  });

  it('records no chat_failed when a pending session create is cancelled before failing', async () => {
    let createStarted!: () => void;
    const createStartedPromise = new Promise<void>((resolve) => {
      createStarted = resolve;
    });
    let rejectCreateSession!: (error: unknown) => void;
    const createSessionPromise = new Promise<unknown>((_resolve, reject) => {
      rejectCreateSession = reject;
    });
    let history: SessionHistoryInput[] = [];
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => undefined),
      getHistory: vi.fn(() => history),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      updateHistory: vi.fn(
        async (update: (entries: SessionHistoryInput[]) => SessionHistoryInput[]) => {
          history = update(history);
        }
      ),
      roomId: 'session-session-create-cancel',
    });
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
      beginConversationTurn: vi.fn(() => 'assistant-create-cancel'),
      recordChatFailure: vi.fn(
        async (_sessionDoc: unknown, reason: string, message?: string, code?: string) => {
          await sessionDoc.updateHistory?.((entries: SessionHistoryInput[]) => [
            ...entries,
            {
              id: `system-notice-${entries.length}`,
              role: 'system',
              timestamp: '2026-09-10T00:00:00.000Z',
              fileDiff: [],
              items: [
                {
                  type: 'system_notice',
                  name: 'chat_failed',
                  meta: { reason, ...(code ? { code } : {}), message },
                },
              ],
            } as SessionHistoryInput,
          ]);
        }
      ),
      workspaceDocument: {
        repo: {
          upsertDocMeta: vi.fn(async () => {}),
          getDocMeta: vi.fn(async () => undefined),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
    });

    const service = new SessionExecutionService(deps);
    const startPromise = service.startSession({
      type: 'session/create',
      sessionId: 'session-create-cancel' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-create-cancel',
      userId: 'user-2',
      userName: 'User 2',
      userEmail: 'user2@example.com',
    });

    await createStartedPromise;
    await expect(
      service.cancelSession({
        type: 'session/cancel',
        sessionId: 'session-create-cancel' as SessionId,
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        turnId: 'assistant-create-cancel',
      })
    ).resolves.toEqual({ success: true });

    rejectCreateSession(
      new RequestError(-32603, 'Internal error', { details: 'create raced a cancel' })
    );
    await startPromise;

    const notices = history
      .flatMap((entry) => entry.items ?? [])
      .filter((item) => item.type === 'system_notice' && item.name === 'chat_failed');
    expect(notices).toHaveLength(0);
  });

  it('repeats a new start as a resume once its worktree setup has finished', async () => {
    vi.useFakeTimers();
    const resumeFlags: Array<boolean | undefined> = [];
    const { sessionManager, start, notices } = createRetryFixture(async (config) => {
      resumeFlags.push(config.resume);
      config.onStartStage?.('agent-start');
      throw resumeFlags.length === 1 ? temporarySpawnFailure() : new Error('agent crashed');
    });
    const execution = start();
    await vi.advanceTimersByTimeAsync(16000);
    await execution;
    vi.useRealTimers();

    // The second attempt skips the setup script that the first one already ran.
    expect(resumeFlags).toEqual([undefined, true]);
    expect(sessionManager.createSession).toHaveBeenCalledTimes(2);
    expect(notices()).toHaveLength(1);
    expect(notices()[0]?.meta).toMatchObject({
      reason: 'turn_pre_prompt_failed',
      message: 'Starting the agent failed: agent crashed',
    });
  });

  it('does not carry a start step into the next attempt', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const { notices, start } = createRetryFixture(async (config) => {
      calls += 1;
      if (calls === 1) {
        config.onStartStage?.('agent-start');
        throw temporarySpawnFailure();
      }
      // Fails before reporting any step of its own.
      throw new Error('pending create was replaced');
    });
    const execution = start();
    await vi.advanceTimersByTimeAsync(16000);
    await execution;
    vi.useRealTimers();

    expect(notices()[0]?.meta).toMatchObject({
      reason: 'turn_pre_prompt_failed',
      message: 'pending create was replaced',
    });
  });

  it('does not retry a start whose cleanup left resources unreleased', async () => {
    vi.useFakeTimers();
    const { sessionManager, notices, start } = createRetryFixture(async (config) => {
      config.onStartStage?.('agent-start');
      const failure = temporarySpawnFailure();
      // SessionManager marks this when terminate or credential release fails.
      recordIncompleteStartCleanup(failure);
      throw failure;
    });
    const execution = start();
    await vi.advanceTimersByTimeAsync(16000);
    await execution;
    vi.useRealTimers();

    expect(sessionManager.createSession).toHaveBeenCalledTimes(1);
    expect(notices()[0]?.meta).toMatchObject({
      reason: 'turn_pre_prompt_failed',
      message: 'Starting the agent failed: spawnSync /usr/bin/git EAGAIN',
    });
  });

  it('makes no further start attempt after Stop during the retry delay', async () => {
    vi.useFakeTimers();
    const { service, sessionManager, backoff, start, notices } = createRetryFixture(
      async (config) => {
        config.onStartStage?.('worktree');
        throw temporarySpawnFailure();
      }
    );
    const execution = start();
    await backoff;
    const cancelling = service.cancelSession({
      type: 'session/cancel',
      sessionId: 'session-start-retry' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      turnId: 'assistant-start-retry',
    });
    await vi.advanceTimersByTimeAsync(16000);
    await expect(cancelling).resolves.toEqual({ success: true });
    await execution;
    vi.useRealTimers();

    expect(sessionManager.createSession).toHaveBeenCalledTimes(1);
    expect(notices()).toHaveLength(0);
  });

  it.each<{
    name: string;
    errors: unknown[];
    expectedReason: ChatFailedReason;
    expectedMessage: unknown;
    resumeSessionId: ACPSessionId | undefined;
    history: SessionHistoryInput[];
    /** How many times the restore path may reach `createSession`. */
    expectedCreateSessionCalls: number;
    /** Start step each attempt reports before failing. */
    stage?: SessionStartStage;
  }>([
    {
      name: 'reports an ordinary restore failure',
      errors: [new Error('restore failed')],
      expectedReason: 'session_restore_failed',
      expectedMessage: 'restore failed',
      resumeSessionId: undefined,
      history: [],
      expectedCreateSessionCalls: 1,
    },
    {
      name: 'reports authentication required from the initial restore',
      errors: [new AcpAuthenticationRequiredError([])],
      expectedReason: 'acp_auth_required',
      expectedMessage: 'Authentication required',
      resumeSessionId: undefined,
      history: [],
      expectedCreateSessionCalls: 1,
    },
    {
      name: 'reports authentication required from fallback restore',
      errors: [
        new Error('acp_resume_failed: session unavailable'),
        new AcpAuthenticationRequiredError([]),
      ],
      expectedReason: 'acp_auth_required',
      expectedMessage: 'Authentication required',
      resumeSessionId: 'acp-existing' as ACPSessionId,
      history: PRIOR_CONVERSATION_HISTORY,
      expectedCreateSessionCalls: 2,
    },
    {
      name: 'reports a wrapped authentication failure from fallback restore',
      errors: [
        new Error('acp_resume_failed: session unavailable'),
        new Error('[ACP_RESUME_FAILED] newSession: Internal error', {
          cause: new RequestError(-32603, 'Internal error', { details: 'OAuth session expired' }),
        }),
      ],
      expectedReason: 'acp_auth_required',
      expectedMessage: '[ACP_RESUME_FAILED] newSession: Internal error',
      resumeSessionId: 'acp-existing' as ACPSessionId,
      history: PRIOR_CONVERSATION_HISTORY,
      expectedCreateSessionCalls: 2,
    },
    {
      // Classification reads `formatErrorMessage`, which a message-less wrapper leaves
      // empty; its cause's text must not switch the restore to the replay fallback.
      name: 'does not classify a message-less wrapper by its cause text',
      errors: [
        new MessagelessStartFailure({ cause: new Error('acp_resume_failed: session unavailable') }),
      ],
      stage: 'agent-start',
      expectedReason: 'session_restore_failed',
      expectedMessage:
        'Starting the agent failed: MessagelessStartFailure: acp_resume_failed: session unavailable',
      resumeSessionId: 'acp-existing' as ACPSessionId,
      history: PRIOR_CONVERSATION_HISTORY,
      expectedCreateSessionCalls: 1,
    },
    {
      // Failure text reaches synced history, so an object cause is never dumped into it.
      name: 'names only the type of a message-less failure with an object cause',
      errors: [new MessagelessStartFailure({ cause: { headers: { authorization: 'secret' } } })],
      stage: 'worktree',
      expectedReason: 'session_restore_failed',
      expectedMessage: 'Preparing the worktree failed: MessagelessStartFailure',
      resumeSessionId: undefined,
      history: [],
      expectedCreateSessionCalls: 1,
    },
    {
      name: 'refuses a context-free fallback when history has not synced',
      errors: [new Error('acp_resume_failed: session unavailable')],
      expectedReason: 'session_restore_failed',
      expectedMessage: expect.stringContaining('has not synced the earlier conversation'),
      resumeSessionId: 'acp-existing' as ACPSessionId,
      history: [],
      // The fallback must not even be attempted: creating it would persist a
      // fresh acpSessionId over the one that still points at the agent's
      // transcript, for a session we cannot carry any context into.
      expectedCreateSessionCalls: 1,
    },
    {
      name: 'reports authentication required when the resume failure wraps an auth error',
      errors: [
        // The SDK's own rejection shape: an `Error` subclass whose `data` a
        // flattened cause dump drops, so the wrapper must be walked per link.
        new Error('[ACP_RESUME_FAILED] loadSession: Internal error', {
          cause: new RequestError(-32603, 'Internal error', {
            details: 'OAuth session expired',
          }),
        }),
      ],
      expectedReason: 'acp_auth_required',
      expectedMessage: '[ACP_RESUME_FAILED] loadSession: Internal error',
      resumeSessionId: 'acp-existing' as ACPSessionId,
      history: PRIOR_CONVERSATION_HISTORY,
      // Signing in again makes the original ACP session resumable, so the
      // resume pointer must survive: no replacement session is created.
      expectedCreateSessionCalls: 1,
    },
    {
      name: 'names the start step and type of a message-less restore failure',
      errors: [new MessagelessStartFailure({ cause: new Error("Operation timed out after '5s'") })],
      stage: 'worktree',
      expectedReason: 'session_restore_failed',
      expectedMessage:
        "Preparing the worktree failed: MessagelessStartFailure: Operation timed out after '5s'",
      resumeSessionId: undefined,
      history: [],
      expectedCreateSessionCalls: 1,
    },
    {
      name: 'retries a temporary system error and reports the last failure',
      errors: [temporarySpawnFailure(), temporarySpawnFailure(), new Error('restore failed')],
      stage: 'worktree',
      expectedReason: 'session_restore_failed',
      expectedMessage: 'Preparing the worktree failed: restore failed',
      resumeSessionId: undefined,
      history: [],
      expectedCreateSessionCalls: 3,
    },
    {
      name: 'stops retrying a temporary system error after three attempts',
      errors: [temporarySpawnFailure(), temporarySpawnFailure(), temporarySpawnFailure()],
      stage: 'agent-start',
      expectedReason: 'session_restore_failed',
      expectedMessage: 'Starting the agent failed: spawnSync /usr/bin/git EAGAIN',
      resumeSessionId: undefined,
      history: [],
      expectedCreateSessionCalls: 3,
    },
    {
      name: 'never repeats a restore whose worktree setup script failed',
      errors: [temporarySpawnFailure()],
      stage: 'worktree-setup',
      expectedReason: 'session_restore_failed',
      expectedMessage: 'Running the worktree setup script failed: spawnSync /usr/bin/git EAGAIN',
      resumeSessionId: undefined,
      history: [],
      expectedCreateSessionCalls: 1,
    },
    {
      name: 'keeps the auth message without a start step',
      errors: [new AcpAuthenticationRequiredError([])],
      stage: 'agent-start',
      expectedReason: 'acp_auth_required',
      expectedMessage: 'Authentication required',
      resumeSessionId: undefined,
      history: [],
      expectedCreateSessionCalls: 1,
    },
  ])('$name', async (testCase) => {
    vi.useFakeTimers();
    const { errors, expectedReason, expectedMessage, resumeSessionId, history } = testCase;
    const expectedCreateSessionCalls = testCase.expectedCreateSessionCalls;
    const upsertDocMeta = vi.fn(async () => {});
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => ({
        repoFullName: 'owner/repo',
        isArchived: false,
      })),
      setStatus: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(() => history),
      updateHistory: vi.fn(async () => {}),
    });
    const sessionManager = {
      getSession: vi.fn(() => null),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(async (config: SessionConfig) => {
        if (testCase.stage) config.onStartStage?.(testCase.stage);
        const error = errors.shift();
        if (!error) throw new Error('Unexpected restore attempt');
        throw error;
      }),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      validateSessionCredentials: vi.fn(async () => {}),
    } as unknown as SessionManager;
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
    });

    const service = new SessionExecutionService(deps);
    const execution = service.continueSession({
      type: 'session/chat',
      sessionId: 'session-restore-fail' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: { kind: 'github', repoFullName: 'owner/repo', branch: 'main' },
      acpSessionConfig: {
        prompt: 'hello',
        cliType: 'builtin',
        agentType: 'kimi',
        resume: resumeSessionId,
      },
      userTurnId: 'turn-restore-fail',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    // Past the 30s replayable-history wait a context-free fallback runs out.
    await vi.advanceTimersByTimeAsync(31_000);
    await execution;
    vi.useRealTimers();

    expect(deps.startSessionActivePresence).toHaveBeenCalledTimes(1);
    expect(deps.clearSessionActivePresence).toHaveBeenCalledTimes(1);
    expect(deps.beginConversationTurn).toHaveBeenCalledTimes(1);
    expect(deps.createAssistantEntryForTurn).toHaveBeenCalledWith(
      'session-restore-fail',
      sessionDoc,
      'turn-1',
      undefined,
      'turn-restore-fail'
    );
    expect(deps.recordChatFailure).toHaveBeenCalledWith(
      sessionDoc,
      expectedReason,
      expectedMessage
    );
    expect(sessionManager.createSession).toHaveBeenCalledTimes(expectedCreateSessionCalls);
    expect(upsertDocMeta).toHaveBeenCalledWith('session-session-restore-fail', {
      lastHandledUserMsgId: 'turn-restore-fail',
      lastFailedUserMsgId: 'turn-restore-fail',
      processingUserMsgId: undefined,
    });
    expect(sessionDoc.setStatus).toHaveBeenCalledWith(SessionStatusFactory.idle());
    expect(deps.turnFinalization.finalizeACPState).toHaveBeenCalledTimes(1);
    expect(deps.turnFinalization.flushSessionUsage).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: 'generic startup error',
      error: new Error('pending init failed'),
      expectedReason: 'session_init_failed' as const,
      expectedMessage: 'pending init failed',
    },
    {
      name: 'non-auth ACP error',
      error: Object.assign(new Error('Invalid params'), { code: -32602 }),
      expectedReason: 'session_init_failed' as const,
      expectedMessage: 'Invalid params',
    },
    {
      name: 'authentication-required ACP error',
      error: new AcpAuthenticationRequiredError([{ type: 'terminal' as const, args: ['--login'] }]),
      expectedReason: 'acp_auth_required' as const,
      expectedMessage: 'Authentication required',
    },
  ])(
    'reports pending session initialization failure through the owner effect path: $name',
    async ({ error, expectedReason, expectedMessage }) => {
      const upsertDocMeta = vi.fn(async () => {});
      const sessionDoc = withHistoryPort({
        getMetaState: vi.fn(async () => ({ isArchived: false })),
        setStatus: vi.fn(async () => {}),
        setBaseBranch: vi.fn(async () => {}),
        getHistory: vi.fn(() => []),
        updateHistory: vi.fn(async () => {}),
      });
      const session = {
        sessionId: 'session-pending-init-fail' as SessionId,
        acpSessionId: null,
        agentClient: {
          isCreated: vi.fn(() => false),
        },
        terminalManager: {} as unknown,
        getWorkdir: () => '/tmp',
        getGitHubCredentials: () => nativeSessionCredentials,
        getHostWorkdir: () => '/tmp',
        getParentSessionId: () => undefined,
        exec: vi.fn(async () => ''),
        terminate: vi.fn(async () => {}),
        updateGitIdentity: vi.fn(),
        createAgent: vi.fn(async () => 'acp-pending-init-fail'),
        applyExecutionPlaneLimits: vi.fn(async () => {}),
      };
      const sessionManager = {
        getSession: vi.fn(() => session),
        getPendingSession: vi.fn(() => Promise.reject(error)),
        createSession: vi.fn(),
        setSessionError: vi.fn(),
        terminateSession: vi.fn(),
        validateSessionCredentials: vi.fn(async () => {}),
      } as unknown as SessionManager;
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
      });

      const service = new SessionExecutionService(deps);
      await service.continueSession({
        type: 'session/chat',
        sessionId: 'session-pending-init-fail' as SessionId,
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        project: { kind: 'github', repoFullName: 'owner/repo', branch: 'main' },
        acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
        userTurnId: 'turn-pending-init-fail',
        userId: 'user-1',
        userName: 'User',
        userEmail: 'user@example.com',
      });

      expect(deps.recordChatFailure).toHaveBeenCalledWith(
        sessionDoc,
        expectedReason,
        expectedMessage
      );
      expect(upsertDocMeta).toHaveBeenCalledWith('session-session-pending-init-fail', {
        lastHandledUserMsgId: 'turn-pending-init-fail',
        lastFailedUserMsgId: 'turn-pending-init-fail',
        processingUserMsgId: undefined,
      });
      expect(deps.turnFinalization.finalizeACPState).toHaveBeenCalledTimes(1);
    }
  );

  it('marks chat dispatch as failed when prompt execution throws after processing starts', async () => {
    const branchProbe = createDeferred<string | null>();
    const persisted: Record<string, unknown> = {};
    const upsertDocMeta = vi.fn(async (_id: string, patch: Record<string, unknown>) => {
      Object.assign(persisted, patch);
    });
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => ({ isArchived: false })),
      setStatus: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(() => []),
      updateHistory: vi.fn(async () => {}),
    });
    const agentClient = {
      isCreated: vi.fn(() => true),
      prompt: vi.fn(async () => {
        throw new Error('prompt failed');
      }),
      currentModel: undefined,
    };
    const session = {
      sessionId: 'session-chat-1' as SessionId,
      acpSessionId: 'acp-chat-1' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getGitHubCredentials: () => nativeSessionCredentials,
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-chat-1'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const sessionManager = {
      getSession: vi.fn(() => session),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      validateSessionCredentials: vi.fn(async () => {}),
    } as unknown as SessionManager;

    const deps = createBaseDeps({
      syncSessionBranchName: () => branchProbe.promise,
      sessionManager,
      workspaceDocument: {
        repo: {
          upsertDocMeta,
          getDocMeta: vi.fn(async () => undefined),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
    });

    const service = new SessionExecutionService(deps);
    await service.continueSession({
      type: 'session/chat',
      sessionId: 'session-chat-1' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: { kind: 'github', repoFullName: 'owner/repo', branch: 'main' },
      acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-chat-1',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    // Failure must settle while the optional branch probe is still blocked.
    expect(persisted).toMatchObject({
      lastHandledUserMsgId: 'turn-chat-1',
      processingUserMsgId: undefined,
    });
    branchProbe.resolve(null);
  });

  it.each([
    {
      name: 'ACP string error data',
      error: Object.assign(new Error('Invalid params'), {
        code: -32602,
        data: 'No goal is currently set. Use `/goal <objective>` to create one.',
      }),
      expectedFailure: [
        'acp_invalid_params',
        'No goal is currently set. Use `/goal <objective>` to create one.',
      ] as const,
    },
    {
      name: 'remote compact transport error',
      error: new Error(
        'Error running remote compact task: Connection failed: error sending request'
      ),
      expectedFailure: null,
    },
  ])('settles context compaction after a provider prompt rejects ($name)', async (testCase) => {
    const upsertDocMeta = vi.fn(async () => {});
    let history: SessionHistoryInput[] = [
      {
        id: 'turn-1',
        role: 'assistant',
        timestamp: '2026-09-10T00:00:00.000Z',
        fileDiff: [],
        items: [
          {
            type: 'tool_call',
            toolCallId: 'compact-1',
            title: 'Context compacting',
            status: 'in_progress',
            activityKind: 'context_compaction',
          },
        ],
      },
    ];
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => ({ isArchived: false })),
      setStatus: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(() => history),
      updateHistory: vi.fn(
        async (updater: (current: SessionHistoryInput[]) => SessionHistoryInput[]) => {
          history = updater(history);
        }
      ),
    });
    const agentClient = {
      isCreated: vi.fn(() => true),
      prompt: vi.fn(async () => {
        throw testCase.error;
      }),
      currentModel: undefined,
    };
    const session = {
      sessionId: 'session-acp-data' as SessionId,
      acpSessionId: 'acp-data-1' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getGitHubCredentials: () => nativeSessionCredentials,
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-data-1'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const sessionManager = {
      getSession: vi.fn(() => session),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      validateSessionCredentials: vi.fn(async () => {}),
    } as unknown as SessionManager;

    const deps = createBaseDeps({
      sessionManager,
      workspaceDocument: {
        repo: {
          upsertDocMeta,
          getDocMeta: vi.fn(async () => undefined),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        getOrOpenSessionCode: vi.fn(async () => null),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
      turnFinalization: {
        ...createBaseDeps({}).turnFinalization,
        finalizeACPState: vi.fn(async (_sessionId, turnId) => {
          history = markAssistantTurnFinished(history, { turnId, endedAt: 42 });
        }),
      },
    });

    const service = new SessionExecutionService(deps);
    await service.continueSession({
      type: 'session/chat',
      sessionId: 'session-acp-data' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: { kind: 'github', repoFullName: 'owner/repo', branch: 'main' },
      acpSessionConfig: { prompt: 'pause the goal', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-acp-data',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    if (testCase.expectedFailure) {
      expect(deps.recordChatFailure).toHaveBeenCalledWith(sessionDoc, ...testCase.expectedFailure);
    } else {
      expect(deps.recordChatFailure).not.toHaveBeenCalled();
    }
    expect(history[0]).toMatchObject({
      finished: true,
      items: [expect.objectContaining({ toolCallId: 'compact-1', status: 'failed' })],
    });
  });

  it('records a visible failure when a chat turn fails before prompt starts', async () => {
    const events: string[] = [];
    const upsertDocMeta = vi.fn(async () => {});
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => ({ isArchived: false })),
      setStatus: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(() => []),
      updateHistory: vi.fn(async () => {}),
    });
    const agentClient = {
      isCreated: vi.fn(() => true),
      prompt: vi.fn(async () => ({})),
      currentModel: undefined,
    };
    const session = {
      sessionId: 'session-pre-prompt-fail' as SessionId,
      acpSessionId: 'acp-pre-prompt-fail' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getGitHubCredentials: () => nativeSessionCredentials,
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-pre-prompt-fail'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const sessionManager = {
      getSession: vi.fn(() => session),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      validateSessionCredentials: vi.fn(async () => {}),
    } as unknown as SessionManager;

    const deps = createBaseDeps({
      sessionManager,
      beginConversationTurn: vi.fn(() => 'assistant-pre-prompt-fail'),
      workspaceDocument: {
        repo: {
          upsertDocMeta,
          getDocMeta: vi.fn(async () => undefined),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
      createAssistantEntryForTurn: vi.fn(async () => {
        events.push('assistant-entry');
      }),
      startSessionActivePresence: vi.fn(() => {
        events.push('active-start');
      }),
      clearSessionActivePresence: vi.fn(() => {
        events.push('active-clear');
      }),
      clearConversationTurn: vi.fn(() => {
        events.push('conversation-clear');
      }),
      recordChatFailure: vi.fn(async () => {
        events.push('record-failure');
      }),
      buildAcpPromptBlocks: vi.fn(async () => {
        events.push('build-prompt');
        throw new Error('prompt build failed');
      }),
    });

    const service = new SessionExecutionService(deps);
    await service.continueSession({
      type: 'session/chat',
      sessionId: 'session-pre-prompt-fail' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: { kind: 'github', repoFullName: 'owner/repo', branch: 'main' },
      acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-pre-prompt-fail',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(events.slice(0, 4)).toEqual([
      'active-start',
      'assistant-entry',
      'build-prompt',
      'active-clear',
    ]);
    expect(events.indexOf('record-failure')).toBeLessThan(events.indexOf('conversation-clear'));
    expect(agentClient.prompt).not.toHaveBeenCalled();
    expect(deps.recordChatFailure).toHaveBeenCalledWith(
      sessionDoc,
      'turn_pre_prompt_failed',
      'prompt build failed'
    );
    expect(upsertDocMeta).toHaveBeenCalledWith('session-session-pre-prompt-fail', {
      lastHandledUserMsgId: 'turn-pre-prompt-fail',
      lastFailedUserMsgId: 'turn-pre-prompt-fail',
      processingUserMsgId: undefined,
    });
    expect(deps.turnFinalization.finalizeACPState).toHaveBeenCalledTimes(1);
  });

  it('interrupts the owner fiber and releases scoped active presence when cancelled before prompt starts', async () => {
    const events: string[] = [];
    let buildStarted!: () => void;
    const buildStartedPromise = new Promise<void>((resolve) => {
      buildStarted = resolve;
    });
    let meta: Record<string, unknown> = {};
    const upsertDocMeta = vi.fn(async (_roomId: string, patch: Record<string, unknown>) => {
      meta = { ...meta, ...patch };
    });
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => ({ isArchived: false })),
      setStatus: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(() => []),
      updateHistory: vi.fn(async () => {}),
    });
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({})),
      currentModel: undefined,
    };
    const session = {
      sessionId: 'session-pre-prompt-interrupt' as SessionId,
      acpSessionId: 'acp-pre-prompt-interrupt' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getGitHubCredentials: () => nativeSessionCredentials,
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-pre-prompt-interrupt'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const sessionManager = {
      getSession: vi.fn(() => session),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      validateSessionCredentials: vi.fn(async () => {}),
    } as unknown as SessionManager;
    const deps = createBaseDeps({
      sessionManager,
      beginConversationTurn: vi.fn(() => 'assistant-pre-prompt-interrupt'),
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
      createAssistantEntryForTurn: vi.fn(async () => {
        events.push('assistant-entry');
      }),
      startSessionActivePresence: vi.fn(() => {
        events.push('active-start');
      }),
      clearSessionActivePresence: vi.fn(() => {
        events.push('active-clear');
      }),
      buildAcpPromptBlocks: vi.fn(async () => {
        events.push('build-prompt');
        buildStarted();
        await new Promise<never>(() => {});
      }),
      processMessageQueue: vi.fn(async () => {}),
    });

    const service = new SessionExecutionService(deps);
    const continuePromise = service.continueSession({
      type: 'session/chat',
      sessionId: 'session-pre-prompt-interrupt' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: { kind: 'github', repoFullName: 'owner/repo', branch: 'main' },
      acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-pre-prompt-interrupt',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    await buildStartedPromise;
    await expect(
      service.cancelSession({
        type: 'session/cancel',
        sessionId: 'session-pre-prompt-interrupt' as SessionId,
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        turnId: 'assistant-pre-prompt-interrupt',
      })
    ).resolves.toEqual({ success: true });
    await continuePromise;

    expect(events).toEqual(['active-start', 'assistant-entry', 'build-prompt', 'active-clear']);
    expect(agentClient.prompt).not.toHaveBeenCalled();
    expect(deps.turnFinalization.finalizeACPState).toHaveBeenCalledTimes(1);
    expect(deps.processMessageQueue).not.toHaveBeenCalled();
    expect(upsertDocMeta).toHaveBeenCalledWith('session-session-pre-prompt-interrupt', {
      lastHandledUserMsgId: 'turn-pre-prompt-interrupt',
      processingUserMsgId: undefined,
    });
  });

  it.each(
    (['Stop', 'access revocation', 'Edit & Resend'] as const).flatMap((cancellation) =>
      [false, true].map((restored) => ({ cancellation, restored }))
    )
  )(
    '$cancellation during config preserves the intended ACP process lifetime (restored: $restored)',
    async ({ cancellation, restored }) => {
      const firstConfigStarted = createDeferred();
      const firstConfigResolved = createDeferred();
      const firstConfigFinished = createDeferred();
      const terminationStarted = createDeferred();
      const processExited = createDeferred();
      const configMutations: string[] = [];
      const prompts: Array<{ process: number; sessionId: string }> = [];
      let firstConfigSignal: AbortSignal | undefined;
      const sessionId = 'session-pre-prompt-interrupt' as SessionId;
      const userTurnId = 'turn-pre-prompt-interrupt';
      let meta: Record<string, unknown> = {
        id: sessionId,
        machineId: 'machine-1',
        userId: 'user-1',
        cliType: 'builtin',
        agentType: 'codex',
        acpSessionId: 'acp-original',
        isArchived: false,
      };
      const upsertDocMeta = vi.fn(async (_roomId: string, patch: Record<string, unknown>) => {
        meta = { ...meta, ...patch };
      });
      const repo = { upsertDocMeta, getDocMeta: vi.fn(async () => ({ meta })) };
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
            timestamp: '2026-09-15T00:00:00.000Z',
            status: 'pending',
            read: false,
            items: [{ type: 'text', text: 'A' }],
            fileDiff: [],
            finished: true,
            inputConfig: { prompt: 'A', cliType: 'builtin', agentType: 'codex' },
          },
        ],
      });
      let processNumber = 0;
      const createSession = () => {
        const process = ++processNumber;
        const sessions = new Set([process === 1 ? 'acp-original' : 'acp-restored']);
        const child = { exitCode: null as number | null };
        const session = new Session(
          {
            sessionId,
            workspaceId: 'workspace-1' as WorkspaceId,
            machineId: 'machine-1',
            requesterUserId: 'user-1',
            userName: 'User',
            userEmail: 'user@example.com',
            agentCliType: 'builtin',
            agentType: 'codex',
            mcpServerIds: [],
          },
          createSilentLogger(),
          '/tmp'
        );
        // Only the OS process boundary is controlled. Production terminate must
        // wait for exit and clear both the client and ACP identity before release.
        Object.assign(session, {
          agentProcess: {
            child,
            terminate: async () => {
              terminationStarted.resolve();
              await processExited.promise;
              sessions.clear();
              child.exitCode = 0;
            },
            onExit: () => () => {},
          },
        });
        const assertLive = (id: string) => {
          if (!sessions.has(id)) throw new Error('ACP session belongs to an exited process');
        };
        session.acpSessionId = (process === 1 ? 'acp-original' : 'acp-restored') as ACPSessionId;
        session.agentClient = {
          isCreated: () => child.exitCode === null,
          currentModel: undefined,
          getAvailableCommands: () => [],
          getAvailableCommandsForSession: () => [],
          getConfigOptions: () => [],
          setSessionConfigOption: async (id: string, _configId: string, value: unknown) => {
            assertLive(id);
            configMutations.push(String(value));
            if (value === 'A config #1') {
              firstConfigStarted.resolve();
              await firstConfigResolved.promise;
            }
          },
          prompt: async (id: string) => {
            assertLive(id);
            prompts.push({ process, sessionId: id });
            return { stopReason: 'end_turn' };
          },
          prepareReplacementSession: async () => {
            assertLive('acp-original');
            sessions.add('acp-prepared');
            return { sessionId: 'acp-prepared' };
          },
          adoptPreparedSession: ({ sessionId: id }: { sessionId: string }) => assertLive(id),
          closeDetachedSession: async (id: string) => sessions.delete(id),
        } as unknown as AgentClient;
        return session;
      };
      const session = createSession();
      let residentSession: Session | null = restored ? null : session;
      const sessionManager = {
        getSession: vi.fn(() => residentSession),
        getPendingSession: vi.fn(() => null),
        createSession: vi.fn(async () => {
          residentSession = session;
          return session;
        }),
        setSessionError: vi.fn(),
        terminateSession: vi.fn(),
        validateSessionCredentials: vi.fn(async () => {}),
      } as unknown as SessionManager;
      const deps = createBaseDeps({
        sessionManager,
        beginConversationTurn: vi.fn(
          (_sessionId, sourceTurnId) => `assistant:${sourceTurnId ?? 'unknown'}`
        ),
        workspaceDocument: {
          repo,
          getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
          updateAcpCapabilities: vi.fn(async () => {}),
          persistPendingChanges: vi.fn(async () => {}),
        } as unknown as LoroDocumentManager,
        buildAcpPromptBlocks: vi.fn(async ({ inputBlocks }) => inputBlocks as ContentBlock[]),
        processMessageQueue: vi.fn(async () => {}),
      });
      deps.applyAcpModeAndModel = vi.fn(async (targetSession, config, context) => {
        if (context.basedOnUserTurnId === 'turn-pre-prompt-interrupt') {
          firstConfigSignal = context.signal;
        }
        try {
          await applyAcpSessionRunConfig({
            session: targetSession,
            config,
            logger: createSilentLogger(),
            signal: context.signal,
          });
        } finally {
          if (context.basedOnUserTurnId === userTurnId) firstConfigFinished.resolve();
        }
      });

      const service = new SessionExecutionService(deps);
      const firstMessage = {
        type: 'session/chat',
        sessionId: 'session-pre-prompt-interrupt' as SessionId,
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        project: undefined,
        acpSessionConfig: {
          prompt: 'hello',
          cliType: 'builtin',
          agentType: 'codex',
          configOptionValues: {
            first: 'A config #1',
            second: 'A config #2',
          },
        },
        userTurnId: 'turn-pre-prompt-interrupt',
        userId: 'user-1',
        userName: 'User',
        userEmail: 'user@example.com',
      } as const;
      const continuePromise = service.continueSession(firstMessage);

      await firstConfigStarted.promise;
      if (cancellation === 'Edit & Resend') {
        // An accidental termination must fail at adoption, not hang this test.
        processExited.resolve();
        const editService = new SessionEditAndResendService({
          workspaceDocument: Object.assign(deps.workspaceDocument, {
            isEncryptedWorkspace: () => false,
          }),
          sessionManager,
          executionService: service,
          userResolver: {} as never,
          logger: createSilentLogger(),
          workspaceId: 'workspace-1',
          machineId: 'machine-1',
          enqueueDispatch: () => {},
        });
        await expect(
          editService.editAndResend({
            sessionId,
            expectedUserTurnId: userTurnId,
            replacementUserTurnId: 'turn-after-interrupt',
            requestedByUserId: 'user-1',
            timestamp: '2026-09-15T00:00:01.000Z',
            inputConfig: { prompt: 'B', cliType: 'builtin', agentType: 'codex' },
          })
        ).resolves.toMatchObject({ success: true });
        expect(session.agentClient).not.toBeNull();
        expect(session.acpSessionId).toBe('acp-prepared');
        expect(meta.acpSessionId).toBe('acp-prepared');
      } else {
        await expect(
          service.cancelSession(
            {
              type: 'session/cancel',
              sessionId: firstMessage.sessionId,
              machineId: 'machine-1',
              workspaceId: 'workspace-1' as WorkspaceId,
              turnId: 'assistant:turn-pre-prompt-interrupt',
            },
            {
              pendingInput: cancellation === 'Stop' ? 'promote' : 'preserve',
              prePromptSession: 'discard',
            }
          )
        ).resolves.toEqual({ success: true });
        await terminationStarted.promise;
        expect(service.getExecutionSnapshot(sessionId).hasActiveTurn).toBe(true);
        processExited.resolve();
      }
      await continuePromise;
      if (cancellation !== 'Edit & Resend') {
        expect(session.agentClient).toBeNull();
        expect(session.acpSessionId).toBeNull();
        residentSession = createSession();
      }

      const nextMessage = {
        ...firstMessage,
        userTurnId: 'turn-after-interrupt',
        acpSessionConfig: {
          ...firstMessage.acpSessionConfig,
          prompt: 'B',
          configOptionValues: { first: 'B config #1' },
        },
      };
      await service.continueSession(nextMessage);
      expect(configMutations).toEqual(['A config #1', 'B config #1']);
      expect(prompts).toEqual([
        {
          process: cancellation === 'Edit & Resend' ? 1 : 2,
          sessionId: cancellation === 'Edit & Resend' ? 'acp-prepared' : 'acp-restored',
        },
      ]);
      expect(firstConfigSignal?.aborted).toBe(true);

      firstConfigResolved.resolve();
      await firstConfigFinished.promise;
      expect(configMutations).toEqual(['A config #1', 'B config #1']);
      expect(service.getExecutionSnapshot(sessionId).hasActiveTurn).toBe(false);
      sessionDoc.mirror?.dispose();
    }
  );

  it('stops a turn before prompt starts when the matching active turn is cancelled', async () => {
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => ({ isArchived: false })),
      setStatus: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(() => []),
      updateHistory: vi.fn(async () => {}),
    });
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({})),
      currentModel: undefined,
    };
    const session = {
      sessionId: 'session-chat-cancelled' as SessionId,
      acpSessionId: 'acp-chat-cancelled' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getGitHubCredentials: () => nativeSessionCredentials,
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-chat-cancelled'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const sessionManager = {
      getSession: vi.fn(() => session),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      validateSessionCredentials: vi.fn(async () => {}),
    } as unknown as SessionManager;
    let activeTurnId: string | undefined;
    let service: SessionExecutionService;
    const deps = createBaseDeps({
      sessionManager,
      beginConversationTurn: vi.fn(() => {
        activeTurnId = 'assistant-turn-1';
        return activeTurnId;
      }),
      getActiveTurnId: vi.fn(() => activeTurnId),
      clearActiveTurnId: vi.fn((_sessionId, turnId) => {
        if (activeTurnId === turnId) {
          activeTurnId = undefined;
        }
      }),
      workspaceDocument: {
        repo: {
          upsertDocMeta: vi.fn(async () => {}),
          getDocMeta: vi.fn(async () => ({
            meta: {},
          })),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
      buildAcpPromptBlocks: vi.fn(async () => {
        await service.cancelSession({
          type: 'session/cancel',
          sessionId: 'session-chat-cancelled' as SessionId,
          machineId: 'machine-1',
          workspaceId: 'workspace-1' as WorkspaceId,
          turnId: 'assistant-turn-1',
        });
        return [{ type: 'text', text: 'hello' }] as any;
      }),
    });

    service = new SessionExecutionService(deps);
    await service.continueSession({
      type: 'session/chat',
      sessionId: 'session-chat-cancelled' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: { kind: 'github', repoFullName: 'owner/repo', branch: 'main' },
      acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-chat-cancelled',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(agentClient.prompt).not.toHaveBeenCalled();
    expect(sessionDoc.setStatus).toHaveBeenCalledWith(SessionStatusFactory.idle());
    expect(deps.turnFinalization.finalizeACPState).toHaveBeenCalledTimes(1);
  });

  it.each(cancelCompletions)('retains cancelled ownership (%s)', async (completion) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const lateApplied =
      completion === 'late-steer-ack' || completion === 'late-steer-write-failure';
    const nativeCompletion =
      completion === 'native-terminal' || completion === 'late-cancel-rejected' || lateApplied;
    const terminationFails =
      completion === 'termination-failed' ||
      completion === 'notice-write-pending' ||
      completion === 'notice-write-rejected';
    const stopFailures: Array<{
      turnId: string;
      phase: 'cancel' | 'timeout' | 'terminate';
      message: string;
    }> = [];
    const pendingNotice = createDeferred();
    let meta: Record<string, unknown> = {};
    let history: Array<Record<string, unknown>> = [
      {
        id: 'turn-prompt-cancel',
        role: 'user',
        items: [{ type: 'text', text: '/compact' }],
        status: 'pending',
        read: false,
      },
      {
        id: 'assistant-prompt-cancel',
        role: 'assistant',
        timestamp: '2026-09-10T00:00:00.000Z',
        fileDiff: [],
        items: [
          {
            type: 'tool_call',
            toolCallId: 'compact-cancelled-turn',
            title: 'Context compacting',
            status: 'in_progress',
            activityKind: 'context_compaction',
          },
        ],
      },
    ];
    const upsertDocMeta = vi.fn(async (_roomId: string, patch: Record<string, unknown>) => {
      if (
        completion === 'late-steer-write-failure' &&
        (patch.steerTurnStatuses as Record<string, string> | undefined)?.['steer-user-turn']
      ) {
        throw new Error('Synthetic outcome persistence failure');
      }
      meta = { ...meta, ...patch };
    });
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => ({ isArchived: false })),
      setStatus: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(() => history),
      updateHistory: vi.fn(async (updater: (prev: typeof history) => typeof history) => {
        history = updater(history);
      }),
    });
    let activeTurnId: string | undefined;
    const promptStarted = createDeferred();
    const cancelSubmitted = createDeferred();
    const cancelAck = createDeferred();
    const nativeTerminal = createDeferred<PromptResponse>();
    const steerSubmitted = createDeferred();
    const steerApplied = createDeferred<{ release: () => void }>();
    const steerReleased = createDeferred();
    const rawSteer = createDeferred<{ outcome: 'failed' }>();
    const deliveredSteers: ContentBlock[][] = [];
    let steering: ReturnType<SessionExecutionService['steerSession']> | undefined;
    const termination = createDeferred();
    let terminationRequested = false;
    let nativePending = false;
    let promptSignal: AbortSignal | undefined;
    const delivered: ContentBlock[][] = [];
    const agentClient = new AgentClient({
      sessionId: 'session-prompt-cancel' as SessionId,
      logger: createSilentLogger(),
      terminalManager: {} as never,
      agentConfig: { cliType: 'builtin', agentType: 'codex' },
      onUpdateMessage: () => {},
      onRequestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
    });
    // Keep the real AgentClient's local abort and raw ACP tracking behavior.
    // @ts-expect-error - inject an already-created ACP session at the transport boundary
    agentClient.acpSessionId = 'acp-prompt-cancel' as ACPSessionId;
    // @ts-expect-error - only prompt and cancel transport methods are needed here
    agentClient.connection = {
      request: async (_method: string, request: { prompt: ContentBlock[] }) => {
        deliveredSteers.push(request.prompt);
        steerSubmitted.resolve();
        return rawSteer.promise;
      },
      cancel: async () => {
        cancelSubmitted.resolve();
        await cancelAck.promise;
        if (completion === 'cancel-rejected' || completion === 'late-cancel-rejected') {
          throw new Error('Synthetic cancellation rejection');
        }
      },
      prompt: async ({ prompt }: PromptRequest): Promise<PromptResponse> => {
        if (nativePending) throw new RequestError(-32600, 'A Codex prompt is already active');
        delivered.push(prompt);
        if (delivered.length > 1) return { stopReason: 'end_turn' };
        nativePending = true;
        promptStarted.resolve();
        try {
          return await nativeTerminal.promise;
        } finally {
          nativePending = false;
        }
      },
    };
    const sendPrompt = agentClient.prompt.bind(agentClient);
    vi.spyOn(agentClient, 'prompt').mockImplementation((id, blocks, options) => {
      promptSignal = options?.signal;
      return sendPrompt(id, blocks, options);
    });
    if (lateApplied) {
      vi.spyOn(agentClient, 'getAcknowledgedSteerCapability').mockReturnValue({
        provider: 'codex',
        appliedNotificationMethod: 'codex/steerApplied',
        upstreamTurn: 'same',
        configPolicy: 'active',
      });
      vi.spyOn(agentClient, 'steerPrompt').mockImplementation((_id, blocks) => {
        deliveredSteers.push(blocks);
        steerSubmitted.resolve();
        return {
          outcome: steerApplied.promise.then((application) => ({
            outcome: 'applied' as const,
            application,
          })),
          completion: nativeTerminal.promise,
        };
      });
    }
    if (completion === 'stalled-steer-request') {
      agentClient['acknowledgedSteerCapability'] = {
        provider: 'codex',
        requestMethod: '_session/steering',
        appliedNotificationMethod: 'codex/steerApplied',
        upstreamTurn: 'same',
        configPolicy: 'active',
      };
    }
    const session = {
      sessionId: 'session-prompt-cancel' as SessionId,
      acpSessionId: 'acp-prompt-cancel' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getGitHubCredentials: () => nativeSessionCredentials,
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {
        terminationRequested = true;
        await termination.promise;
        if (terminationFails) throw new Error('Synthetic termination failure');
        nativeTerminal.reject(new Error('Synthetic ACP connection closed'));
        if (completion === 'stalled-steer-request')
          rawSteer.reject(new Error('Synthetic ACP connection closed'));
      }),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-prompt-cancel'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const sessionManager = {
      getSession: vi.fn(() => session),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      validateSessionCredentials: vi.fn(async () => {}),
    } as unknown as SessionManager;
    const deps = createBaseDeps({
      sessionManager,
      beginConversationTurn: vi.fn((_id, userTurnId) => {
        activeTurnId =
          userTurnId === 'turn-prompt-cancel'
            ? 'assistant-prompt-cancel'
            : `assistant:${userTurnId}`;
        return activeTurnId;
      }),
      getActiveTurnId: vi.fn(() => activeTurnId),
      clearActiveTurnId: vi.fn((_sessionId, turnId) => {
        if (activeTurnId === turnId) {
          activeTurnId = undefined;
        }
      }),
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
      buildAcpPromptBlocks: async ({ inputBlocks }) => inputBlocks as ContentBlock[],
      processMessageQueue: vi.fn(async () => {}),
      recordSessionStopFailure: async (_sessionId, turnId, failure) => {
        stopFailures.push({ turnId, ...failure });
        if (completion === 'notice-write-pending') await pendingNotice.promise;
        if (completion === 'notice-write-rejected')
          throw new Error('Synthetic notice write failure');
      },
    });
    vi.mocked(deps.turnFinalization.finalizeACPState).mockImplementation(
      async (_sessionId, turnId) => {
        history = markAssistantTurnFinished(history as SessionHistoryInput[], {
          turnId,
          endedAt: 42,
        }) as Array<Record<string, unknown>>;
        expect(history[0]).toMatchObject({ id: 'turn-prompt-cancel', status: 'canceled' });
      }
    );
    const service = new SessionExecutionService(deps);
    const message: Parameters<SessionExecutionService['continueSession']>[0] = {
      type: 'session/chat',
      sessionId: 'session-prompt-cancel' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: { kind: 'github', repoFullName: 'owner/repo', branch: 'main' },
      acpSessionConfig: { prompt: '/compact', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-prompt-cancel',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    };
    const nextMessage = {
      ...message,
      userTurnId: 'next-user-turn',
      acpSessionConfig: { ...message.acpSessionConfig, prompt: 'continue' },
    };
    const running = service.continueSession(message, {});
    try {
      await promptStarted.promise;
      expect(service.getActiveInvocationContext(message.sessionId)?.sourceTurnId).toBe(
        message.userTurnId
      );
      if (lateApplied || completion === 'stalled-steer-request') {
        history.push({
          id: 'steer-user-turn',
          role: 'user',
          status: 'pending_apply',
          inputConfig: { prompt: 'change direction' },
        });
        steering = service.steerSession({
          sessionId: message.sessionId,
          expectedTurnId: 'assistant-prompt-cancel',
          userTurnId: 'steer-user-turn',
          userId: 'steer-requester',
          timestamp: '2026-09-13T00:00:00.000Z',
          inputConfig: { prompt: 'change direction' },
        });
        await steerSubmitted.promise;
      }
      await expect(
        service.cancelSession(
          {
            type: 'session/cancel',
            sessionId: message.sessionId,
            machineId: message.machineId,
            workspaceId: message.workspaceId,
            turnId: 'assistant-prompt-cancel',
          },
          { pendingInput: 'promote' }
        )
      ).resolves.toEqual({ success: true });
      await cancelSubmitted.promise;
      if (completion !== 'cancel-unacknowledged' && completion !== 'late-cancel-rejected') {
        cancelAck.resolve();
      }
      await vi.advanceTimersByTimeAsync(0);
      if (completion === 'cancel-rejected') {
        expect(stopFailures).toEqual([
          {
            turnId: 'assistant-prompt-cancel',
            phase: 'cancel',
            message: expect.stringContaining('Synthetic cancellation rejection'),
          },
        ]);
      } else {
        expect(stopFailures).toEqual([]);
      }
      if (steering && lateApplied) {
        steerApplied.resolve({ release: () => steerReleased.resolve() });
        await expect(steering).resolves.toMatchObject({
          applied: false,
          disposition: completion === 'late-steer-write-failure' ? 'error' : 'stale-turn',
        });
        await steerReleased.promise;
        // Physical ownership remains, but canceled model work no longer has delegation authority.
        expect(service.getActiveInvocationContext(message.sessionId)).toBeUndefined();
        expect(service.getActiveUserTurnId(message.sessionId)).toBe(message.userTurnId);
        expect(meta.processingUserMsgId).toBe(message.userTurnId);
        expect(meta.latestUserMsgId).not.toBe('steer-user-turn');
        expect(history.find((entry) => entry.id === 'steer-user-turn')).toMatchObject({
          status: completion === 'late-steer-write-failure' ? 'pending_apply' : 'canceled',
        });
      }
      expect(agentClient.pendingPromptCompletion).not.toBeNull();
      expect(service.getExecutionSnapshot(message.sessionId)).toMatchObject({
        hasActiveTurn: true,
        activeTurnId: 'assistant-prompt-cancel',
      });
      expect(promptSignal?.aborted).toBe(false);
      expect(history[0]).toMatchObject({ status: 'processing' });
      expect(history[1]).not.toHaveProperty('finished', true);
      if (completion === 'stalled-steer-request') {
        nativeTerminal.resolve({ stopReason: 'cancelled' });
        await vi.advanceTimersByTimeAsync(0);
        expect(agentClient.pendingPromptCompletion).not.toBeNull();
        const releaseRewrite = service.tryAcquireSessionRewriteBarrier(message.sessionId);
        expect(releaseRewrite).not.toBeNull();
        releaseRewrite?.();
      }
      history.push({
        id: nextMessage.userTurnId,
        role: 'user',
        status: 'pending',
        items: [{ type: 'text', text: 'continue' }],
      });
      meta.latestUserMsgId = nextMessage.userTurnId;
      await service.continueSession(nextMessage);
      expect(delivered).toEqual([[{ type: 'text', text: '/compact' }]]);
      expect(history.find((entry) => entry.id === nextMessage.userTurnId)).toMatchObject({
        status: 'pending',
      });
      expect(deps.recordChatFailure).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(terminationRequested).toBe(false);
      // A repeated Stop must neither abort the owner nor restart its deadline.
      await service.cancelSession(
        {
          type: 'session/cancel',
          sessionId: message.sessionId,
          machineId: message.machineId,
          workspaceId: message.workspaceId,
          turnId: 'assistant-prompt-cancel',
        },
        { pendingInput: 'promote' }
      );
      if (nativeCompletion) {
        nativeTerminal.resolve({ stopReason: 'cancelled' });
      } else {
        await vi.advanceTimersByTimeAsync(1);
        expect(terminationRequested).toBe(true);
        expect(stopFailures).toContainEqual({
          turnId: 'assistant-prompt-cancel',
          phase: 'timeout',
          message: expect.stringContaining('ACP prompt cancellation timed out'),
        });
        expect(promptSignal?.aborted).toBe(false);
        expect(history[1]).not.toHaveProperty('finished', true);
        expect(service.getExecutionSnapshot(message.sessionId)).toMatchObject({
          hasActiveTurn: true,
        });
        await service.continueSession(nextMessage);
        expect(delivered).toEqual([[{ type: 'text', text: '/compact' }]]);
        termination.resolve();
        await vi.advanceTimersByTimeAsync(0);
        if (terminationFails) {
          await vi.advanceTimersByTimeAsync(5_000);
          expect(stopFailures).toEqual([
            {
              turnId: 'assistant-prompt-cancel',
              phase: 'timeout',
              message: expect.stringContaining('ACP prompt cancellation timed out'),
            },
            {
              turnId: 'assistant-prompt-cancel',
              phase: 'terminate',
              message: expect.stringContaining('Synthetic termination failure'),
            },
          ]);
          expect(agentClient.pendingPromptCompletion).not.toBeNull();
          await running;
          expect(promptSignal?.aborted).toBe(true);
          expect(service.getExecutionSnapshot(message.sessionId).hasActiveTurn).toBe(false);
          nativeTerminal.resolve({ stopReason: 'cancelled' });
        }
      }
      await running;
      expect(service.getExecutionSnapshot(message.sessionId).hasActiveTurn).toBe(false);
      cancelAck.resolve();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(stopFailures).toHaveLength(
        nativeCompletion ? 0 : terminationFails || completion === 'cancel-rejected' ? 2 : 1
      );
      expect(terminationRequested).toBe(!nativeCompletion);
    } finally {
      pendingNotice.resolve();
      steerApplied.resolve({ release: () => steerReleased.resolve() });
      cancelAck.resolve();
      termination.resolve();
      nativeTerminal.resolve({ stopReason: 'cancelled' });
      rawSteer.resolve({ outcome: 'failed' });
      await running;
      await steering;
      vi.useRealTimers();
    }

    expect(agentClient.pendingPromptCompletion).toBeNull();
    expect(service.getExecutionSnapshot(message.sessionId)).toMatchObject({ hasActiveTurn: false });
    expect(deps.processMessageQueue).not.toHaveBeenCalled();
    expect(sessionDoc.setStatus).toHaveBeenCalledWith(SessionStatusFactory.idle());
    // Stopping mid-prompt is the common Stop, and it never reaches finalizeTurn.
    // The agent's work is still unpublished with nothing to commit or push it,
    // so this route has to refresh the flags that raise Commit & Push.
    expect(deps.turnFinalization.syncWorkspaceGitState).toHaveBeenCalledWith(
      'session-prompt-cancel',
      expect.anything(),
      expect.any(AbortSignal)
    );
    expect(history[0]).toMatchObject({ id: 'turn-prompt-cancel', status: 'canceled' });
    expect(history[1]).toMatchObject({
      id: 'assistant-prompt-cancel',
      finished: true,
      items: [
        expect.objectContaining({
          toolCallId: 'compact-cancelled-turn',
          status: 'failed',
        }),
      ],
    });
    expect(upsertDocMeta).toHaveBeenCalledWith('session-session-prompt-cancel', {
      lastHandledUserMsgId: 'turn-prompt-cancel',
      processingUserMsgId: undefined,
    });
    await service.continueSession(nextMessage);
    expect(delivered).toEqual([
      [{ type: 'text', text: '/compact' }],
      [{ type: 'text', text: 'continue' }],
    ]);
    expect(history.find((entry) => entry.id === nextMessage.userTurnId)).toMatchObject({
      status: 'handled',
    });
    if (steering) {
      expect(deliveredSteers).toEqual([[{ type: 'text', text: 'change direction' }]]);
      expect(history.find((entry) => entry.id === 'steer-user-turn')).toMatchObject({
        status:
          completion === 'stalled-steer-request'
            ? 'delivery_unknown'
            : completion === 'late-steer-write-failure'
              ? 'pending_apply'
              : 'canceled',
      });
    }
    expect(meta).toMatchObject({
      latestUserMsgId: nextMessage.userTurnId,
      lastHandledUserMsgId: nextMessage.userTurnId,
    });
    expect(deps.recordChatFailure).not.toHaveBeenCalled();
    expect(service.getExecutionSnapshot(message.sessionId)).toMatchObject({ hasActiveTurn: false });
  });

  it.each(['resolved', 'rejected', 'timeout', 'termination-failed'] as const)(
    'keeps ownership through raw ACP drain after external owner interruption (%s)',
    async (completion) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const rawPrompt = createDeferred();
      const termination = createDeferred();
      const promptStarted = createDeferred();
      const drainStarted = createDeferred();
      const terminationStarted = createDeferred();
      const sessionId = 'session-prompt-cancel-drain' as SessionId;
      const userTurnId = 'turn-prompt-cancel-drain';
      let meta: Record<string, unknown> = {};
      let history: Array<Record<string, unknown>> = [
        {
          id: userTurnId,
          role: 'user',
          status: 'pending',
          read: false,
          items: [{ type: 'text', text: 'old request' }],
        },
        {
          id: `assistant:${userTurnId}`,
          role: 'assistant',
          timestamp: '2026-09-10T00:00:00.000Z',
          fileDiff: [],
          items: [
            {
              type: 'tool_call',
              toolCallId: 'compact-cancel-drain',
              title: 'Context compacting',
              status: 'in_progress',
              activityKind: 'context_compaction',
            },
          ],
        },
      ];
      let status: unknown;
      const sessionDoc = withHistoryPort({
        getMetaState: vi.fn(async () => ({ isArchived: false })),
        setStatus: vi.fn(async (next: unknown) => {
          status = next;
        }),
        setBaseBranch: vi.fn(async () => {}),
        getHistory: vi.fn(() => history),
        updateHistory: vi.fn(async (update: (prev: typeof history) => typeof history) => {
          history = update(history);
        }),
      });
      let activeTurnId: string | undefined;
      let promptSignal: AbortSignal | undefined;
      let rawPending = true;
      let terminated = false;
      const delivered: unknown[][] = [];
      const rawCompletion = rawPrompt.promise.then(
        () => {
          rawPending = false;
        },
        () => {
          rawPending = false;
        }
      );
      const agentClient = {
        isCreated: () => !terminated,
        // A cancel notification need not acknowledge provider cleanup.
        cancel: () => new Promise<never>(() => {}),
        get pendingPromptCompletion(): Promise<void> | null {
          drainStarted.resolve();
          return rawPending ? rawCompletion : null;
        },
        prompt: (
          _acpSessionId: ACPSessionId,
          blocks: unknown[],
          options?: { signal?: AbortSignal }
        ) => {
          delivered.push(blocks);
          if (delivered.length > 1) return Promise.resolve({});
          promptSignal = options?.signal;
          promptStarted.resolve();
          return new Promise<never>((_resolve, reject) => {
            if (promptSignal?.aborted) {
              reject(new Error('Agent prompt aborted'));
              return;
            }
            promptSignal?.addEventListener(
              'abort',
              () => reject(new Error('Agent prompt aborted')),
              { once: true }
            );
          });
        },
        currentModel: undefined,
      };
      const session = {
        sessionId,
        acpSessionId: 'acp-prompt-cancel-drain' as ACPSessionId,
        agentClient,
        terminalManager: {} as unknown,
        getWorkdir: () => '/tmp',
        getGitHubCredentials: () => nativeSessionCredentials,
        getHostWorkdir: () => '/tmp',
        getParentSessionId: () => undefined,
        exec: vi.fn(async () => ''),
        terminate: async () => {
          terminationStarted.resolve();
          await termination.promise;
          if (completion === 'termination-failed') throw new Error('Synthetic termination failure');
          terminated = true;
        },
        updateGitIdentity: vi.fn(),
        createAgent: vi.fn(async () => 'acp-prompt-cancel-drain'),
        applyExecutionPlaneLimits: vi.fn(async () => {}),
      };
      const sessionManager = {
        getSession: () => session,
        getPendingSession: () => null,
        createSession: vi.fn(),
        setSessionError: vi.fn(),
        terminateSession: vi.fn(),
        validateSessionCredentials: vi.fn(async () => {}),
      } as unknown as SessionManager;
      const activePresence = new Map<SessionId, SessionStatus>();
      const presence = new SessionActivePresenceControllerLegacy(
        {
          publishSessionPresence: (id: SessionId, _machine: MachineId, value: SessionStatus) => {
            activePresence.set(id, value);
          },
          clearSessionPresence: (id: SessionId) => activePresence.delete(id),
        } as unknown as LoroDocumentManager,
        'machine-1' as MachineId,
        createSilentLogger()
      );
      const deps = createBaseDeps({
        sessionManager,
        holdSessionActivePresence: (id, phase) => presence.native.hold(id, phase),
        setSessionActivePresencePhase: (id, phase, detail) => presence.setPhase(id, phase, detail),
        clearSessionActivePresence: (id) => presence.clearUnleased(id),
        beginConversationTurn: (_id, turn) => {
          activeTurnId = `assistant:${turn}`;
          return activeTurnId;
        },
        getActiveTurnId: () => activeTurnId,
        clearActiveTurnId: (_id, turn) => {
          if (activeTurnId === turn) activeTurnId = undefined;
        },
        workspaceDocument: {
          repo: {
            upsertDocMeta: async (_id: string, patch: Record<string, unknown>) => {
              meta = { ...meta, ...patch };
            },
            getDocMeta: async () => ({ meta }),
          },
          getOrCreateSessionDoc: async () => sessionDoc,
          updateAcpCapabilities: vi.fn(async () => {}),
        } as unknown as LoroDocumentManager,
        buildAcpPromptBlocks: async ({ inputBlocks }) => inputBlocks as ContentBlock[],
      });
      vi.mocked(deps.turnFinalization.finalizeACPState).mockImplementation(
        async (_sessionId, turnId) => {
          history = markAssistantTurnFinished(history as SessionHistoryInput[], {
            turnId,
            endedAt: 42,
          }) as Array<Record<string, unknown>>;
        }
      );
      const service = new SessionExecutionService(deps);
      const message: Parameters<SessionExecutionService['continueSession']>[0] = {
        type: 'session/chat',
        sessionId,
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        project: { kind: 'github', repoFullName: 'owner/repo', branch: 'main' },
        acpSessionConfig: { prompt: 'old request', cliType: 'builtin', agentType: 'codex' },
        userTurnId,
        userId: 'user-1',
        userName: 'User',
        userEmail: 'user@example.com',
      };
      const nextMessage = {
        ...message,
        userTurnId: 'turn-new-request',
        acpSessionConfig: { ...message.acpSessionConfig, prompt: 'new request' },
      };
      const running = service.continueSession(message);
      try {
        await promptStarted.promise;
        await expect(
          service.cancelSession({
            type: 'session/cancel',
            sessionId,
            machineId: 'machine-1',
            workspaceId: 'workspace-1' as WorkspaceId,
            turnId: `assistant:${userTurnId}`,
          })
        ).resolves.toEqual({ success: true });
        const owner = (
          service as unknown as {
            turnRuntimeBySession: Map<SessionId, { fiber?: Fiber.Fiber<unknown, unknown> }>;
          }
        ).turnRuntimeBySession.get(sessionId);
        if (!owner?.fiber) throw new Error('Expected the running turn owner');
        const released = service
          .waitForTurnRelease(sessionId, `assistant:${userTurnId}`)
          .then(() => {
            expect(activePresence.has(sessionId)).toBe(false);
            expect(presence.has(sessionId)).toBe(false);
          });
        // External teardown can still interrupt the owner; normal Stop no longer does.
        void Effect.runPromise(Fiber.interrupt(owner.fiber));
        await Promise.race([drainStarted.promise, running]);
        await vi.advanceTimersByTimeAsync(0);
        expect(promptSignal?.aborted).toBe(true);
        expect(status).toEqual(SessionStatusFactory.idle());
        expect(history[0]).toMatchObject({ id: userTurnId, status: 'canceled' });
        expect(meta).toMatchObject({
          lastHandledUserMsgId: userTurnId,
          processingUserMsgId: undefined,
        });
        expect(service.getExecutionSnapshot(sessionId)).toMatchObject({ hasActiveTurn: true });
        expect(activePresence.get(sessionId)?.type).toBe('running');
        expect(presence.has(sessionId)).toBe(true);
        // The entry is already stamped finished here, so its compaction marker
        // is settled with it — a still-spinning row on a finished turn is the
        // state finalization exists to remove. A compaction that does reach a
        // terminal update during the drain still lands: history merges tool
        // calls by id, so the provider's own status wins afterwards.
        expect(history[1]).toMatchObject({
          id: `assistant:${userTurnId}`,
          finished: true,
          items: [
            expect.objectContaining({
              toolCallId: 'compact-cancel-drain',
              status: 'failed',
            }),
          ],
        });
        await service.continueSession(nextMessage);
        expect(delivered).toEqual([[{ type: 'text', text: 'old request' }]]);

        if (completion === 'timeout' || completion === 'termination-failed') {
          await vi.advanceTimersByTimeAsync(5_000);
          await terminationStarted.promise;
          expect(terminated).toBe(false);
          expect(service.getExecutionSnapshot(sessionId)).toMatchObject({ hasActiveTurn: true });
          await service.continueSession(nextMessage);
          expect(delivered).toEqual([[{ type: 'text', text: 'old request' }]]);
          termination.resolve();
          if (completion === 'termination-failed') rawPrompt.resolve();
          await running;
          expect(terminated).toBe(completion === 'timeout');
        } else {
          if (completion === 'resolved') rawPrompt.resolve();
          else rawPrompt.reject(new Error('Synthetic ACP connection closed'));
          await running;
          expect(terminated).toBe(false);
        }
        await released;
        if (completion === 'timeout') {
          // Local cancellation can release the turn slot before transport drain.
          expect(rawPending).toBe(true);
          expect(service.inspectClientLoss().bookkeeping).toBeGreaterThan(0);
          rawPrompt.resolve();
          await rawCompletion;
        }
        expect(service.getExecutionSnapshot(sessionId)).toMatchObject({ hasActiveTurn: false });
        expect(activePresence.has(sessionId)).toBe(false);
        expect(presence.has(sessionId)).toBe(false);
        expect(history[1]).toMatchObject({
          id: `assistant:${userTurnId}`,
          finished: true,
          items: [
            expect.objectContaining({
              toolCallId: 'compact-cancel-drain',
              status: 'failed',
            }),
          ],
        });
        if (completion !== 'timeout' && completion !== 'termination-failed') {
          await service.continueSession(nextMessage);
          expect(delivered).toEqual([
            [{ type: 'text', text: 'old request' }],
            [{ type: 'text', text: 'new request' }],
          ]);
        }
      } finally {
        rawPrompt.resolve();
        termination.resolve();
        await presence.close();
        vi.useRealTimers();
      }
    }
  );

  it('flushes cancellation when a cancelled prompt resolves before finalization starts', async () => {
    vi.useFakeTimers();
    try {
      let meta: Record<string, unknown> = {};
      const upsertDocMeta = vi.fn(async (_roomId: string, patch: Record<string, unknown>) => {
        meta = { ...meta, ...patch };
      });
      const sessionDoc = withHistoryPort({
        getMetaState: vi.fn(async () => ({ isArchived: false })),
        setStatus: vi.fn(async () => {}),
        setBaseBranch: vi.fn(async () => {}),
        getHistory: vi.fn(() => []),
        updateHistory: vi.fn(async () => {}),
      });
      let activeTurnId: string | undefined;
      let service: SessionExecutionService;
      const agentClient = {
        isCreated: vi.fn(() => true),
        cancel: vi.fn(async () => {}),
        prompt: vi.fn(async () => {
          const result = await service.cancelSession({
            type: 'session/cancel',
            sessionId: 'session-prompt-cancel-resolved' as SessionId,
            machineId: 'machine-1',
            workspaceId: 'workspace-1' as WorkspaceId,
            turnId: 'assistant-prompt-cancel-resolved',
          });
          expect(result).toEqual({ success: true });
          return {};
        }),
        currentModel: undefined,
      };
      const session = {
        sessionId: 'session-prompt-cancel-resolved' as SessionId,
        acpSessionId: 'acp-prompt-cancel-resolved' as ACPSessionId,
        agentClient,
        terminalManager: {} as unknown,
        getWorkdir: () => '/tmp',
        getGitHubCredentials: () => nativeSessionCredentials,
        getHostWorkdir: () => '/tmp',
        getParentSessionId: () => undefined,
        exec: vi.fn(async () => ''),
        terminate: vi.fn(async () => {}),
        updateGitIdentity: vi.fn(),
        createAgent: vi.fn(async () => 'acp-prompt-cancel-resolved'),
        applyExecutionPlaneLimits: vi.fn(async () => {}),
      };
      const sessionManager = {
        getSession: vi.fn(() => session),
        getPendingSession: vi.fn(() => null),
        createSession: vi.fn(),
        setSessionError: vi.fn(),
        terminateSession: vi.fn(),
        validateSessionCredentials: vi.fn(async () => {}),
      } as unknown as SessionManager;
      const deps = createBaseDeps({
        sessionManager,
        beginConversationTurn: vi.fn(() => {
          activeTurnId = 'assistant-prompt-cancel-resolved';
          return activeTurnId;
        }),
        getActiveTurnId: vi.fn(() => activeTurnId),
        clearActiveTurnId: vi.fn((_sessionId, turnId) => {
          if (activeTurnId === turnId) {
            activeTurnId = undefined;
          }
        }),
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
        buildAcpPromptBlocks: vi.fn(async () => [{ type: 'text', text: 'hello' }] as any),
        processMessageQueue: vi.fn(async () => {}),
      });

      const notificationFacts: TurnOutcomeFact[] = [];
      deps.turnFinalization.onTurnOutcome = async (fact) => {
        notificationFacts.push(fact);
      };
      let releaseRefresh = () => {};
      const refresh = new Promise<void>((resolve) => {
        releaseRefresh = resolve;
      });
      const refreshing = createDeferred<void>();
      deps.turnFinalization.refreshCodeCollabSharedState = () => {
        refreshing.resolve();
        return refresh;
      };
      service = new SessionExecutionService(deps);
      const execution = service.continueSession({
        type: 'session/chat',
        sessionId: 'session-prompt-cancel-resolved' as SessionId,
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        project: { kind: 'github', repoFullName: 'owner/repo', branch: 'main' },
        acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
        userTurnId: 'turn-prompt-cancel-resolved',
        userId: 'user-1',
        userName: 'User',
        userEmail: 'user@example.com',
      });

      await refreshing.promise;
      await vi.advanceTimersByTimeAsync(20_000);
      await execution;
      expect(
        service.getExecutionSnapshot('session-prompt-cancel-resolved' as SessionId).hasActiveTurn
      ).toBe(false);
      releaseRefresh();
      expect(notificationFacts.map((fact) => fact.outcome)).toEqual([{ kind: 'cancelled' }]);
      expect(agentClient.cancel).toHaveBeenCalledWith('acp-prompt-cancel-resolved');
      expect(deps.turnFinalization.finalizeACPState).toHaveBeenCalledTimes(2);
      expect(deps.turnFinalization.finalizeACPState).toHaveBeenLastCalledWith(
        'session-prompt-cancel-resolved',
        'assistant-prompt-cancel-resolved'
      );
      expect(deps.processMessageQueue).not.toHaveBeenCalled();
      expect(upsertDocMeta).toHaveBeenCalledWith('session-session-prompt-cancel-resolved', {
        lastHandledUserMsgId: 'turn-prompt-cancel-resolved',
        processingUserMsgId: undefined,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts a stop request during turn finalization and skips completion follow-up', async () => {
    let meta: Record<string, unknown> = {};
    let history: unknown[] = [
      {
        id: 'turn-finalizing-user',
        role: 'user',
        timestamp: new Date().toISOString(),
        status: 'pending',
        items: [{ type: 'text', text: 'hello' }],
        fileDiff: [],
      },
    ];
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => undefined),
      getHistory: vi.fn(() => history),
      updateHistory: vi.fn(async (updater: (prev: unknown[]) => unknown[]) => {
        history = updater(history);
      }),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      roomId: 'session-session-finalizing-cancel',
    });
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({})),
      currentModel: undefined,
    };
    const createdSession = {
      sessionId: 'session-finalizing-cancel' as SessionId,
      acpSessionId: 'acp-finalizing-cancel' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getGitHubCredentials: () => nativeSessionCredentials,
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-finalizing-cancel'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const sessionManager = {
      getSession: vi.fn(() => createdSession),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(async () => createdSession as unknown),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      validateSessionCredentials: vi.fn(async () => {}),
    } as unknown as SessionManager;
    const upsertDocMeta = vi.fn(async (_roomId: string, patch: Record<string, unknown>) => {
      meta = { ...meta, ...patch };
    });
    let branchOnDisk = 'feature/before-cancel';
    let publishedBranch: string | undefined;
    let service: SessionExecutionService;
    const deps = createBaseDeps({
      syncSessionBranchName: async () => {
        publishedBranch = branchOnDisk;
        return publishedBranch;
      },
      sessionManager,
      beginConversationTurn: vi.fn(() => 'assistant-finalizing-turn'),
      getActiveTurnId: vi.fn(() => undefined),
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
      buildAcpPromptBlocks: vi.fn(async () => [{ type: 'text', text: 'hello' }] as any),
      turnFinalization: {
        finalizeACPState: vi.fn(async () => {
          branchOnDisk = 'feature/after-cancel';
          const result = await service.cancelSession({
            type: 'session/cancel',
            sessionId: 'session-finalizing-cancel' as SessionId,
            machineId: 'machine-1',
            workspaceId: 'workspace-1' as WorkspaceId,
            turnId: 'assistant-finalizing-turn',
          });
          expect(result).toEqual({ success: true });
        }),
        flushSessionUsage: vi.fn(async () => {}),

        detectAndAssociatePR: vi.fn(async () => null),
        syncWorkspaceGitState: vi.fn(async () => {}),
        onTurnOutcome: vi.fn(async () => {}),
      },
      processMessageQueue: vi.fn(async () => {}),
    });

    service = new SessionExecutionService(deps);
    await service.startSession({
      type: 'session/create',
      sessionId: 'session-finalizing-cancel' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      // GitHub-capable: the dirty probe is scoped to sessions whose Info Bar can
      // actually offer Commit & Push.
      project: { kind: 'github', repoFullName: 'owner/repo', branch: 'main' },
      acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-finalizing-user',
      userId: 'user-2',
      userName: 'User 2',
      userEmail: 'user2@example.com',
    });

    expect(agentClient.cancel).not.toHaveBeenCalled();
    expect(deps.turnFinalization.onTurnOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: { kind: 'cancelled' } })
    );
    expect(deps.processMessageQueue).not.toHaveBeenCalled();
    expect(sessionDoc.setStatus).toHaveBeenCalledWith(SessionStatusFactory.idle());
    // The rest of finalization is skipped, but the interrupted turn may have
    // left unpublished work and nothing commits or pushes it now — the git-state
    // probe is the only thing that raises Commit & Push, so it still runs.
    expect(publishedBranch).toBe('feature/after-cancel');
    expect(deps.turnFinalization.syncWorkspaceGitState).toHaveBeenCalledWith(
      'session-finalizing-cancel',
      expect.anything(),
      expect.any(AbortSignal)
    );

    expect(upsertDocMeta).toHaveBeenCalledWith('session-session-finalizing-cancel', {
      lastHandledUserMsgId: 'turn-finalizing-user',
      processingUserMsgId: undefined,
    });
  });

  it('fails startSession when the agent client is missing instead of silently finalizing', async () => {
    const upsertDocMeta = vi.fn(async () => {});
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => undefined),
      getHistory: vi.fn(() => []),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      updateHistory: vi.fn(async () => {}),
      roomId: 'session-session-4',
    });
    const createdSession = {
      sessionId: 'session-4' as SessionId,
      acpSessionId: 'acp-4' as ACPSessionId,
      agentClient: undefined,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getGitHubCredentials: () => nativeSessionCredentials,
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-4'),
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
      sessionId: 'session-4' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-create-4',
      userId: 'user-4',
      userName: 'User 4',
      userEmail: 'user4@example.com',
    });

    expect(deps.turnFinalization.onTurnOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: { kind: 'failed', code: 'session_create_failed' } })
    );
    expect(sessionDoc.setStatus).toHaveBeenCalledWith(
      SessionStatusFactory.initializing(),
      expect.objectContaining({ latestUserMsgId: 'turn-create-4' })
    );
  });

  it('cancels an active session and reports success', async () => {
    const upsertDocMeta = vi.fn(async () => {});
    const sessionDoc = withHistoryPort({
      getHistory: vi.fn(() => []),
      setStatus: vi.fn(async () => {}),
      updateHistory: vi.fn(async () => {}),
    });
    const session = {
      acpSessionId: 'acp-3' as ACPSessionId,
      agentClient: {
        isCreated: vi.fn(() => true),
        cancel: vi.fn(async () => {}),
      },
    };
    const sessionManager = {
      getSession: vi.fn(() => session),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      validateSessionCredentials: vi.fn(async () => {}),
    } as unknown as SessionManager;
    const deps = createBaseDeps({
      sessionManager,
      getActiveTurnId: vi.fn(() => 'assistant-turn-1'),
      workspaceDocument: {
        repo: {
          upsertDocMeta,
          getDocMeta: vi.fn(async () => ({
            meta: {
              latestUserMsgId: 'turn-cancel-1',
              processingUserMsgId: 'turn-cancel-1',
            },
          })),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
    });

    const service = new SessionExecutionService(deps);
    const result = await service.cancelSession({
      type: 'session/cancel',
      sessionId: 'session-3' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      turnId: 'assistant-turn-1',
    });

    expect(result).toEqual({ success: true });
    expect(session.agentClient.cancel).toHaveBeenCalledWith('acp-3');
    expect(sessionDoc.setStatus).toHaveBeenCalledWith(SessionStatusFactory.idle());
    expect(upsertDocMeta).toHaveBeenCalledWith('session-session-3', {
      lastHandledUserMsgId: 'turn-cancel-1',
      processingUserMsgId: undefined,
    });
    expect(upsertDocMeta).toHaveBeenCalledWith('session-session-3', {
      lastCanceledTurn: undefined,
    });
  });

  it('keeps cancel successful when cancellation finalization side effects fail', async () => {
    const sessionDoc = withHistoryPort({
      getHistory: vi.fn(() => []),
      setStatus: vi.fn(async () => {
        throw new Error('status write failed');
      }),
      updateHistory: vi.fn(async () => {}),
    });
    const session = {
      acpSessionId: 'acp-cancel-finalizer-fail' as ACPSessionId,
      agentClient: {
        isCreated: vi.fn(() => true),
        cancel: vi.fn(async () => {}),
      },
    };
    const sessionManager = {
      getSession: vi.fn(() => session),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      validateSessionCredentials: vi.fn(async () => {}),
    } as unknown as SessionManager;
    const deps = createBaseDeps({
      sessionManager,
      getActiveTurnId: vi.fn(() => 'assistant-turn-finalizer-fail'),
      workspaceDocument: {
        repo: {
          upsertDocMeta: vi.fn(async () => {}),
          getDocMeta: vi.fn(async () => ({
            meta: {
              latestUserMsgId: 'turn-cancel-finalizer-fail',
              processingUserMsgId: 'turn-cancel-finalizer-fail',
            },
          })),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
    });

    const service = new SessionExecutionService(deps);
    const result = await service.cancelSession({
      type: 'session/cancel',
      sessionId: 'session-cancel-finalizer-fail' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      turnId: 'assistant-turn-finalizer-fail',
    });

    expect(result).toEqual({ success: true });
    expect(session.agentClient.cancel).toHaveBeenCalledWith('acp-cancel-finalizer-fail');
    expect(deps.turnFinalization.finalizeACPState).toHaveBeenCalledTimes(1);
  });

  it('ignores a cancel request for a stale turn id', async () => {
    const upsertDocMeta = vi.fn(async () => {});
    const sessionDoc = withHistoryPort({
      getHistory: vi.fn(() => []),
      setStatus: vi.fn(async () => {}),
      updateHistory: vi.fn(async () => {}),
    });
    const session = {
      acpSessionId: 'acp-stale-cancel' as ACPSessionId,
      agentClient: {
        isCreated: vi.fn(() => true),
        cancel: vi.fn(async () => {}),
      },
    };
    const sessionManager = {
      getSession: vi.fn(() => session),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      validateSessionCredentials: vi.fn(async () => {}),
    } as unknown as SessionManager;
    const deps = createBaseDeps({
      sessionManager,
      getActiveTurnId: vi.fn(() => 'assistant-turn-2'),
      workspaceDocument: {
        repo: {
          upsertDocMeta,
          getDocMeta: vi.fn(async () => ({
            meta: {
              latestUserMsgId: 'turn-running-2',
              processingUserMsgId: 'turn-running-2',
            },
          })),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
    });

    const service = new SessionExecutionService(deps);
    const result = await service.cancelSession({
      type: 'session/cancel',
      sessionId: 'session-stale-cancel' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      turnId: 'assistant-turn-1',
    });

    expect(result).toEqual({ success: true });
    expect(session.agentClient.cancel).not.toHaveBeenCalled();
    expect(upsertDocMeta).toHaveBeenCalledWith('session-session-stale-cancel', {
      lastCanceledTurn: undefined,
    });
  });

  it('finalizes a stale unfinished compaction turn when no live runtime owns it', async () => {
    const upsertDocMeta = vi.fn(async () => {});
    const compactionItem = {
      type: 'tool_call',
      toolCallId: 'context-compaction-stale',
      title: 'Context compacting',
      status: 'in_progress',
      activityKind: 'context_compaction',
    };
    const history = [
      {
        id: 'assistant-stale-compaction',
        role: 'assistant',
        items: [compactionItem],
        finished: false,
      },
    ];
    const sessionDoc = withHistoryPort({
      getHistory: vi.fn(() => history),
      setStatus: vi.fn(async () => {}),
      updateHistory: vi.fn(async (update: (value: typeof history) => typeof history) => {
        update(history);
      }),
    });
    const sessionManager = {
      getSession: vi.fn(() => null),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      validateSessionCredentials: vi.fn(async () => {}),
    } as unknown as SessionManager;
    const deps = createBaseDeps({
      sessionManager,
      getActiveTurnId: vi.fn(() => undefined),
      workspaceDocument: {
        repo: {
          upsertDocMeta,
          getDocMeta: vi.fn(async () => ({ meta: {} })),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
    });

    const service = new SessionExecutionService(deps);
    const result = await service.cancelSession({
      type: 'session/cancel',
      sessionId: 'session-stale-compaction' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      turnId: 'assistant-stale-compaction',
    });

    expect(result).toEqual({ success: true });
    expect((await sessionDoc.sessionData.history.readAll())[0]?.items[0]).toMatchObject({
      status: 'failed',
    });
    expect(sessionDoc.updateHistory).toHaveBeenCalled();
    expect(sessionDoc.setStatus).toHaveBeenCalledWith(SessionStatusFactory.idle());
    expect(upsertDocMeta).toHaveBeenCalledWith('session-session-stale-compaction', {
      lastCanceledTurn: undefined,
    });
  });
});
