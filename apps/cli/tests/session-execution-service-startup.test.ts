import { lazyExecutionJournal, makeEncryptedAgentExecution } from '../src/lib/e2ee/agent-execution';
import { RealtimeJournal } from '../src/lib/e2ee/realtime-journal';
import { type TurnOutcomeFact } from '@lody/shared/notifications';
import { type ContentBlock } from '@agentclientprotocol/sdk';
import {
  buildSessionTurnInputConfig,
  getMachineRoomId,
  inputBlocksToHistoryItems,
  SessionStatusFactory,
  type ACPSessionId,
  type AgentRoleId,
  type LocalProjectId,
  type MachineId,
  type ProjectRef,
  type SessionHistoryInput,
  type SessionId,
  type SessionInputBlock,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';
import { Effect } from 'effect';
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
  createDeferred,
  createGitLocalProject,
  createLaunchConfig,
  createSilentLogger,
  encryptedExecutionFixture,
  runGit,
  runSilentPromptTurn,
} from './session-execution-service-helpers';

vi.hoisted(() => {
  Object.assign(globalThis, { __LODY_E2E_DAEMON_LOSS__: true });
  process.env.LODY_E2E = '1';
});
describe('SessionExecutionService', () => {
  describe('encrypted shared-project scope', () => {
    const local = (id: string): ProjectRef => ({
      kind: 'local',
      localProjectId: id as LocalProjectId,
    });
    // A member granted only project p1 on this machine; the owner-signed policy decides.
    const sharedOnly = (f: ReturnType<typeof encryptedExecutionFixture>, asked: unknown[][]) =>
      makeEncryptedAgentExecution({
        machineUserId: 'synthetic-machine-account',
        genesis: 'genesis',
        workspaceId: 'workspace-1',
        targetMachineId: 'machine-1',
        journal: lazyExecutionJournal(f.filename, () => 100),
        resolveVerifiedOriginal: () =>
          Effect.succeed({
            requesterDevice: 'ab'.repeat(32),
            requesterCryptoUserId: 'member',
            expiresAt: 1000,
          }),
        authorizeExecution: (_workspaceId, _device, localProjectId) => {
          asked.push([localProjectId]);
          return Effect.succeed(
            localProjectId === undefined || localProjectId === 'p1'
              ? { _tag: 'Authorized' }
              : { _tag: 'Denied', reason: 'e2ee_machine_not_shared' }
          );
        },
      });
    it.each([
      ['the requested project', { project: local('p2') }],
      [
        'a live process whose request names a shared project',
        {
          project: local('p1'),
          liveConfig: { project: local('p2') },
        },
      ],
      ['Session meta while the request omits the project', { meta: { project: local('p2') } }],
      ['a new conversation', { project: local('p2'), create: true }],
      [
        'a Project group member',
        {
          meta: {
            projectRun: {
              id: 'group',
              name: 'Group',
              root: 'group',
              members: {
                member: {
                  o: 0,
                  src: { kind: 'local', machineId: 'machine-1', localProjectId: 'p2' },
                  placement: { kind: 'root', dir: 'p2' },
                  path: 'p2',
                  base: 'main',
                },
              },
            },
          },
        },
      ],
    ] as const)('never prompts a member on an unshared project from %s', async (_name, scope) => {
      const f = encryptedExecutionFixture();
      const asked: unknown[][] = [];
      const submissions: string[] = [];
      try {
        const result = await runSilentPromptTurn({
          sessionId: 'shared-project-session',
          hasPromptEventsForTurn: true,
          prepared: true,
          encryptedExecution: sharedOnly(f, asked),
          ...scope,
          onPrompt: async () => {
            submissions.push('hi');
          },
        });
        expect(submissions).toEqual([]);
        expect(asked).toContainEqual(['p2']);
        expect(result.failureMessages).toEqual([
          expect.stringContaining('e2ee_machine_not_shared'),
        ]);
      } finally {
        f.close();
      }
    });
    it('restores from the metadata it authorized, even if synced metadata changes meanwhile', async () => {
      const f = encryptedExecutionFixture();
      const meta: Record<string, unknown> = {};
      const started: SessionConfig[] = [];
      const asked: unknown[][] = [];
      const shared = sharedOnly(f, asked);
      // The member rewrites synced metadata while the claim is authorizing.
      const gate = {
        ...shared,
        claim: (intent: Parameters<typeof shared.claim>[0]) =>
          Effect.sync(() => {
            meta.project = local('p2');
          }).pipe(Effect.andThen(shared.claim(intent))),
      };
      try {
        const result = await runSilentPromptTurn({
          sessionId: 'shared-project-session',
          hasPromptEventsForTurn: true,
          prepared: true,
          encryptedExecution: gate,
          meta,
          restore: started,
        });
        expect(asked).toEqual([[undefined]]);
        // Before the fix the restore re-read the rewritten metadata and resolved p2.
        expect(result.failureMessages.join('\n')).not.toContain('p2');
        expect(started).toHaveLength(1);
        expect(started[0]?.project).toBeUndefined();
      } finally {
        f.close();
      }
    });
    it('refuses a Project group member added to synced metadata after authorization', async () => {
      const f = encryptedExecutionFixture();
      const group = (...ids: string[]) => ({
        id: 'group',
        name: 'Group',
        root: 'group',
        members: Object.fromEntries(
          ids.map((id, o) => [
            id,
            {
              o,
              src: { kind: 'local', machineId: 'machine-1', localProjectId: id },
              placement: { kind: 'root', dir: id },
              path: id,
              base: 'main',
            },
          ])
        ),
      });
      const meta: Record<string, unknown> = { projectRun: group('p1') };
      const started: SessionConfig[] = [];
      const asked: unknown[][] = [];
      const shared = sharedOnly(f, asked);
      const gate = {
        ...shared,
        claim: (intent: Parameters<typeof shared.claim>[0]) =>
          shared.claim(intent).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                meta.projectRun = group('p1', 'p2');
              })
            )
          ),
      };
      try {
        const result = await runSilentPromptTurn({
          sessionId: 'shared-project-session',
          hasPromptEventsForTurn: true,
          prepared: true,
          encryptedExecution: gate,
          meta,
          restore: started,
        });
        expect(asked).toEqual([['p1']]);
        // Before the fix the session manager adopted the reread group, including p2.
        expect(started).toEqual([]);
        expect(result.failureMessages.join('\n')).toContain('e2ee_machine_not_shared');
      } finally {
        f.close();
      }
    });
    it('still prompts on the shared project and in a projectless conversation', async () => {
      for (const scope of [{ project: local('p1') }, {}]) {
        const f = encryptedExecutionFixture();
        const submissions: string[] = [];
        try {
          await runSilentPromptTurn({
            sessionId: 'shared-project-session',
            hasPromptEventsForTurn: true,
            prepared: true,
            encryptedExecution: sharedOnly(f, []),
            ...scope,
            onPrompt: async () => {
              submissions.push('hi');
            },
          });
          expect(submissions).toEqual(['hi']);
        } finally {
          f.close();
        }
      }
    });
  });

  it('keeps a snapshot turn pending until its original signed update becomes available', async () => {
    const f = encryptedExecutionFixture();
    let originalAvailable = false;
    const submitted: string[] = [];
    const gate = makeEncryptedAgentExecution({
      machineUserId: 'synthetic-machine-account',
      genesis: 'genesis',
      workspaceId: 'workspace-1',
      targetMachineId: 'machine-1',
      journal: lazyExecutionJournal(f.filename, () => 100),
      resolveVerifiedOriginal: () =>
        Effect.succeed(
          originalAvailable
            ? { requesterDevice: 'ab'.repeat(32), requesterCryptoUserId: 'user-1', expiresAt: 1000 }
            : ({ state: 'pending-evidence', expiresAt: Date.now() + 1000 } as const)
        ),
      authorizeExecution: () => Effect.succeed({ _tag: 'Authorized' }),
    });
    try {
      const pending = await runSilentPromptTurn({
        sessionId: 'snapshot-pending',
        prepared: true,
        encryptedExecution: gate,
        onPrompt: async () => {
          submitted.push('hi');
        },
      });
      expect(submitted).toEqual([]);
      expect(pending.failureMessages).toEqual([]);
      expect(pending.getHistory()[0]?.status).toBe('pending');
      originalAvailable = true;
      const retried = await runSilentPromptTurn({
        sessionId: 'snapshot-pending',
        prepared: true,
        encryptedExecution: gate,
        hasPromptEventsForTurn: true,
        onPrompt: async () => {
          submitted.push('hi');
        },
      });
      expect(submitted).toEqual(['hi']);
      expect(retried.getHistory()[0]?.status).toBe('handled');
    } finally {
      f.close();
    }
  });

  it('shares the encrypted execution claim across RPC, durable dispatch and restart', async () => {
    const f = encryptedExecutionFixture();
    const started = createDeferred<void>();
    const finished = createDeferred<void>();
    const submissions: string[] = [];
    const onPrompt = async () => {
      submissions.push('hi');
      started.resolve();
      await finished.promise;
    };
    const first = runSilentPromptTurn({
      sessionId: 'encrypted-session',
      hasPromptEventsForTurn: true,
      attempts: 2,
      dispatchSource: 'rpc',
      encryptedExecution: f.gate(),
      onPrompt,
    });
    try {
      await started.promise;
      const duplicate = await runSilentPromptTurn({
        sessionId: 'encrypted-session',
        hasPromptEventsForTurn: true,
        prepared: true,
        encryptedExecution: f.gate(),
        onPrompt,
      });
      expect(submissions).toEqual(['hi']);
      expect(duplicate.getHistory()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'e2ee-interrupted:turn-user-1',
            role: 'system',
          }),
        ])
      );
      finished.resolve();
      const completed = await first;
      expect(completed.getHistory()[0]?.status).toBe('handled');
      expect(completed.failureMessages).toEqual([]);
      const restart = await runSilentPromptTurn({
        sessionId: 'encrypted-session',
        hasPromptEventsForTurn: true,
        prepared: true,
        encryptedExecution: f.gate(),
        onPrompt,
      });
      expect(submissions).toEqual(['hi']);
      expect(restart.failureMessages).toEqual([expect.stringContaining('already finished')]);
      expect(
        new RealtimeJournal(f.filename, () => 100).read({
          genesis: 'genesis',
          workspaceId: 'workspace-1',
          targetMachineId: 'machine-1',
          requestId: 'agent-start:turn-user-1',
        })?.state
      ).toBe('completed');
    } finally {
      finished.resolve();
      await first;
      f.close();
    }
  });

  it('leaves a claimed encrypted turn uncertain after restart without replaying it', async () => {
    const f = encryptedExecutionFixture();
    const submissions: string[] = [];
    try {
      expect((await Effect.runPromise(f.gate().claim(f.intent))).state).toBe('claimed');
      const recovered = await runSilentPromptTurn({
        sessionId: 'encrypted-session',
        hasPromptEventsForTurn: true,
        prepared: true,
        encryptedExecution: f.gate(),
        onPrompt: async () => {
          submissions.push('hi');
        },
      });
      expect(submissions).toEqual([]);
      const notices = recovered.getHistory().filter((entry) => entry.role === 'system');
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({
        id: 'e2ee-interrupted:turn-user-1',
        userTurnId: 'turn-user-1',
        items: [
          {
            type: 'system_notice',
            name: 'chat_failed',
            meta: {
              message: expect.stringContaining('not retried automatically'),
            },
          },
        ],
      });
      expect(recovered.getStatus().type).toBe('idle');
      expect(recovered.getHistory()[0]?.status).toBe('failed');
    } finally {
      f.close();
    }
  });

  it.each(['denied'] as const)(
    'does not start a %s encrypted turn from durable history',
    async (authorization) => {
      const f = encryptedExecutionFixture();
      const submissions: string[] = [];
      try {
        const result = await runSilentPromptTurn({
          sessionId: 'encrypted-session',
          hasPromptEventsForTurn: true,
          prepared: true,
          create: true,
          encryptedExecution: f.gate(authorization),
          onPrompt: async () => {
            submissions.push('hi');
          },
        });
        expect(submissions).toEqual([]);
        expect(result.failureMessages).toEqual([expect.stringContaining('not authorized')]);
        expect(result.getHistory()[0]?.status).toBe('failed');
        expect(
          result.service.getExecutionSnapshot('encrypted-session' as SessionId).hasActiveTurn
        ).toBe(false);
      } finally {
        f.close();
      }
    }
  );

  it('does not retry an encrypted prompt whose submission disconnected before output', async () => {
    const f = encryptedExecutionFixture();
    const submissions: string[] = [];
    try {
      const result = await runSilentPromptTurn({
        sessionId: 'encrypted-session',
        hasPromptEventsForTurn: false,
        prepared: true,
        encryptedExecution: f.gate(),
        promptFailure: new Error('ACP connection closed'),
        onPrompt: async () => {
          submissions.push('hi');
        },
      });
      expect(submissions).toEqual(['hi']);
      expect((await Effect.runPromise(f.gate().claim(f.intent))).state).toBe('uncertain');
      expect(
        result.service.getExecutionSnapshot('encrypted-session' as SessionId).hasActiveTurn
      ).toBe(false);
    } finally {
      f.close();
    }
  });

  it('contains a broken encrypted journal while ordinary and healthy dispatch continue', async () => {
    const f = encryptedExecutionFixture();
    const submissions: string[] = [];
    fs.writeFileSync(f.filename, 'damaged execution evidence');
    try {
      const broken = await runSilentPromptTurn({
        sessionId: 'encrypted-session',
        hasPromptEventsForTurn: true,
        prepared: true,
        encryptedExecution: f.gate(),
        onPrompt: async () => {
          submissions.push('broken');
        },
      });
      const ordinary = await runSilentPromptTurn({
        sessionId: 'ordinary-session',
        hasPromptEventsForTurn: true,
        prepared: true,
        onPrompt: async () => {
          submissions.push('ordinary');
        },
      });
      const healthy = await runSilentPromptTurn({
        sessionId: 'healthy-session',
        workspaceId: 'workspace-2',
        hasPromptEventsForTurn: true,
        prepared: true,
        encryptedExecution: f.gate(
          'authorized',
          path.join(f.directory, 'healthy.sqlite'),
          'workspace-2'
        ),
        onPrompt: async () => {
          submissions.push('healthy');
        },
      });
      expect(submissions).toEqual(['ordinary', 'healthy']);
      expect(ordinary.getHistory()[0]?.status).toBe('handled');
      expect(healthy.getHistory()[0]?.status).toBe('handled');
      expect(broken.getHistory()[0]?.status).toBe('failed');
      expect(fs.readFileSync(f.filename, 'utf8')).toBe('damaged execution evidence');
    } finally {
      f.close();
    }
  });

  it.each([
    { output: true, outcome: { kind: 'succeeded' } },
    { output: false, outcome: { kind: 'failed', code: 'no_agent_output' } },
  ])(
    'publishes the trusted terminal fact with the frozen requester ($outcome.kind)',
    async ({ output, outcome }) => {
      const { notificationFacts, getHistory } = await runSilentPromptTurn({
        sessionId: 'notification-source',
        hasPromptEventsForTurn: output,
      });
      expect(notificationFacts).toEqual([
        {
          scope: { workspaceId: 'workspace-1', recipientId: 'user-1' },
          sessionId: 'notification-source',
          assistantTurnId: 'assistant:turn-user-1',
          originTurnIds: ['turn-user-1'],
          turnId: 'turn-user-1',
          audience: { kind: 'user' },
          outcome,
        },
      ]);
      expect(getHistory()[0]?.status).toBe(output ? 'handled' : 'failed');
    }
  );

  it('preserves delegated audience on the terminal fact without substituting the host owner', async () => {
    const audience = {
      kind: 'agent',
      sessionId: 'parent' as SessionId,
      turnId: 'parent-input',
    } as const;
    const { notificationFacts } = await runSilentPromptTurn({
      sessionId: 'notification-child',
      hasPromptEventsForTurn: true,
      notificationAudience: audience,
    });
    expect(notificationFacts).toEqual([
      {
        scope: { workspaceId: 'workspace-1', recipientId: 'user-1' },
        sessionId: 'notification-child',
        assistantTurnId: 'assistant:turn-user-1',
        originTurnIds: [],
        turnId: 'turn-user-1',
        audience,
        outcome: { kind: 'succeeded' },
      },
    ]);
  });

  it('publishes provider failure separately from successful completion', async () => {
    const { notificationFacts, getHistory } = await runSilentPromptTurn({
      sessionId: 'notification-failure',
      hasPromptEventsForTurn: true,
      promptFailure: new Error('synthetic provider failure'),
    });
    expect(notificationFacts).toEqual([
      {
        scope: { workspaceId: 'workspace-1', recipientId: 'user-1' },
        sessionId: 'notification-failure',
        assistantTurnId: 'assistant:turn-user-1',
        originTurnIds: ['turn-user-1'],
        turnId: 'turn-user-1',
        audience: { kind: 'user' },
        outcome: { kind: 'failed', code: 'session_chat_failed' },
      },
    ]);
    expect(getHistory()[0]?.status).toBe('failed');
  });

  it('retains disconnected execution as unknown instead of claiming success', async () => {
    const { notificationFacts } = await runSilentPromptTurn({
      sessionId: 'notification-disconnected',
      hasPromptEventsForTurn: true,
      promptFailure: new Error('Connection is disposed'),
    });
    expect(notificationFacts.map((fact) => fact.outcome)).toEqual([
      { kind: 'unknown', code: 'agent_disconnected' },
    ]);
  });

  it('a failed notification is attempted once without replaying the completed provider turn', async () => {
    const attempts: TurnOutcomeFact[] = [];
    const { notificationFacts, getHistory, agentClient } = await runSilentPromptTurn({
      sessionId: 'notification-store-failure',
      hasPromptEventsForTurn: true,
      onTurnOutcome: async (fact) => {
        attempts.push(fact);
        throw new Error('synthetic notification failure');
      },
    });
    expect(notificationFacts).toEqual([]);
    expect(attempts.map((fact) => fact.outcome)).toEqual([{ kind: 'succeeded' }]);
    expect(getHistory()[0]?.status).toBe('handled');
    expect(agentClient.prompt).toHaveBeenCalledOnce();
  });

  it('fails a turn whose prompt completed without emitting any agent output', async () => {
    const { deps, sessionDoc, notificationFacts, upsertDocMeta, agentClient, getHistory } =
      await runSilentPromptTurn({
        sessionId: 'session-silent-turn',
        hasPromptEventsForTurn: false,
      });

    expect(agentClient.prompt).toHaveBeenCalled();
    expect(deps.recordChatFailure).toHaveBeenCalledWith(
      sessionDoc,
      'agent_no_output',
      expect.stringContaining('without producing any output')
    );
    expect(getHistory()[0]?.status).toBe('failed');
    // Claiming the session finished would contradict the failure shown in chat.
    expect(notificationFacts.some((fact) => fact.outcome.kind === 'succeeded')).toBe(false);
    // The pointer still advances: the prompt was delivered, so re-dispatching it
    // would repeat the same silent failure forever.
    expect(upsertDocMeta).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        lastHandledUserMsgId: 'turn-user-1',
        lastFailedUserMsgId: 'turn-user-1',
        processingUserMsgId: undefined,
      })
    );
  });

  it('publishes a single successful output fact', async () => {
    const { deps, getHistory, notificationFacts } = await runSilentPromptTurn({
      sessionId: 'session-output-turn',
      hasPromptEventsForTurn: true,
    });

    expect(deps.recordChatFailure).not.toHaveBeenCalled();
    expect(getHistory()[0]?.status).toBe('handled');
    expect(notificationFacts).toHaveLength(1);
    expect(notificationFacts[0]?.outcome).toEqual({ kind: 'succeeded' });
  });

  it.each([
    {
      content: false as const,
      status: 'failed',
      outcome: { kind: 'failed', code: 'no_agent_output' },
    },
    { content: 'unobservable' as const, status: 'handled', outcome: { kind: 'succeeded' } },
  ])(
    'settles content independently of replay evidence ($content)',
    async ({ content, status, outcome }) => {
      const result = await runSilentPromptTurn({
        sessionId: 'independent-observations',
        hasPromptEventsForTurn: true,
        content,
      });
      expect(result.getHistory()[0]?.status).toBe(status);
      expect(result.notificationFacts.map((fact) => fact.outcome)).toEqual([outcome]);
      expect(
        result.service.getExecutionSnapshot('independent-observations' as SessionId).hasActiveTurn
      ).toBe(false);
    }
  );

  it.each(['agent', 'human'] as const)(
    'uses the exact %s-authored input for completion notifications',
    async (kind) => {
      const agentAuthor = {
        v: 1,
        kind: 'agent',
        sessionId: 'sender-session',
        turnId: 'sender-turn',
        name: 'Agent',
      } as const;
      const { deps, notificationFacts, getHistory, getStatus, finalizationOwners } =
        await runSilentPromptTurn({
          sessionId: `session-notify-${kind}`,
          hasPromptEventsForTurn: true,
          notificationAudience:
            kind === 'agent'
              ? { kind: 'agent', sessionId: 'sender-session' as SessionId, turnId: 'sender-turn' }
              : { kind: 'user' },
          inputAuthor: kind === 'agent' ? agentAuthor : { v: 1, kind: 'human', userId: 'user-1' },
          earlierInputAuthor: kind === 'human' ? agentAuthor : undefined,
        });
      const completed = getHistory().find((entry) => entry.id === 'turn-user-1');
      expect(completed?.status).toBe('handled');
      expect(getHistory().find((entry) => entry.id === 'assistant:turn-user-1')?.finished).toBe(
        true
      );
      expect(finalizationOwners).toEqual([true]);
      expect(getStatus()).toEqual(SessionStatusFactory.idle());
      expect(deps.recordChatFailure).not.toHaveBeenCalled();
      expect(notificationFacts[0]?.audience.kind).toBe(kind === 'human' ? 'user' : 'agent');
    }
  );

  it('rejects a chat turn before prompt when memory pressure persists', async () => {
    let history: Array<Record<string, unknown>> = [
      {
        id: 'turn-user-1',
        role: 'user',
        status: 'pending',
        read: false,
      },
    ];
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({})),
      currentModel: undefined,
    };
    const activeSession = {
      sessionId: 'session-1' as SessionId,
      acpSessionId: 'acp-1' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-1'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => ({ isArchived: false })),
      setStatus: vi.fn(async () => {}),
      getHistory: vi.fn(() => history),
      updateHistory: vi.fn(async (updater: (prev: typeof history) => typeof history) => {
        history = updater(history);
      }),
    });
    const upsertDocMeta = vi.fn(async () => {});
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
          getDocMeta: vi.fn(async () => undefined),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
      evictForMemoryPressure: vi.fn(async () => ({
        availableMemoryBytes: 64 * 1024 * 1024,
        thresholdBytes: 1024 * 1024 * 1024,
        hadMemoryPressure: true,
        stillUnderPressure: true,
        evictedSessionIds: [],
        pressureReason: 'physical',
      })),
    });

    const service = new SessionExecutionService(deps);
    await service.continueSession({
      type: 'session/chat',
      sessionId: 'session-1' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: undefined,
      acpSessionConfig: { prompt: 'hi', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-user-1',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(deps.recordChatFailure).toHaveBeenCalledWith(
      sessionDoc,
      'memory_pressure',
      expect.stringContaining('The turn was not started')
    );
    expect(history[0]?.status).toBe('failed');
    expect(agentClient.prompt).not.toHaveBeenCalled();
    expect(deps.touchSession).toHaveBeenCalled();
    expect(upsertDocMeta).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        lastHandledUserMsgId: 'turn-user-1',
        processingUserMsgId: undefined,
      })
    );
  });

  it('exposes RPC invocation identity before prepared dispatch awaits machine access', async () => {
    let resolveAccess!: (value: {
      outcome: 'indeterminate';
      cause: 'network';
      error: string;
    }) => void;
    const accessPromise = new Promise<{
      outcome: 'indeterminate';
      cause: 'network';
      error: string;
    }>((resolve) => {
      resolveAccess = resolve;
    });
    const onAccessAllowed = vi.fn(async () => {});
    const onAccessDenied = vi.fn(async () => {});
    const onAccessIndeterminate = vi.fn(async () => {});
    const sessionDoc = {} as never;
    const deps = createBaseDeps({
      beginConversationTurn: vi.fn((_sessionId: SessionId, turn?: string) =>
        turn ? `assistant:${turn}` : 'turn-1'
      ),
    });
    const service = new SessionExecutionService(deps);

    const dispatchPromise = service.dispatchPreparedSessionTurn({
      sessionId: 'session-prepared-presence' as SessionId,
      sessionDoc,
      userTurnId: 'turn-prepared-presence',
      invocation: {
        sourceTurnId: 'turn-prepared-presence',
        requesterUserId: 'user-b',
        inputConfig: { prompt: 'fast path prompt' },
      },
      dispatchSource: 'rpc',
      accessPromise,
      requestPromise: new Promise<never>(() => {}),
      onAccessAllowed,
      onAccessDenied,
      onAccessIndeterminate,
    });

    expect(deps.beginConversationTurn).toHaveBeenCalledWith(
      'session-prepared-presence',
      'turn-prepared-presence',
      { dispatchSource: 'rpc', sessionDoc, deferACPUpdateTarget: true }
    );
    expect(service.getExecutionSnapshot('session-prepared-presence' as SessionId)).toMatchObject({
      activeTurnId: 'assistant:turn-prepared-presence',
      hasActiveTurn: true,
    });
    expect(service.getActiveInvocationContext('session-prepared-presence' as SessionId)).toEqual({
      notificationOriginTurnIds: [],
      notificationProvenancePending: true,
      requesterUserId: 'user-b',
      sourceTurnId: 'turn-prepared-presence',
      inputConfig: { prompt: 'fast path prompt' },
    });
    expect(onAccessAllowed).not.toHaveBeenCalled();

    resolveAccess({ outcome: 'indeterminate', cause: 'network', error: 'offline' });
    await dispatchPromise;

    expect(onAccessIndeterminate).toHaveBeenCalledTimes(1);
    expect(onAccessDenied).not.toHaveBeenCalled();
    expect(deps.clearSessionActivePresence).toHaveBeenCalledWith('session-prepared-presence');
    expect(service.getExecutionSnapshot('session-prepared-presence' as SessionId)).toMatchObject({
      hasActiveTurn: false,
    });
  });

  it('cancels a prepared dispatch without waiting for unresolved machine access', async () => {
    const sessionId = 'session-prepared-cancel' as SessionId;
    const userTurnId = 'turn-prepared-cancel';
    const turnId = `assistant:${userTurnId}`;
    let history: Array<Record<string, unknown>> = [
      {
        id: userTurnId,
        role: 'user',
        items: [{ type: 'text', text: 'hello' }],
        status: 'pending',
        read: false,
      },
    ];
    const sessionDoc = withHistoryPort({
      getHistory: vi.fn(() => history),
      updateHistory: vi.fn(async (updater: (prev: typeof history) => typeof history) => {
        history = updater(history);
      }),
      setStatus: vi.fn(async () => {}),
    });
    const onAccessAllowed = vi.fn(async () => {});
    const onAccessDenied = vi.fn(async () => {});
    const onAccessIndeterminate = vi.fn(async () => {});
    const deps = createBaseDeps({
      workspaceDocument: {
        repo: {
          upsertDocMeta: vi.fn(async () => {}),
          getDocMeta: vi.fn(async () => undefined),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
      beginConversationTurn: vi.fn((_sessionId: SessionId, turn?: string) =>
        turn ? `assistant:${turn}` : 'turn-1'
      ),
    });
    const service = new SessionExecutionService(deps);

    const dispatchPromise = service.dispatchPreparedSessionTurn({
      sessionId,
      sessionDoc: sessionDoc as never,
      userTurnId,
      invocation: { sourceTurnId: userTurnId, inputConfig: {} },
      dispatchSource: 'crdt',
      accessPromise: new Promise<never>(() => {}),
      requestPromise: new Promise<never>(() => {}),
      onAccessAllowed,
      onAccessDenied,
      onAccessIndeterminate,
    });

    expect(service.getExecutionSnapshot(sessionId)).toMatchObject({
      activeTurnId: turnId,
      hasActiveTurn: true,
    });
    expect(() => service.getActiveInvocationContext(sessionId)).toThrow(
      'Active invocation identity is unavailable'
    );

    await expect(
      service.cancelSession({
        type: 'session/cancel',
        sessionId,
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        turnId,
      })
    ).resolves.toEqual({ success: true });
    await dispatchPromise;

    expect(onAccessAllowed).not.toHaveBeenCalled();
    expect(onAccessDenied).not.toHaveBeenCalled();
    expect(onAccessIndeterminate).not.toHaveBeenCalled();
    expect(deps.clearConversationTurn).toHaveBeenCalledWith(sessionId, turnId);
    expect(sessionDoc.setStatus).toHaveBeenCalledWith(SessionStatusFactory.idle());
    expect(history[0]).toMatchObject({ id: userTurnId, status: 'canceled' });
    expect(service.getExecutionSnapshot(sessionId)).toMatchObject({
      hasActiveTurn: false,
    });
  });

  it('cancels a prepared dispatch after access is allowed without creating a second turn', async () => {
    const sessionId = 'session-prepared-request-cancel' as SessionId;
    const userTurnId = 'turn-prepared-request-cancel';
    const turnId = `assistant:${userTurnId}`;
    let preparedHistory: Array<Record<string, unknown>> = [
      {
        id: userTurnId,
        role: 'user',
        items: [{ type: 'text', text: 'hello' }],
        status: 'pending',
        read: false,
      },
    ];
    const preparedSessionDoc = withHistoryPort({
      getHistory: vi.fn(() => preparedHistory),
      updateHistory: vi.fn(
        async (updater: (prev: typeof preparedHistory) => typeof preparedHistory) => {
          preparedHistory = updater(preparedHistory);
        }
      ),
      setStatus: vi.fn(async () => {}),
    });
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => {}),
      currentModel: undefined,
    };
    const activeSession = {
      sessionId,
      acpSessionId: 'acp-prepared-request-cancel' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-prepared-request-cancel'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
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
        getOrCreateSessionDoc: vi.fn(async () => preparedSessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
      beginConversationTurn: vi.fn((_sessionId: SessionId, turn?: string) =>
        turn ? `assistant:${turn}` : 'turn-1'
      ),
    });
    let accessAllowed!: () => void;
    const accessAllowedPromise = new Promise<void>((resolve) => {
      accessAllowed = resolve;
    });
    const onAccessAllowed = vi.fn(async () => {
      accessAllowed();
    });
    const service = new SessionExecutionService(deps);

    const dispatchPromise = service.dispatchPreparedSessionTurn({
      sessionId,
      sessionDoc: preparedSessionDoc as never,
      userTurnId,
      invocation: { sourceTurnId: userTurnId, inputConfig: {} },
      dispatchSource: 'rpc',
      accessPromise: Promise.resolve({ outcome: 'allowed' as const }),
      requestPromise: new Promise<never>(() => {}),
      onAccessAllowed,
      onAccessDenied: vi.fn(async () => {}),
      onAccessIndeterminate: vi.fn(async () => {}),
    });

    await accessAllowedPromise;
    expect(onAccessAllowed).toHaveBeenCalledTimes(1);
    expect(deps.beginConversationTurn).toHaveBeenCalledWith(sessionId, userTurnId, {
      dispatchSource: 'rpc',
      sessionDoc: preparedSessionDoc,
      deferACPUpdateTarget: true,
    });

    await expect(
      service.cancelSession({
        type: 'session/cancel',
        sessionId,
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        turnId,
      })
    ).resolves.toEqual({ success: true });
    await vi.waitFor(() => {
      expect(deps.clearSessionActivePresence).toHaveBeenCalledWith(sessionId);
    });

    await dispatchPromise;
    await Promise.resolve();

    expect(deps.beginConversationTurn).toHaveBeenCalledTimes(1);
    expect(agentClient.prompt).not.toHaveBeenCalled();
    expect(preparedHistory[0]).toMatchObject({ id: userTurnId, status: 'canceled' });
    expect(service.getExecutionSnapshot(sessionId)).toMatchObject({
      hasActiveTurn: false,
    });
  });

  it('marks the session idle immediately after the prompt resolves', async () => {
    const events: string[] = [];
    let history: Array<Record<string, unknown>> = [
      {
        id: 'turn-user-1',
        role: 'user',
        status: 'pending',
        read: false,
      },
    ];
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => {
        events.push('prompt-resolved');
      }),
      currentModel: undefined,
    };
    const activeSession = {
      sessionId: 'session-1' as SessionId,
      acpSessionId: 'acp-1' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-1'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => ({ isArchived: false })),
      setStatus: vi.fn(async (status: { type: string }) => {
        events.push(`status:${status.type}`);
      }),
      waitUntilSynced: vi.fn(async () => {}),
      getHistory: vi.fn(() => history),
      updateHistory: vi.fn(async (updater: (prev: typeof history) => typeof history) => {
        history = updater(history);
      }),
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
          upsertDocMeta: vi.fn(async () => {}),
          getDocMeta: vi.fn(async () => undefined),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
      startSessionActivePresence: vi.fn(() => {
        events.push('active-start');
      }),
      setSessionActivePresencePhase: vi.fn((_sessionId, phase) => {
        events.push(`phase:${phase}`);
      }),
      clearSessionActivePresence: vi.fn(() => {
        events.push('active-clear');
      }),
      activateConversationTurnForACPUpdates: vi.fn(() => {
        events.push('activate-acp-target');
      }),
      syncLiveActivitySummary: vi.fn(async () => {
        events.push('live-activity-sync');
      }),
      turnFinalization: {
        ...createBaseDeps({}).turnFinalization,
        finalizeACPState: vi.fn(async () => {
          events.push('finalize-acp');
        }),
      },
    });

    const service = new SessionExecutionService(deps);
    await service.continueSession({
      type: 'session/chat',
      sessionId: 'session-1' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: undefined,
      acpSessionConfig: { prompt: 'hi', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-user-1',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    const promptResolvedAt = events.indexOf('prompt-resolved');
    const acpTargetActivatedAt = events.indexOf('activate-acp-target');
    const activeClearedAt = events.indexOf('active-clear');
    const idleAfterPromptAt = events.indexOf('status:idle');
    const finalizeStartedAt = events.indexOf('finalize-acp');

    expect(acpTargetActivatedAt).toBeGreaterThanOrEqual(0);
    expect(promptResolvedAt).toBeGreaterThanOrEqual(0);
    expect(acpTargetActivatedAt).toBeLessThan(promptResolvedAt);
    expect(idleAfterPromptAt).toBeGreaterThan(promptResolvedAt);
    expect(finalizeStartedAt).toBeGreaterThan(idleAfterPromptAt);
    expect(activeClearedAt).toBeGreaterThan(finalizeStartedAt);
    const finalizingAt = events.indexOf('phase:finalizing');
    expect(finalizingAt).toBeGreaterThan(promptResolvedAt);
    expect(idleAfterPromptAt).toBeGreaterThan(finalizingAt);
    expect(events.filter((event) => event === 'phase:finalizing')).toEqual(['phase:finalizing']);
  });

  it.each([true, false] as const)(
    'retries a disconnected turn only with an observable empty event stream (observable=%s)',
    async (observable) => {
      const sessionId = 'session-stale-acp' as SessionId;
      const acpSessionId = 'acp-stale' as ACPSessionId;
      const restoredAcpSessionId = 'acp-restored' as ACPSessionId;
      let history: Array<Record<string, unknown>> = [
        {
          id: 'turn-user-1',
          role: 'user',
          status: 'pending',
          read: false,
        },
      ];
      const submittedSessions: string[] = [];
      const agentClient = {
        isCreated: vi.fn(() => true),
        cancel: vi.fn(async () => {}),
        prompt: vi.fn(async () => {
          // Submission can succeed before the transport reports failure.
          submittedSessions.push(acpSessionId);
          throw new Error('ACP connection closed');
        }),
        currentModel: undefined,
      };
      const restoredAgentClient = {
        isCreated: vi.fn(() => true),
        cancel: vi.fn(async () => {}),
        prompt: vi.fn(async () => {
          submittedSessions.push(restoredAcpSessionId);
          return {};
        }),
        currentModel: undefined,
      };
      const exec = vi.fn(async (command: string, args: string[]) => {
        const key = `${command} ${args.join(' ')}`;
        if (key === 'git rev-parse --is-inside-work-tree') return 'true\n';
        if (key === 'git rev-parse HEAD') return 'abc123\n';
        return '';
      });
      const activeSession = {
        sessionId,
        acpSessionId,
        agentClient,
        terminalManager: {} as unknown,
        getWorkdir: () => '/tmp',
        getHostWorkdir: () => '/tmp',
        getParentSessionId: () => undefined,
        exec,
        terminate: vi.fn(async () => {}),
        updateGitIdentity: vi.fn(),
        createAgent: vi.fn(async () => acpSessionId),
        applyExecutionPlaneLimits: vi.fn(async () => {}),
      };
      const restoredSession = {
        ...activeSession,
        acpSessionId: restoredAcpSessionId,
        agentClient: restoredAgentClient,
        createAgent: vi.fn(async () => restoredAcpSessionId),
      };
      const sessionDoc = withHistoryPort({
        getMetaState: vi.fn(async () => ({ isArchived: false })),
        setStatus: vi.fn(async () => {}),
        waitUntilSynced: vi.fn(async () => {}),
        getHistory: vi.fn(() => history),
        updateHistory: vi.fn(async (updater: (prev: typeof history) => typeof history) => {
          history = updater(history);
        }),
      });
      const deps = createBaseDeps({ hasPromptEventsForTurn: observable ? () => false : undefined });
      const sessionManager = deps.sessionManager as unknown as {
        getSession: ReturnType<typeof vi.fn>;
        terminateSession: ReturnType<typeof vi.fn>;
        createSession: ReturnType<typeof vi.fn>;
      };
      const workspaceDocument = deps.workspaceDocument as unknown as {
        getOrCreateSessionDoc: ReturnType<typeof vi.fn>;
      };
      sessionManager.getSession.mockReturnValue(activeSession);
      sessionManager.createSession.mockResolvedValue(restoredSession);
      workspaceDocument.getOrCreateSessionDoc.mockResolvedValue(sessionDoc);

      const service = new SessionExecutionService(deps);
      await service.continueSession({
        type: 'session/chat',
        sessionId,
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        project: undefined,
        acpSessionConfig: { prompt: 'hi', cliType: 'builtin', agentType: 'codex' },
        userTurnId: 'turn-user-1',
        userId: 'user-1',
        userName: 'User',
        userEmail: 'user@example.com',
      });

      expect(service.getExecutionSnapshot(sessionId).hasActiveTurn).toBe(false);
      expect(submittedSessions).toEqual(
        observable ? [acpSessionId, restoredAcpSessionId] : [acpSessionId]
      );
      expect(history[0]?.status).toBe(observable ? 'handled' : 'failed');
    }
  );

  it('closes the ACP session gracefully when a turn fails on expired credentials', async () => {
    const sessionId = 'session-auth-expired' as SessionId;
    const acpSessionId = 'acp-auth-expired' as ACPSessionId;
    let history: Array<Record<string, unknown>> = [
      { id: 'turn-user-1', role: 'user', status: 'pending', read: false },
    ];
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => {
        // Providers report an expired OAuth credential as a plain ACP internal
        // error; the remedy text is theirs and is not guaranteed to be present.
        throw {
          code: -32603,
          message: 'Internal error',
          data: { details: 'OAuth session expired' },
        };
      }),
      currentModel: undefined,
    };
    const exec = vi.fn(async (command: string, args: string[]) => {
      const key = `${command} ${args.join(' ')}`;
      if (key === 'git rev-parse --is-inside-work-tree') return 'true\n';
      if (key === 'git rev-parse HEAD') return 'abc123\n';
      return '';
    });
    const activeSession = {
      sessionId,
      acpSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec,
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => acpSessionId),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => ({ isArchived: false })),
      setStatus: vi.fn(async () => {}),
      waitUntilSynced: vi.fn(async () => {}),
      getHistory: vi.fn(() => history),
      updateHistory: vi.fn(async (updater: (prev: typeof history) => typeof history) => {
        history = updater(history);
      }),
    });
    const deps = createBaseDeps({});
    const sessionManager = deps.sessionManager as unknown as {
      getSession: ReturnType<typeof vi.fn>;
      terminateSession: ReturnType<typeof vi.fn>;
    };
    const workspaceDocument = deps.workspaceDocument as unknown as {
      getOrCreateSessionDoc: ReturnType<typeof vi.fn>;
    };
    sessionManager.getSession.mockReturnValue(activeSession);
    workspaceDocument.getOrCreateSessionDoc.mockResolvedValue(sessionDoc);

    const service = new SessionExecutionService(deps);
    await service.continueSession({
      type: 'session/chat',
      sessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: undefined,
      acpSessionConfig: { prompt: 'hi', cliType: 'builtin', agentType: 'claude' },
      userTurnId: 'turn-user-1',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(deps.recordChatFailure).toHaveBeenCalledWith(
      sessionDoc,
      'acp_auth_required',
      'OAuth session expired'
    );
    // Forcing the kill here skips `session/close`, and adapters that flush their
    // transcript on close would lose the artifact `loadSession` needs — so the
    // next turn after signing back in would have nothing left to resume into.
    expect(sessionManager.terminateSession).toHaveBeenCalledWith(sessionId, false);
  });

  it.each(['pending', 'rejecting'] as const)(
    'bounds a workspace-reading Code Collab refresh and recovers (%s)',
    async (refreshOutcome) => {
      vi.useFakeTimers();
      try {
        let history: Array<Record<string, unknown>> = [
          {
            id: 'turn-user-1',
            role: 'user',
            status: 'pending',
            read: false,
          },
        ];
        const agentClient = {
          isCreated: vi.fn(() => true),
          cancel: vi.fn(async () => {}),
          prompt: vi.fn(async () => ({})),
          currentModel: undefined,
        };
        const exec = vi.fn(async (_cmd: string, args: string[]) => {
          const key = args.join(' ');
          if (key === 'rev-parse --is-inside-work-tree') return 'true\n';
          if (key === 'rev-parse HEAD') return 'abc123\n';
          return '';
        });
        const activeSession = {
          sessionId: 'session-1' as SessionId,
          acpSessionId: 'acp-1' as ACPSessionId,
          agentClient,
          terminalManager: {} as unknown,
          getWorkdir: () => '/tmp',
          getHostWorkdir: () => '/tmp',
          getParentSessionId: () => undefined,
          exec,
          terminate: vi.fn(async () => {}),
          updateGitIdentity: vi.fn(),
          createAgent: vi.fn(async () => 'acp-1'),
          applyExecutionPlaneLimits: vi.fn(async () => {}),
        };
        const sessionDoc = withHistoryPort({
          getMetaState: vi.fn(async () => ({ isArchived: false })),
          setStatus: vi.fn(async () => {}),
          setBaseBranch: vi.fn(async () => {}),
          getHistory: vi.fn(() => history),
          updateHistory: vi.fn(async (updater: (prev: typeof history) => typeof history) => {
            history = updater(history);
          }),
        });
        let releaseRefresh = () => {};
        const refreshGate = new Promise<void>((resolve) => {
          releaseRefresh = resolve;
        });
        const refreshStarted = createDeferred<void>();
        const refreshCodeCollabSharedState = async () => {
          refreshStarted.resolve();
          if (refreshOutcome === 'rejecting') throw new Error('Synthetic refresh failure');
          await refreshGate;
        };
        const presence = new Set<SessionId>();
        const deps = createBaseDeps({
          startSessionActivePresence: (id) => {
            presence.add(id);
          },
          clearSessionActivePresence: (id) => {
            presence.delete(id);
          },
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
            updateAcpCapabilities: vi.fn(async () => {}),
          } as unknown as LoroDocumentManager,
          turnFinalization: {
            finalizeACPState: vi.fn(async () => {}),
            flushSessionUsage: vi.fn(async () => {}),

            refreshCodeCollabSharedState,
            detectAndAssociatePR: vi.fn(async () => ({ baseBranch: 'release/v2' })),
            syncWorkspaceGitState: vi.fn(async () => {}),
            onTurnOutcome: vi.fn(async () => {}),
          },
        });

        const service = new SessionExecutionService(deps);
        const first = service.continueSession({
          type: 'session/chat',
          sessionId: 'session-1' as SessionId,
          machineId: 'machine-1',
          workspaceId: 'workspace-1' as WorkspaceId,
          project: { kind: 'github', repoFullName: 'owner/repo', branch: 'main' },
          acpSessionConfig: { prompt: 'hi', cliType: 'builtin', agentType: 'codex' },
          userTurnId: 'turn-user-1',
          userId: 'user-1',
          userName: 'User',
          userEmail: 'user@example.com',
        });

        await refreshStarted.promise;
        await vi.advanceTimersByTimeAsync(20_000);
        await first;
        releaseRefresh();

        expect(service.getExecutionSnapshot('session-1' as SessionId).hasActiveTurn).toBe(false);
        expect(presence.size).toBe(0);
        history.push({ id: 'turn-user-2', role: 'user', status: 'pending', read: false });
        await service.continueSession({
          type: 'session/chat',
          sessionId: 'session-1' as SessionId,
          machineId: 'machine-1',
          workspaceId: 'workspace-1' as WorkspaceId,
          project: { kind: 'github', repoFullName: 'owner/repo', branch: 'main' },
          acpSessionConfig: { prompt: 'next', cliType: 'builtin', agentType: 'codex' },
          userTurnId: 'turn-user-2',
          userId: 'user-1',
          userName: 'User',
          userEmail: 'user@example.com',
        });
        expect(history.find((entry) => entry.id === 'turn-user-2')?.status).toBe('handled');
        expect(service.getExecutionSnapshot('session-1' as SessionId).hasActiveTurn).toBe(false);
        releaseRefresh();
        await service.drainInboxExecutions();
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it.each(
    (
      [
        // name, project kind, worktree, child, prior ACP, resume, rename expected
        ['direct local', 'local', false, false, false, false, false],
        ['new local worktree', 'local', true, false, false, false, true],
        ['new GitHub worktree', 'github', true, false, false, false, true],
        ['local child Tab', 'local', true, true, false, false, false],
        ['GitHub child Tab', 'github', true, true, false, false, false],
        ['previous local worktree', 'local', true, false, true, false, false],
        ['previous GitHub worktree', 'github', true, false, true, false, false],
        ['explicit local resume', 'local', true, false, false, true, false],
        ['explicit GitHub resume', 'github', true, false, false, true, false],
      ] as const
    ).flatMap(([name, kind, worktree, child, prior, resume, rename]) =>
      (rename
        ? [
            'allocated',
            'collision',
            'namespace collision',
            'descriptive',
            'reserved-prefix descriptive',
            'other session',
            'detached',
            'probe failure',
          ]
        : ['allocated']
      ).flatMap((branchState) =>
        ['codex', 'kimi'].flatMap((titleAgentType) =>
          [true, false].map((sessionTitle) => ({
            name,
            kind,
            worktree,
            child,
            prior,
            resume,
            rename:
              rename && ['allocated', 'collision', 'namespace collision'].includes(branchState),
            branchState,
            sessionTitle,
            titleAgentType,
          }))
        )
      )
    )
  )(
    'starts $name on $branchState with $titleAgentType title capability $sessionTitle and the appropriate first-task prompt',
    async ({
      kind,
      worktree,
      child,
      prior,
      resume,
      rename,
      branchState,
      sessionTitle,
      titleAgentType,
    }) => {
      const generatedTitles: string[] = [];
      const allocatedBranch = kind === 'github' ? 'session/session-' : 'lody/session-loca';
      const initialBranch =
        branchState === 'collision'
          ? `${allocatedBranch}-2`
          : branchState === 'namespace collision'
            ? allocatedBranch.replace('/', '-2/')
            : branchState === 'descriptive'
              ? 'feature/local-start'
              : branchState === 'reserved-prefix descriptive'
                ? 'lody/fix-checkout'
                : branchState === 'other session'
                  ? 'session/87654321'
                  : branchState === 'detached'
                    ? ''
                    : allocatedBranch;
      let checkoutBranch = initialBranch;
      let publishedBranch: string | undefined;
      let branchAtPrompt: string | undefined;
      let deliveredPrompt: ContentBlock[] = [];
      const localProjectId = 'local-project-1' as LocalProjectId;
      const machineId = 'machine-1' as MachineId;
      const parentSessionId = child ? ('parent-session' as SessionId) : undefined;
      const project =
        kind === 'github'
          ? { kind: 'github' as const, repoFullName: 'owner/repo' }
          : { kind: 'local' as const, localProjectId, useWorktree: worktree };
      const existingAcpSessionId = prior ? ('acp-previous' as ACPSessionId) : undefined;
      const sessionDoc = withHistoryPort({
        getMetaState: vi.fn(async () => ({
          agentConfigId: capabilityConfigId,
          acpSessionId: existingAcpSessionId,
        })),
        getHistory: vi.fn(() => []),
        setStatus: vi.fn(async () => {}),
        setProject: vi.fn(async () => {}),
        setBaseBranch: vi.fn(async () => {}),
        updateHistory: vi.fn(async () => {}),
        roomId: 'session-session-local-code-collab',
      });
      const agentClient = {
        isCreated: vi.fn(() => true),
        cancel: vi.fn(async () => {}),
        prompt: vi.fn(async (_sessionId: string, blocks: ContentBlock[]) => {
          deliveredPrompt = blocks;
          branchAtPrompt = publishedBranch;
          checkoutBranch = 'feature/local-finished';
          return {};
        }),
        currentModel: undefined,
      };
      const createdSession = {
        sessionId: 'session-local-code-collab' as SessionId,
        acpSessionId: 'acp-local-code-collab' as ACPSessionId,
        agentClient,
        getAcpCapabilities: () => ({
          modes: [{ id: 'agent', name: 'Agent' }],
          models: [{ modelId: 'gpt-5', name: 'GPT-5' }],
          configOptions: [
            {
              id: 'reasoning',
              name: 'Reasoning',
              category: 'thought_level',
              type: 'select' as const,
              currentValue: 'high',
              options: [{ value: 'high', name: 'High' }],
            },
          ],
          availableCommands: [{ name: 'review', description: 'Review changes' }],
          sessionTitle,
          sessionFork: false,
          acknowledgedSteer: true,
        }),
        terminalManager: {} as unknown,
        getWorkdir: () => '/local/repo',
        getHostWorkdir: () => '/local/repo',
        getParentSessionId: () => parentSessionId,
        exec: vi.fn(async (_command: string, args: string[]) => {
          if (args.join(' ') === 'branch --show-current') {
            if (branchState === 'probe failure') throw new Error('synthetic Git probe failure');
            return checkoutBranch;
          }
          return '';
        }),
        terminate: vi.fn(async () => {}),
        updateGitIdentity: vi.fn(),
        createAgent: vi.fn(async () => 'acp-local-code-collab'),
        applyExecutionPlaneLimits: vi.fn(async () => {}),
      };
      let sessionStarted = false;
      const sessionManager = {
        getSession: vi.fn(() => (sessionStarted ? createdSession : null)),
        getPendingSession: vi.fn(() => null),
        createSession: vi.fn(async () => {
          sessionStarted = true;
          return createdSession as unknown;
        }),
        setSessionError: vi.fn(),
        terminateSession: vi.fn(),
        validateSessionCredentials: vi.fn(async () => {}),
      } as unknown as SessionManager;
      const getDocMeta = vi.fn(async (roomId: string) => {
        if (roomId !== getMachineRoomId(machineId)) return undefined;
        return {
          meta: {
            localProjects: {
              [localProjectId]: {
                id: localProjectId,
                name: 'Local Project',
                rootPath: '/local/repo',
                createdAtMs: 1,
              },
            },
          },
        };
      });
      const updateAcpCapabilities = vi.fn(async () => {});
      const deps = createBaseDeps({
        machineId,
        syncSessionBranchName: async () => {
          publishedBranch = checkoutBranch;
          return publishedBranch;
        },
        maybeGenerateAndStoreSessionTitle: async () => {
          generatedTitles.push('Local title');
        },
        sessionManager,
        workspaceDocument: {
          repo: {
            upsertDocMeta: vi.fn(async () => {}),
            getDocMeta,
          },
          getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
          getAcpCapabilities: vi.fn(async () => undefined),
          updateAcpCapabilities,
        } as unknown as LoroDocumentManager,
        buildAcpPromptBlocks: async ({ inputBlocks }) =>
          inputBlocks.flatMap((block): ContentBlock[] =>
            block.type === 'text' ? [{ type: 'text', text: block.text }] : []
          ),
      });

      const service = new SessionExecutionService(deps);
      await service.startSession({
        type: 'session/create',
        sessionId: 'session-local-code-collab' as SessionId,
        machineId,
        workspaceId: 'workspace-1' as WorkspaceId,
        project,
        parentSessionId,
        acpSessionConfig: {
          prompt: 'hello',
          cliType: 'builtin',
          agentType: titleAgentType,
          ...(resume ? { resume: 'acp-requested' } : {}),
        },
        userTurnId: 'turn-local-code-collab',
        userId: 'user-2',
        userName: 'User 2',
        userEmail: 'user2@example.com',
      });

      const text = deliveredPrompt
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('');
      expect(text.startsWith('hello')).toBe(true);
      expect(text.includes('Before starting this task, rename the branch')).toBe(rename);
      expect(text.includes('gh pr create')).toBe(kind === 'github');
      expect(text).toContain('Use the available Lody MCP tools when relevant');
      expect(branchAtPrompt).toBe(initialBranch);
      if (rename) expect(text).toContain(`git branch -m ${initialBranch} <name>`);
      expect(publishedBranch).toBe('feature/local-finished');
      expect(generatedTitles).toEqual(
        sessionTitle && titleAgentType !== 'codex' ? [] : ['Local title']
      );
      expect(sessionManager.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          ...(kind === 'local' ? { workdir: '/local/repo' } : {}),
          project,
        })
      );
      await vi.waitFor(() =>
        expect(updateAcpCapabilities).toHaveBeenCalledWith(
          machineId,
          capabilityConfigId,
          'builtin',
          titleAgentType,
          [{ id: 'agent', name: 'Agent' }],
          [{ modelId: 'gpt-5', name: 'GPT-5' }],
          [
            {
              id: 'reasoning',
              name: 'Reasoning',
              category: 'thought_level',
              type: 'select',
              currentValue: 'high',
              options: [{ value: 'high', name: 'High' }],
            },
          ],
          undefined,
          false,
          expect.any(String),
          // Per-model reasoning efforts: absent for this agent, which publishes no
          // legacy `model[effort]` combination list.
          undefined,
          true,
          // Goal actions: the fixture client advertises no goal extension.
          undefined,
          { sessionTitle }
        )
      );
      if (rename) {
        await service.continueSession({
          type: 'session/chat',
          sessionId: 'session-local-code-collab' as SessionId,
          machineId,
          workspaceId: 'workspace-1' as WorkspaceId,
          project,
          acpSessionConfig: {
            prompt: 'Continue the task',
            cliType: 'builtin',
            agentType: titleAgentType,
          },
          userTurnId: 'turn-local-followup',
          userId: 'user-2',
          userName: 'User 2',
          userEmail: 'user2@example.com',
        });
        expect(deliveredPrompt).toEqual([{ type: 'text', text: 'Continue the task' }]);
      }
    }
  );

  it('rejects session creation before spawning an agent when memory pressure persists', async () => {
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
      getHistory: vi.fn(() => history),
      updateHistory: vi.fn(async (updater: (prev: typeof history) => typeof history) => {
        history = updater(history);
      }),
      roomId: 'session-session-1',
    });
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({})),
      currentModel: undefined,
    };
    const createdSession = {
      sessionId: 'session-1' as SessionId,
      acpSessionId: 'acp-1' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-1'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const createSession = vi.fn(async () => createdSession as unknown);
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
      evictForMemoryPressure: vi.fn(async () => ({
        availableMemoryBytes: 128 * 1024 * 1024,
        thresholdBytes: 1024 * 1024 * 1024,
        hadMemoryPressure: true,
        stillUnderPressure: true,
        evictedSessionIds: [],
        pressureReason: 'physical',
      })),
    });

    const service = new SessionExecutionService(deps);
    await service.startSession({
      type: 'session/create',
      sessionId: 'session-1' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: undefined,
      acpSessionConfig: { prompt: 'hi', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-user-1',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(deps.recordChatFailure).toHaveBeenCalledWith(
      sessionDoc,
      'memory_pressure',
      expect.stringContaining('The turn was not started')
    );
    expect(createSession).not.toHaveBeenCalled();
    expect(agentClient.prompt).not.toHaveBeenCalled();
    expect(history[0]?.status).toBe('failed');
    expect(sessionDoc.setStatus.mock.calls.map(([status]) => status)).toEqual([
      SessionStatusFactory.idle(),
      SessionStatusFactory.idle(),
    ]);
  });

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
  ])('restores ACP with frozen configuration after $scenario', async ({ live, memory }) => {
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
      prompt: vi.fn(async () => ({})),
      currentModel: undefined,
    };
    const restoredSession = {
      sessionId: 'session-1' as SessionId,
      acpSessionId: 'acp-1' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
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
      getMemoryBinding: () => ({ providerId: 'nowledge-mem', memoryId: 'previous' }),
      agentClient: {
        ...agentClient,
        prompt: async () => {
          throw new Error('Old memory process must not receive the new prompt');
        },
      },
    };
    const sessionManager = {
      getSession: vi.fn(() => (retired ? null : oldSession)),
      retireSessionForReconfiguration: async (session: unknown) => {
        expect(session).toBe(oldSession);
        retired = true;
      },
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(async (config, agentStart) => {
        expect(retired).toBe(true);
        expect(config.memory).toEqual(memory);
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
      acpSessionConfig: { prompt: 'hi', cliType: 'builtin', agentType: 'codex', memory },
      userTurnId: 'turn-user-1',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

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
  });

  it.each(['create', 'continue'] as const)(
    'replays failed first-turn input through %s dispatch without a resumable ACP id',
    async (mode) => {
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
          async (_id: string, _blocks: { type: string; text: string }[], _options: unknown) => ({})
        ),
        currentModel: undefined,
      };
      const restoredSession = {
        sessionId: 'session-fresh-restore' as SessionId,
        acpSessionId: 'acp-fresh-restore' as ACPSessionId,
        agentClient,
        terminalManager: {} as unknown,
        getWorkdir: () => '/tmp',
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
      const deps = createBaseDeps({
        sessionManager: {
          getSession: vi.fn(() => null),
          getPendingSession: vi.fn(() => null),
          createSession: vi.fn(async () => restoredSession as unknown),
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
