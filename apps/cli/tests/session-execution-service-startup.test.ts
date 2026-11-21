import { nativeSessionCredentials } from '@/session/session-credentials';
import { type ContentBlock } from '@agentclientprotocol/sdk';
import {
  getMachineRoomId,
  SessionStatusFactory,
  type ACPSessionId,
  type LocalProjectId,
  type MachineId,
  type ProjectRef,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';
import { type TurnOutcomeFact } from '@lody/shared/notifications';
import { Effect } from 'effect';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { lazyExecutionJournal, makeEncryptedAgentExecution } from '../src/lib/e2ee/agent-execution';
import { RealtimeJournal } from '../src/lib/e2ee/realtime-journal';
import { type LoroDocumentManager } from '../src/lib/loro/doc';
import { SessionExecutionService } from '../src/session/session-execution-service';
import type { SessionManager } from '../src/session/session-manager';
import type { SessionConfig } from '../src/session/types';
import { withHistoryPort } from './history-port-fixture';
import {
  capabilityConfigId,
  createBaseDeps,
  createDeferred,
  encryptedExecutionFixture,
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

  it('withholds success until agent work that outlived the turn settles', async () => {
    const turn = await runSilentPromptTurn({
      sessionId: 'background-settles',
      hasPromptEventsForTurn: true,
      nativeWork: { current: 'background' },
    });
    expect(turn.notificationFacts).toEqual([]);
    expect(turn.sessionDoc.setLastMessageAt).not.toHaveBeenCalled();

    turn.changeNativeWork('running');
    await turn.service.drainInboxExecutions();
    expect(turn.notificationFacts).toEqual([]);

    turn.changeNativeWork(null);
    await vi.waitFor(() => expect(turn.notificationFacts).toHaveLength(1));
    await turn.service.drainInboxExecutions();
    expect(turn.notificationFacts[0]?.outcome).toEqual({ kind: 'succeeded' });
    expect(turn.sessionDoc.setLastMessageAt).toHaveBeenCalledOnce();
    expect(turn.interruptedNotices).toEqual([]);
  });

  it('reports background work ended by the agent process as unknown, not success', async () => {
    const turn = await runSilentPromptTurn({
      sessionId: 'background-interrupted',
      hasPromptEventsForTurn: true,
      nativeWork: { current: 'background' },
    });
    turn.endAgentProcess();
    await vi.waitFor(() => expect(turn.notificationFacts).toHaveLength(1));
    await turn.service.drainInboxExecutions();
    expect(turn.notificationFacts[0]?.outcome).toEqual({
      kind: 'unknown',
      code: 'native_work_interrupted',
    });
    expect(turn.interruptedNotices).toEqual(['assistant:turn-user-1']);
    // The reader still sees the conversation as changed.
    expect(turn.sessionDoc.setLastMessageAt).toHaveBeenCalledOnce();
  });

  it('treats an ACP child crash without Session.terminate as interrupted rather than hanging', async () => {
    const turn = await runSilentPromptTurn({
      sessionId: 'background-crashed',
      hasPromptEventsForTurn: true,
      nativeWork: { current: 'background' },
    });
    turn.crashAgentProcess();
    await vi.waitFor(() => expect(turn.notificationFacts).toHaveLength(1));
    await turn.service.drainInboxExecutions();
    expect(turn.notificationFacts[0]?.outcome).toEqual({
      kind: 'unknown',
      code: 'native_work_interrupted',
    });
    expect(turn.interruptedNotices).toEqual(['assistant:turn-user-1']);
    expect(turn.sessionDoc.setLastMessageAt).toHaveBeenCalledOnce();
  });

  it('writes nativeWorkInterrupted before flushing and re-acquires a live doc when GC destroys the old one', async () => {
    const events: string[] = [];
    const turn = await runSilentPromptTurn({
      sessionId: 'background-gc-destroyed-doc',
      hasPromptEventsForTurn: true,
      nativeWork: { current: 'background' },
      onLifecycleEvent: (event) => events.push(event),
    });
    turn.endAgentProcess({ destroyDoc: true });
    await vi.waitFor(() => expect(turn.notificationFacts).toHaveLength(1));
    await turn.service.drainInboxExecutions();
    expect(turn.notificationFacts[0]?.outcome).toEqual({
      kind: 'unknown',
      code: 'native_work_interrupted',
    });
    expect(turn.interruptedNotices).toEqual(['assistant:turn-user-1']);
    expect(turn.sessionDoc.setLastMessageAt).not.toHaveBeenCalled();
    expect(turn.replacementSessionDoc.setLastMessageAt).toHaveBeenCalledOnce();
    expect(events.slice(0, 3)).toEqual(['notice', 'flush', 'unread']);
  });

  it('withdraws background completion wait on Stop and release so teardown emits no stale interruption', async () => {
    const stopped = await runSilentPromptTurn({
      sessionId: 'background-stopped',
      hasPromptEventsForTurn: true,
      nativeWork: { current: 'background' },
    });
    await stopped.service.cancelSession({
      sessionId: 'background-stopped' as SessionId,
      turnId: 'turn-user-1',
    });
    stopped.endAgentProcess();
    await Promise.resolve();
    await stopped.service.drainInboxExecutions();
    expect(stopped.interruptedNotices).toEqual([]);
    expect(stopped.sessionDoc.setLastMessageAt).not.toHaveBeenCalled();
    expect(stopped.notificationFacts).toEqual([]);

    const archived = await runSilentPromptTurn({
      sessionId: 'background-archived',
      hasPromptEventsForTurn: true,
      nativeWork: { current: 'background' },
    });
    archived.service.withdrawNativeWorkCompletion('background-archived' as SessionId);
    archived.endAgentProcess();
    await Promise.resolve();
    await archived.service.drainInboxExecutions();
    expect(archived.interruptedNotices).toEqual([]);
    expect(archived.sessionDoc.setLastMessageAt).not.toHaveBeenCalled();
    expect(archived.notificationFacts).toEqual([]);
  });

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
      getGitHubCredentials: () => nativeSessionCredentials,
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
      getGitHubCredentials: () => nativeSessionCredentials,
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
      getGitHubCredentials: () => nativeSessionCredentials,
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
        getGitHubCredentials: () => nativeSessionCredentials,
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
      getGitHubCredentials: () => nativeSessionCredentials,
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
          getGitHubCredentials: () => nativeSessionCredentials,
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
        getGitHubCredentials: () => nativeSessionCredentials,
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
      getGitHubCredentials: () => nativeSessionCredentials,
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
});
