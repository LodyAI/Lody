import { MessageHandler } from '../src/lib/message-handler';
import * as quotaRunner from '../src/agent/acp-runner';
import { ProviderQuotaRefreshCache } from '../src/session/provider-quota-refresh-cache';
import { createSessionBackend } from '@/session/session-backend';
import type { MachineAccessVerification } from '@/session/session-access-retry';
import {
  projectTurnAttention,
  type TurnOutcomeFact,
  type TurnResultAudience,
} from '@lody/shared/notifications';
import { RequestError, type ContentBlock } from '@agentclientprotocol/sdk';
import { getSessionRoomId, type SessionId, type SessionMeta, type WorkspaceId } from '@lody/shared';
import { pendingEventFromAgentEditEvidence } from '../src/lib/code-collab/code-collab-v2-diff-evidence';
import { TurnPostProcessingService } from '../src/session/turn-post-processing-service';
import { CodeCollabV2DiffStore } from '../src/lib/code-collab/code-collab-v2-diff-store';
import { CodeCollabV2Service } from '../src/lib/code-collab/code-collab-v2-service';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { InboxExecutionRejected } from '../src/orchestration/inbox/admission-failure';
import { LodyOperationStore } from '../src/orchestration/operation-store';
import { findNextDispatchableUserTurn } from '../src/session/session-dispatch-logic';
import { SessionExecutionService } from '../src/session/session-execution-service';
import {
  jitterSessionStartRetryDelay,
  takeSessionStartRetry,
} from '../src/session/session-start-stage';
import { composeTestSessionDoc } from './session-doc-fixture';
import {
  capabilityConfigId,
  createDeferred,
  createGitLocalProject,
  finishFirstThenRunNext,
  inboxExecutionFixture,
  quotaHarness,
  runGit,
  snapshot,
} from './session-execution-service-helpers';

vi.hoisted(() => {
  Object.assign(globalThis, { __LODY_E2E_DAEMON_LOSS__: true });
  process.env.LODY_E2E = '1';
});
describe('Operation Inbox execution boundary', () => {
  it('lets the Agent continuing after its turn act for that turn until Stop', async () => {
    const f = inboxExecutionFixture(async () => ({ stopReason: 'end_turn' }));
    const sessionId = f.message.sessionId;
    try {
      await f.accept();
      await f.service.continueSession(f.message);
      expect(f.service.getExecutionSnapshot(sessionId).hasActiveTurn).toBe(false);

      // Woken by its own background task, the Agent's tool calls act for the finished
      // turn without reporting any activity of its own (Codex reports none).
      expect(f.service.getActiveInvocationContext(sessionId)).toMatchObject({
        requesterUserId: 'user-1',
        sourceTurnId: 'human-input',
      });

      await f.service.cancelSession({
        type: 'session/cancel',
        sessionId,
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        turnId: 'assistant:human-input',
      });
      expect(f.service.getActiveInvocationContext(sessionId)).toBeUndefined();
    } finally {
      await f.close();
    }
  });

  it('gives no authority to a replaced Agent or to work after a cancelled turn', async () => {
    const finished = inboxExecutionFixture(async () => ({ stopReason: 'end_turn' }));
    try {
      await finished.accept();
      await finished.service.continueSession(finished.message);
      finished.dropLiveSession();
      expect(
        finished.service.getActiveInvocationContext(finished.message.sessionId)
      ).toBeUndefined();
    } finally {
      await finished.close();
    }

    const started = createDeferred<void>();
    const answer = createDeferred<{ stopReason: string }>();
    const cancelled = inboxExecutionFixture(async () => {
      started.resolve();
      return await answer.promise;
    });
    const sessionId = cancelled.message.sessionId;
    try {
      await cancelled.accept();
      const run = cancelled.service.continueSession(cancelled.message);
      await started.promise;
      const turnId = cancelled.service.getExecutionSnapshot(sessionId).activeTurnId;
      expect(turnId).toBeDefined();
      const stop = cancelled.service.cancelSession({
        type: 'session/cancel',
        sessionId,
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        turnId: turnId ?? '',
      });
      answer.resolve({ stopReason: 'cancelled' });
      await Promise.all([stop, run]);
      expect(cancelled.service.getActiveInvocationContext(sessionId)).toBeUndefined();
    } finally {
      await cancelled.close();
    }
  });

  it('continues actual work when notification provenance cannot be read', async () => {
    const prompt = vi.fn(async () => ({ stopReason: 'end_turn' }));
    const f = inboxExecutionFixture(prompt);
    vi.spyOn(f.store, 'notificationOriginsForBatch').mockImplementation(() => {
      throw new Error('notification lookup unavailable');
    });
    const facts: TurnOutcomeFact[] = [];
    f.deps.turnFinalization.onTurnOutcome = async (fact) => {
      facts.push(fact);
    };
    try {
      f.add('result', 0, ['old-request']);
      await f.accept();
      await f.service.continueSession(f.message);
      expect(prompt).toHaveBeenCalledOnce();
      expect(facts.flatMap((fact) => projectTurnAttention(fact) ?? [])).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('keeps an access-unverified input pending so the access retry executes it once', async () => {
    const received: ContentBlock[][] = [];
    const f = inboxExecutionFixture(async (blocks) => {
      received.push(structuredClone(blocks));
      return { stopReason: 'end_turn' };
    });
    try {
      await f.accept();
      const dispatch = (access: MachineAccessVerification) => {
        const onAccessIndeterminate = vi.fn(async () => {});
        return {
          onAccessIndeterminate,
          run: f.service.dispatchPreparedSessionTurn({
            sessionId: f.message.sessionId,
            sessionDoc: f.doc,
            userTurnId: 'human-input',
            invocation: {
              sourceTurnId: 'human-input',
              requesterUserId: 'user-1',
              inputConfig: f.message.acpSessionConfig,
            },
            dispatchSource: 'crdt',
            accessPromise: Promise.resolve(access),
            requestPromise: Promise.resolve({ mode: 'continue' as const, request: f.message }),
            onAccessAllowed: async () => {},
            onAccessDenied: async () => {},
            onAccessIndeterminate,
          }),
        };
      };
      const backend = await createSessionBackend(f.doc);
      const status = async () =>
        (await backend.readHistory()).find((turn) => turn.id === 'human-input')?.status;

      // A network blip during verification leaves both the turn and its input pending.
      const offline = dispatch({
        outcome: 'indeterminate',
        cause: 'network',
        error: 'fetch failed',
      });
      await offline.run;
      expect(offline.onAccessIndeterminate).toHaveBeenCalledTimes(1);
      expect(received).toEqual([]);
      expect(
        findNextDispatchableUserTurn(await backend.readHistory(), {
          id: f.message.sessionId,
        } as SessionMeta)?.id
      ).toBe('human-input');
      expect(f.store.inbox.inputEnded('workspace-1', f.message.sessionId, 'human-input')).toBe(
        false
      );
      expect(f.service.getExecutionSnapshot(f.message.sessionId).hasActiveTurn).toBe(false);

      // The retry reuses the same execution id and is admitted, not rejected.
      await dispatch({ outcome: 'allowed' }).run;
      expect(received).toEqual([[{ type: 'text', text: 'CURRENT_REQUEST' }]]);
      expect(await status()).toBe('handled');
      expect(f.store.inbox.inputEnded('workspace-1', f.message.sessionId, 'human-input')).toBe(
        true
      );
    } finally {
      await f.close();
    }
  });

  it('retires a pending turn whose Inbox input already ended so later messages run', async () => {
    const received: ContentBlock[][] = [];
    const f = inboxExecutionFixture(async (blocks) => {
      received.push(structuredClone(blocks));
      return { stopReason: 'end_turn' };
    });
    try {
      await f.accept();
      const input = {
        workspaceId: 'workspace-1',
        sessionId: f.message.sessionId,
        userId: 'user-1',
        inputId: 'human-input',
        kind: 'human' as const,
        config: f.message.acpSessionConfig,
      };
      // State left by daemons before the withdraw fix: the input ended while its
      // user turn stayed pending in history.
      expect(f.store.inbox.begin(input, 'assistant:human-input')).toBe(true);
      f.store.inbox.release({ ...input, executionId: 'assistant:human-input', outcome: 'failed' });

      await expect(f.service.continueSession(f.message)).resolves.toBeUndefined();
      const backend = await createSessionBackend(f.doc);
      const old = (await backend.readHistory()).find((turn) => turn.id === 'human-input');
      expect(old).toMatchObject({ status: 'failed' });
      if (!old) throw new Error('Missing original human input');
      expect(f.service.getExecutionSnapshot(f.message.sessionId).hasActiveTurn).toBe(false);
      expect(received).toEqual([]);

      await f.doc.sessionData.commands.applyHistoryAction({
        kind: 'upsert-turn',
        turn: {
          ...old,
          id: 'next-human',
          status: 'pending',
          items: [{ type: 'text', text: 'NEXT_REQUEST' }],
        },
      });
      const history = await backend.readHistory();
      expect(
        findNextDispatchableUserTurn(history, { id: f.message.sessionId } as SessionMeta)?.id
      ).toBe('next-human');
      await f.service.acceptInboxHumanInput({
        sessionId: f.message.sessionId,
        inputId: 'next-human',
        userId: 'user-1',
        config: { ...f.message.acpSessionConfig, prompt: 'NEXT_REQUEST' },
      });
      await f.service.continueSession({
        ...f.message,
        userTurnId: 'next-human',
        acpSessionConfig: { ...f.message.acpSessionConfig, prompt: 'NEXT_REQUEST' },
      });
      expect(received).toEqual([[{ type: 'text', text: 'NEXT_REQUEST' }]]);
    } finally {
      await f.close();
    }
  });

  it.each(['cleanup-ok', 'cleanup-failed', 'admission-retry', 'persistent'] as const)(
    'retires a rolled-back release without replaying old input (%s)',
    async (mode) => {
      const received: ContentBlock[][] = [];
      const prompt = async (blocks: ContentBlock[]) => {
        received.push(structuredClone(blocks));
        return { stopReason: 'end_turn' };
      };
      const f = inboxExecutionFixture(prompt);
      const db = new Database(f.storePath);
      const backgroundCanRelease = mode.startsWith('cleanup');
      if (mode === 'cleanup-failed')
        f.session.terminate = async () => {
          throw new Error('terminate failed');
        };
      const replacement = {
        ...f.session,
        acpSessionId: 'replacement-acp',
        agentClient: {
          ...f.client,
          isCreated: () => true,
          prompt: async (_id: unknown, blocks: ContentBlock[]) => prompt(blocks),
        },
        createAgent: async () => 'replacement-acp',
        terminate: async () => {},
      };
      Object.assign(f.deps.sessionManager, { createSession: async () => replacement });
      const send = async (inputId: string) => {
        const config = { ...f.message.acpSessionConfig, prompt: 'FRESH_REQUEST' };
        await f.doc.sessionData.commands.applyHistoryAction({
          kind: 'upsert-turn',
          turn: {
            id: inputId,
            role: 'user',
            userId: 'user-1',
            status: 'pending',
            inputConfig: config,
            timestamp: '2026-10-29T00:00:00Z',
            items: [{ type: 'text', text: config.prompt }],
            fileDiff: [],
            finished: true,
          },
        });
        await f.service.acceptInboxHumanInput({
          sessionId: f.message.sessionId,
          inputId,
          userId: 'user-1',
          config,
        });
        return f.service.continueSession({
          ...f.message,
          userTurnId: inputId,
          acpSessionConfig: config,
        });
      };
      try {
        f.add('captured-before-outage');
        await f.accept();
        // ROLLBACK models SQLITE_FULL aborting the whole transaction, not just one statement.
        db.exec(`CREATE TRIGGER release_outage BEFORE UPDATE ON inbox_sessions
          WHEN OLD.active_execution='assistant:human-input' AND NEW.active_execution IS NULL
          ${backgroundCanRelease ? "AND EXISTS(SELECT 1 FROM inbox_releases WHERE execution_id=OLD.active_execution AND outcome='normal')" : ''}
          BEGIN SELECT RAISE(ROLLBACK,'SQLITE_FULL'); END;`);
        await f.service.continueSession(f.message);
        await f.service.drainInboxExecutions();
        expect(f.service.getExecutionSnapshot(f.message.sessionId).hasActiveTurn).toBe(false);
        const active = () =>
          db
            .prepare('SELECT active_execution FROM inbox_sessions WHERE session_id=?')
            .get(f.message.sessionId);
        expect(active()).toEqual({
          active_execution: backgroundCanRelease ? null : 'assistant:human-input',
        });
        if (mode === 'persistent') {
          await expect(send('rejected-input')).rejects.toBeInstanceOf(InboxExecutionRejected);
          const notices = (await (await createSessionBackend(f.doc)).readHistory())
            .flatMap((turn) => turn.items ?? [])
            .filter((item) => item.type === 'system_notice' && item.name === 'chat_failed');
          expect(notices).toMatchObject([
            { meta: { message: expect.stringContaining('the disk may be full') } },
          ]);
          expect(received).toHaveLength(1);
        }
        db.exec('DROP TRIGGER release_outage');
        await send('fresh-input');
        expect(received).toHaveLength(2);
        expect(received[1]).toEqual([{ type: 'text', text: 'FRESH_REQUEST' }]);
        expect(active()).toEqual({ active_execution: null });
        expect(
          f.store.inbox.inputEnded('workspace-1', f.message.sessionId, f.message.userTurnId)
        ).toBe(true);
        expect(
          (await (await createSessionBackend(f.doc)).readTurn('fresh-input')).turn
        ).toMatchObject({ status: 'handled' });
        expect(f.store.inbox.historyReceipts('workspace-1')).toMatchObject([
          { state: 'settled', memberCount: 1 },
        ]);
      } finally {
        db.exec('DROP TRIGGER IF EXISTS release_outage');
        db.close();
        await f.close();
      }
    }
  );

  it('retires a failed Inbox preparation even when its release transaction rolls back', async () => {
    const received: ContentBlock[][] = [];
    const f = inboxExecutionFixture(async (blocks) => {
      received.push(structuredClone(blocks));
      return { stopReason: 'end_turn' };
    });
    const db = new Database(f.storePath);
    try {
      f.add('result-before-prepare-failure');
      await f.accept();
      // Fail only after begin committed, then roll back the compensating release too.
      db.exec(`CREATE TRIGGER prepare_outage BEFORE INSERT ON inbox_batches
        WHEN NEW.input_id='human-input' AND EXISTS(
          SELECT 1 FROM inbox_sessions WHERE active_execution='assistant:human-input')
        BEGIN SELECT RAISE(ROLLBACK,'prepare failed'); END;
        CREATE TRIGGER release_outage BEFORE UPDATE ON inbox_sessions
        WHEN OLD.active_execution='assistant:human-input' AND NEW.active_execution IS NULL
        BEGIN SELECT RAISE(ROLLBACK,'SQLITE_FULL'); END;`);
      await expect(f.service.continueSession(f.message)).rejects.toThrow('prepare failed');
      expect(f.store.inbox.activeExecution('workspace-1', f.message.sessionId)).toMatchObject({
        executionId: 'assistant:human-input',
        inputId: 'human-input',
      });
      expect(received).toEqual([]);
      expect(f.service.getExecutionSnapshot(f.message.sessionId).hasActiveTurn).toBe(false);

      db.exec('DROP TRIGGER prepare_outage; DROP TRIGGER release_outage;');
      const config = { ...f.message.acpSessionConfig, prompt: 'FRESH_REQUEST' };
      await f.doc.sessionData.commands.applyHistoryAction({
        kind: 'upsert-turn',
        turn: {
          id: 'fresh-input',
          role: 'user',
          userId: 'user-1',
          status: 'pending',
          inputConfig: config,
          timestamp: '2026-10-30T00:00:00Z',
          items: [{ type: 'text', text: config.prompt }],
          fileDiff: [],
          finished: true,
        },
      });
      await f.service.acceptInboxHumanInput({
        sessionId: f.message.sessionId,
        inputId: 'fresh-input',
        userId: 'user-1',
        config,
      });
      await f.service.continueSession({
        ...f.message,
        userTurnId: 'fresh-input',
        acpSessionConfig: config,
      });
      expect(received).toHaveLength(1);
      expect(received[0]?.[0]).toEqual({ type: 'text', text: 'FRESH_REQUEST' });
      expect(f.store.inbox.inputEnded('workspace-1', f.message.sessionId, 'human-input')).toBe(
        true
      );
      const backend = await createSessionBackend(f.doc);
      expect((await backend.readTurn('fresh-input')).turn).toMatchObject({ status: 'handled' });
      expect(f.store.inbox.activeExecution('workspace-1', f.message.sessionId)).toBeUndefined();
      expect(f.service.getExecutionSnapshot(f.message.sessionId).hasActiveTurn).toBe(false);
      await f.service.continueSession(f.message);
      expect((await backend.readTurn('human-input')).turn).toMatchObject({ status: 'failed' });
      expect(received).toHaveLength(1);
    } finally {
      db.exec('DROP TRIGGER IF EXISTS prepare_outage; DROP TRIGGER IF EXISTS release_outage;');
      db.close();
      await f.close();
    }
  });

  it('detaches a failed Agent, continues with a new ACP and reports cleanup without blocking drain', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const started = createDeferred<void>();
    const raw = createDeferred<void>();
    const received: string[] = [];
    const f = inboxExecutionFixture(async () => {
      received.push('old');
      started.resolve();
      await raw.promise;
      return { stopReason: 'end_turn' };
    });
    const cleanupStarted = createDeferred<void>();
    f.session.terminate = async () => {
      cleanupStarted.resolve();
      throw new Error('Synthetic termination failure');
    };
    Object.defineProperty(f.client, 'pendingPromptCompletion', { get: () => raw.promise });
    const notices: string[] = [];
    f.deps.recordSessionStopFailure = async (_sid, _turnId, failure) => {
      notices.push(failure.message);
    };
    const replacement = {
      ...f.session,
      acpSessionId: 'new-acp',
      agentClient: {
        ...f.client,
        prompt: async () => {
          received.push('new');
          return { stopReason: 'end_turn' };
        },
      },
      createAgent: async () => 'new-acp',
      terminate: async () => {},
    };
    Object.assign(f.deps.sessionManager, { createSession: async () => replacement });
    try {
      await f.accept();
      const running = f.service.continueSession(f.message);
      await started.promise;
      await f.service.cancelSession({
        type: 'session/cancel',
        sessionId: f.message.sessionId,
        machineId: f.message.machineId,
        workspaceId: f.message.workspaceId,
        turnId: 'assistant:human-input',
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await cleanupStarted.promise;
      await running;
      expect(f.deps.sessionManager.getSession(f.message.sessionId)).toBeUndefined();
      expect(f.service.getExecutionSnapshot(f.message.sessionId).hasActiveTurn).toBe(false);
      expect(notices).toContainEqual(expect.stringContaining('termination failure'));
      await expect(f.service.drainInboxExecutions()).resolves.toBeUndefined();
      const next = { ...f.message, userTurnId: 'fresh-human' };
      await f.doc.sessionData.commands.applyHistoryAction({
        kind: 'upsert-turn',
        turn: {
          id: next.userTurnId,
          role: 'user',
          status: 'pending',
          userId: 'user-1',
          timestamp: '2026-10-12T00:00:01Z',
          inputConfig: f.message.acpSessionConfig,
          items: [{ type: 'text', text: 'FRESH' }],
          fileDiff: [],
          finished: true,
        },
      });
      await f.service.acceptInboxHumanInput({
        sessionId: next.sessionId,
        inputId: next.userTurnId,
        userId: 'user-1',
        config: next.acpSessionConfig,
      });
      await f.service.continueSession(next);
      expect(received).toEqual(['old', 'new']);
      expect(
        (await (await createSessionBackend(f.doc)).readTurn(next.userTurnId)).turn
      ).toMatchObject({ status: 'handled' });
    } finally {
      raw.resolve();
      await f.close();
      vi.useRealTimers();
    }
  });

  it('releases an Inbox turn whose failure handling also fails, so the next input runs', async () => {
    // Regression: a document that stops accepting status writes mid-turn made the
    // failure handler throw too. That skipped the Inbox release, leaked the turn
    // registration, and refused every later input as `active-session` forever.
    const received: ContentBlock[][] = [];
    const f = inboxExecutionFixture(async (blocks) => {
      received.push(structuredClone(blocks));
      return { stopReason: 'end_turn' };
    });
    const setStatus = f.doc.setStatus.bind(f.doc);
    let statusWritesFail = true;
    f.doc.setStatus = async (status) => {
      if (statusWritesFail) throw new Error('Mirror not initialized');
      await setStatus(status);
    };
    try {
      await f.accept();
      await f.service.continueSession(f.message).catch(() => undefined);
      expect(received).toHaveLength(0);
      expect(f.service.getExecutionSnapshot(f.message.sessionId)).toMatchObject({
        hasActiveTurn: false,
      });
      expect(f.service.getExecutionSnapshot(f.message.sessionId).releaseBlocked).toBeUndefined();

      // The agent process is kept for reuse; only the turn's ownership was released.
      expect(f.client.isCreated()).toBe(true);

      statusWritesFail = false;
      const next = { ...f.message, userTurnId: 'later-human' };
      await f.service.acceptInboxHumanInput({
        sessionId: next.sessionId,
        inputId: next.userTurnId,
        userId: 'user-1',
        config: next.acpSessionConfig,
      });
      await f.service.continueSession(next);
      expect(received).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  it.each(['absent', 'saved', 'failed'] as const)(
    'keeps turn cards tied to saved evidence while workspace diffs remain readable (%s)',
    async (evidence) => {
      const root = createGitLocalProject();
      const file = path.join(root, 'config.ts');
      fs.writeFileSync(file, 'value = 0\n');
      runGit(root, ['add', 'config.ts']);
      runGit(root, ['commit', '-m', 'tracked file before turn']);
      const f = inboxExecutionFixture(async () => {
        fs.writeFileSync(file, 'value = 1\n');
        return { stopReason: 'end_turn' };
      });
      f.session.getWorkdir = () => root;
      f.session.exec = async (_cmd, args) => runGit(root, args);
      const post = new TurnPostProcessingService({
        logger: f.deps.logger,
        workspaceDocument: f.deps.workspaceDocument,
        workspaceId: f.deps.workspaceId,
        prAssociation: null,
      });
      f.deps.turnFinalization.syncWorkspaceGitState = post.syncWorkspaceGitState.bind(post);
      const store = new CodeCollabV2DiffStore(f.deps.workspaceId, {
        dbPath: path.join(root, '.git', 'turn-evidence.sqlite'),
        now: () => 100,
      });
      const files = new CodeCollabV2Service({
        readOnly: true,
        diffStore: store,
        resolveWorkspace: async () => ({
          ok: true,
          ownerSessionId: f.message.sessionId,
          workspaceRoot: root,
          allChangesBaseBranch: 'main',
        }),
      });
      f.deps.turnFinalization.persistCodeCollabTurnDiffs = async (sessionId, turnId) => {
        if (evidence === 'absent') return false;
        if (evidence === 'failed') throw new Error('Synthetic evidence persistence failure');
        const fileDiff = await store.recordTurnDiffs({
          workspaceRoot: root,
          ownerSessionId: sessionId,
          turnId,
          capturedAtMs: 100,
          recordedAtMs: 100,
          events: [
            { path: 'config.ts', oldText: 'value = 0\n', newText: fs.readFileSync(file, 'utf8') },
          ],
        });
        const backend = await createSessionBackend(f.doc);
        return (
          (
            await backend.applyHistoryAction({
              kind: 'assistant-file-diff',
              turnId,
              change: { kind: 'set', value: fileDiff },
            })
          ).matched ?? false
        );
      };
      const message = {
        ...f.message,
        project: { kind: 'github' as const, repoFullName: 'owner/repo', branch: 'main' },
      };
      try {
        await f.deps.workspaceDocument.repo.upsertDocMeta(getSessionRoomId(message.sessionId), {
          project: message.project,
        });
        await f.accept();
        await f.service.continueSession(message);
        await f.service.drainInboxExecutions();
        const history = await (await createSessionBackend(f.doc)).readHistory();
        const turn = history.find((entry) => entry.id === 'assistant:human-input');
        expect(turn).toBeDefined();
        const historical = await files.openTurnDiff({
          sessionId: message.sessionId,
          turnId: 'assistant:human-input',
          path: 'config.ts',
        });
        if (evidence === 'saved') {
          expect(turn?.fileDiff).toEqual([{ filePath: 'config.ts', add: 1, del: 1 }]);
          expect(historical).toMatchObject({
            status: 'ok',
            oldSnapshot: { kind: 'text', text: { text: 'value = 0\n' } },
            newSnapshot: { kind: 'text', text: { text: 'value = 1\n' } },
          });
        } else {
          expect(turn?.fileDiff).toEqual([]);
          expect(historical).toMatchObject({ status: 'unavailable', reason: 'turn_unavailable' });
        }
        expect(
          await files.openCurrentDiff({ sessionId: message.sessionId, path: 'config.ts' })
        ).toMatchObject({ status: 'ok' });
        expect(await f.doc.getMetaState()).toMatchObject({ workspaceDirty: true });
        expect(f.service.getExecutionSnapshot(message.sessionId).hasActiveTurn).toBe(false);
      } finally {
        await f.close();
        await files.dispose();
        await store.close();
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it.each(['edit evidence', 'missing edit evidence'])(
    'keeps turn-one results before release (%s)',
    async (kind) => {
      const root = createGitLocalProject(),
        file = path.join(root, 'one.txt');
      const entered = createDeferred<void>(),
        finish = createDeferred<void>();
      let n = 0,
        captured: unknown;
      const f = inboxExecutionFixture(async () => {
        fs.writeFileSync(file, ++n === 1 ? 'TURN_ONE\n' : 'TURN_TWO\n');
        if (n === 2) fs.writeFileSync(path.join(root, 'two.txt'), 'second turn\n');
        return { stopReason: 'end_turn' };
      });
      f.session.getWorkdir = () => root;
      f.session.exec = async (_cmd, args) =>
        execFileSync('/usr/bin/git', args, { cwd: root, encoding: 'utf8' });
      const post = new TurnPostProcessingService({
        logger: f.deps.logger,
        workspaceDocument: f.deps.workspaceDocument,
        workspaceId: f.deps.workspaceId,
        prAssociation: null,
      });
      f.deps.turnFinalization.syncWorkspaceGitState = post.syncWorkspaceGitState.bind(post);
      f.deps.turnFinalization.persistCodeCollabTurnDiffs = async (_id, turn) => {
        if (turn === 'assistant:human-input') {
          entered.resolve();
          await finish.promise;
          if (kind === 'edit evidence')
            captured = await pendingEventFromAgentEditEvidence({
              workspaceRoot: root,
              edit: { path: file, changeType: 'update', contentOldText: 'BASE\n' },
              latestText: { status: 'untracked' },
            });
        }
        return kind === 'edit evidence';
      };
      const message = {
        ...f.message,
        project: { kind: 'github' as const, repoFullName: 'owner/repo', branch: 'main' },
      };
      try {
        await f.deps.workspaceDocument.repo.upsertDocMeta(getSessionRoomId(message.sessionId), {
          project: message.project,
        });
        await f.accept();
        const first = f.service.continueSession(message);
        await entered.promise;
        await finishFirstThenRunNext(f, first, finish, { ...message, userTurnId: 'next' });
        await f.service.drainInboxExecutions();
        expect(n).toBe(2);
        if (kind === 'edit evidence') {
          expect(captured).toMatchObject({ newText: 'TURN_ONE\n' });
          expect(JSON.stringify(captured)).not.toContain('TURN_TWO');
        } else {
          const history = await (await createSessionBackend(f.doc)).readHistory();
          expect(history.find((turn) => turn.id === 'assistant:human-input')?.fileDiff).toEqual([]);
        }
      } finally {
        finish.resolve();
        await f.close();
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it.each([false, true])(
    'keeps newer dirty/unpushed flags after an older probe (deadline=%s)',
    async (expires) => {
      if (expires) vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const started = createDeferred<void>(),
        finishOld = createDeferred<void>(),
        newerWritten = createDeferred<void>();
      let dirty = false,
        firstProbe = true,
        n = 0;
      const f = inboxExecutionFixture(async () => {
        if (++n === 2) dirty = true;
        return { stopReason: 'end_turn' };
      });
      const repo = f.deps.workspaceDocument.repo;
      const upsert = repo.upsertDocMeta.bind(repo);
      repo.upsertDocMeta = async (id, patch) => {
        await upsert(id, patch);
        if (patch.workspaceDirty === true) newerWritten.resolve();
      };
      const post = new TurnPostProcessingService({
        logger: f.deps.logger,
        workspaceDocument: f.deps.workspaceDocument,
        workspaceId: f.deps.workspaceId,
        prAssociation: null,
      });
      f.session.exec = async (_cmd, args) => {
        const key = args.join(' ');
        if (key === 'rev-parse --is-inside-work-tree') return 'true\n';
        if (key === 'rev-parse HEAD' || key.startsWith('rev-parse --verify'))
          return 'a'.repeat(40) + '\n';
        if (key === 'status --porcelain') {
          const observedDirty = dirty;
          if (firstProbe) {
            firstProbe = false;
            started.resolve();
            await finishOld.promise;
          }
          return observedDirty ? ' M a.txt\n' : '';
        }
        if (args[0] === 'rev-list') return dirty ? '1\n' : '0\n';
        return '';
      };
      f.deps.turnFinalization.syncWorkspaceGitState = post.syncWorkspaceGitState.bind(post);
      const message = {
        ...f.message,
        project: { kind: 'github' as const, repoFullName: 'owner/repo', branch: 'main' },
      };
      try {
        await upsert(getSessionRoomId(message.sessionId), {
          project: message.project,
          workspaceDirty: false,
          workspaceUnpushed: false,
        });
        await f.accept();
        const first = f.service.continueSession(message);
        await started.promise;
        if (expires) {
          await vi.advanceTimersByTimeAsync(19_999);
          expect(f.store.inbox.activeExecution('workspace-1', message.sessionId)).toBeDefined();
          await vi.advanceTimersByTimeAsync(1);
          expect(f.store.inbox.activeExecution('workspace-1', message.sessionId)).toBeUndefined();
        }
        const next = { ...message, userTurnId: 'newer' };
        await finishFirstThenRunNext(f, first, finishOld, next, newerWritten.promise);
        await newerWritten.promise;
        expect(n).toBe(2);
        expect(await f.doc.getMetaState()).toMatchObject({
          workspaceDirty: true,
          workspaceUnpushed: true,
        });
        finishOld.resolve();
        await f.service.drainInboxExecutions();
        expect(await f.doc.getMetaState()).toMatchObject({
          workspaceDirty: true,
          workspaceUnpushed: true,
        });
      } finally {
        finishOld.resolve();
        await f.close();
        if (expires) vi.useRealTimers();
      }
    }
  );

  it.each([
    { stage: 'diff', action: 'shutdown' },
    { stage: 'usage', action: 'shutdown' },
    { stage: 'diff', action: 'Stop' },
    { stage: 'usage', action: 'Stop' },
  ] as const)(
    'releases interrupted $stage persistence after $action within the original deadline',
    async ({ stage, action }) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const shutdown = action === 'shutdown';
      const entered = createDeferred<void>(),
        raw = createDeferred<void>();
      const signals: Array<AbortSignal | undefined> = [];
      const f = inboxExecutionFixture(async () => ({ stopReason: 'end_turn' }));
      if (stage === 'diff')
        f.deps.turnFinalization.persistCodeCollabTurnDiffs = async (_id, _turn, signal) => {
          signals.push(signal);
          entered.resolve();
          await raw.promise;
          return true;
        };
      else
        f.deps.turnFinalization.flushSessionUsage = async () => {
          entered.resolve();
          await raw.promise;
        };
      let run: Promise<unknown> | undefined;
      try {
        await f.accept();
        run = f.service.continueSession(f.message);
        await entered.promise;
        if (shutdown) f.service.quiesceInboxExecutions();
        else {
          await vi.advanceTimersByTimeAsync(19_000);
          await f.service.cancelSession({
            ...f.message,
            type: 'session/cancel',
            turnId: 'assistant:human-input',
          });
        }
        const released = f.service.waitForInboxReleases();
        await vi.advanceTimersByTimeAsync(shutdown ? 7_000 : 1_000);
        expect(f.store.inbox.activeExecution('workspace-1', f.message.sessionId)).toBeUndefined();
        expect(f.store.inbox.inputEnded('workspace-1', f.message.sessionId, 'human-input')).toBe(
          true
        );
        const db = new Database(f.storePath, { readonly: true });
        try {
          expect(
            db
              .prepare('SELECT outcome FROM inbox_releases WHERE session_id=?')
              .all(f.message.sessionId)
          ).toEqual([{ outcome: 'user_stop' }]);
        } finally {
          db.close();
        }
        if (stage === 'diff') expect(signals.every((signal) => signal?.aborted)).toBe(true);
        await released;
      } finally {
        raw.resolve();
        await run;
        await f.close();
        vi.useRealTimers();
      }
    }
  );

  it.each(['normal', 'shutdown', 'observation'])(
    'bounds pending generated-image uploads (%s)',
    async (mode) => {
      const shutdown = mode === 'shutdown';
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const entered = createDeferred<void>(),
        raw = createDeferred<void>(),
        nextStarted = createDeferred<void>();
      const uploads = new Map<string, Promise<void>>();
      let prompts = 0;
      const f = inboxExecutionFixture(async () => {
        if (++prompts === 1) uploads.set('image', raw.promise);
        else nextStarted.resolve();
        return { stopReason: 'end_turn' };
      });
      const handler = Object.create(MessageHandler.prototype) as any;
      handler.store = {
        has: () => true,
        get: () => ({
          permissionWaitMs: 0,
          acpUpdateBuffer: [],
          imageGenerationUploads: uploads,
          turn: {
            phase: 'active',
            turnId: 'assistant:human-input',
            turnEpoch: 1,
            hasVisibleOutput: false,
          },
        }),
        getTurnId: () => undefined,
        getCurrentACPUpdateTarget: () => undefined,
      };
      Object.assign(handler, {
        executionService: f.service,
        workspaceDocument: f.deps.workspaceDocument,
        logger: f.deps.logger,
        getSessionBackend: async (doc: typeof f.doc) => createSessionBackend(doc),
        flushSessionContextWindowUsage: async () => {},
        flushACPUpdatesNow: async () => {},
        flushThreadGoalHistoryPersists: async () => {},
      });
      const drain = handler.flushCodexGeneratedImageUploads.bind(handler);
      handler.flushCodexGeneratedImageUploads = async (...args: unknown[]) => {
        entered.resolve();
        await drain(...args);
      };
      f.deps.turnFinalization.finalizeACPState = (id, turn) => handler.finalizeACPState(id, turn);
      if (mode === 'observation')
        f.deps.observePromptContentForTurn = (id, turn) =>
          handler.observePromptContentForTurn(id, turn);
      let run: Promise<unknown> | undefined,
        next: Promise<unknown> | undefined,
        drainWork: Promise<void> | undefined;
      try {
        await f.accept();
        run = f.service.continueSession(f.message);
        await entered.promise;
        if (shutdown) {
          f.service.quiesceInboxExecutions();
          const released = f.service.waitForInboxReleases();
          await vi.advanceTimersByTimeAsync(7_000);
          await released;
        } else {
          await vi.advanceTimersByTimeAsync(19_999);
          expect(f.store.inbox.activeExecution('workspace-1', f.message.sessionId)).toBeDefined();
          await vi.advanceTimersByTimeAsync(1);
        }
        expect(f.store.inbox.activeExecution('workspace-1', f.message.sessionId)).toBeUndefined();
        expect(f.store.inbox.inputEnded('workspace-1', f.message.sessionId, 'human-input')).toBe(
          true
        );
        const db = new Database(f.storePath, { readonly: true });
        try {
          expect(db.prepare('SELECT outcome FROM inbox_releases').all()).toHaveLength(1);
        } finally {
          db.close();
        }
        let drained = false;
        drainWork = f.service.drainInboxExecutions().then(() => {
          drained = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(drained).toBe(false);
        if (!shutdown) {
          await run;
          await f.service.acceptInboxHumanInput({
            sessionId: f.message.sessionId,
            inputId: 'next',
            userId: 'user-1',
            config: f.message.acpSessionConfig,
          });
          next = f.service.continueSession({ ...f.message, userTurnId: 'next' });
          await nextStarted.promise;
        }
      } finally {
        uploads.clear();
        raw.resolve();
        await run;
        await next;
        await drainWork;
        await f.close();
        vi.useRealTimers();
      }
    }
  );

  it('forces a failed receipt only during shutdown when the finalization chain never settles', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const entered = createDeferred<void>(),
      raw = createDeferred<void>();
    const f = inboxExecutionFixture(async () => ({ stopReason: 'end_turn' }));
    f.deps.turnFinalization.finalizeACPState = async () => {
      entered.resolve();
      await raw.promise;
    };
    let run: Promise<unknown> | undefined;
    try {
      f.add('shutdown-result');
      await f.accept();
      run = f.service.continueSession(f.message);
      await entered.promise;
      const ordinary = f.service.waitForInboxReleases();
      await vi.advanceTimersByTimeAsync(7_000);
      await ordinary;
      expect(f.store.inbox.activeExecution('workspace-1', f.message.sessionId)).toBeDefined();
      f.service.quiesceInboxExecutions();
      const released = f.service.waitForInboxReleases();
      await vi.advanceTimersByTimeAsync(7_000);
      await released;
      // Its prompt already ended: shutdown interrupts only bookkeeping, so the claim
      // the next start would continue is cleared.
      const meta = (await f.deps.workspaceDocument.repo.getDocMeta('')) as {
        meta: SessionMeta;
      };
      expect(meta.meta.processingUserMsgId).toBeUndefined();
      expect(f.store.inbox.activeExecution('workspace-1', f.message.sessionId)).toBeUndefined();
      expect((f.service as any).liveInboxExecutionIds.size).toBe(0);
      const db = new Database(f.storePath, { readonly: true });
      try {
        expect(db.prepare('SELECT outcome FROM inbox_releases').all()).toEqual([
          { outcome: 'failed' },
        ]);
        expect(db.prepare('SELECT state FROM inbox_batches').all()).toEqual([{ state: 'unknown' }]);
      } finally {
        db.close();
      }
    } finally {
      raw.resolve();
      await run;
      await f.close();
      vi.useRealTimers();
    }
  });

  it('a shutdown during a running prompt retires the input but leaves the crash trace that continues it once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const started = createDeferred<void>(),
      work = createDeferred<void>();
    const f = inboxExecutionFixture(async () => {
      started.resolve();
      await work.promise;
      return { stopReason: 'end_turn' };
    });
    let run: Promise<unknown> | undefined;
    try {
      await f.accept();
      run = f.service.continueSession(f.message);
      await started.promise;
      f.service.quiesceInboxExecutions();
      work.resolve();
      const released = f.service.waitForInboxReleases();
      await vi.advanceTimersByTimeAsync(7_000);
      await released;
      await run;
      expect(f.store.inbox.inputEnded('workspace-1', f.message.sessionId, 'human-input')).toBe(
        true
      );
      const meta = (await f.deps.workspaceDocument.repo.getDocMeta('')) as {
        meta: SessionMeta;
      };
      expect(meta.meta).toMatchObject({ processingUserMsgId: 'human-input' });
      expect(meta.meta.lastHandledUserMsgId).toBeUndefined();
      const backend = await createSessionBackend(f.doc);
      expect((await backend.readTurn('human-input')).turn).toMatchObject({
        status: 'processing',
      });
    } finally {
      work.resolve();
      await run;
      await f.close();
      vi.useRealTimers();
    }
  });

  it('writes both active release receipts inside the shutdown budget despite one stuck finalization', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const started = [createDeferred<void>(), createDeferred<void>()];
    const raw = [createDeferred<void>(), createDeferred<void>()];
    const slow = createDeferred<void>();
    const fixtures = raw.map((work, i) =>
      inboxExecutionFixture(
        async () => {
          started[i]?.resolve();
          await work.promise;
          return { stopReason: 'end_turn' };
        },
        undefined,
        undefined,
        `shutdown-${i}` as SessionId
      )
    );
    const [f, other] = fixtures as [(typeof fixtures)[number], (typeof fixtures)[number]];
    f.deps.workspaceDocument.getOrCreateSessionDoc = async (id) =>
      id === f.message.sessionId ? f.doc : other.doc;
    f.deps.sessionManager.getSession = (id) =>
      (id === f.message.sessionId ? f.session : other.session) as never;
    let statisticsStarted = false;
    f.deps.turnFinalization.syncWorkspaceGitState = async () => {
      statisticsStarted = true;
      await slow.promise;
    };
    fixtures.forEach((fixture, i) => {
      fixture.session.terminate = async () => {
        raw[i]?.resolve();
      };
    });
    try {
      for (const fixture of fixtures)
        await f.service.acceptInboxHumanInput({
          sessionId: fixture.message.sessionId,
          inputId: 'human-input',
          userId: 'user-1',
          config: fixture.message.acpSessionConfig,
        });
      const turns = fixtures.map((fixture) => f.service.continueSession(fixture.message));
      await Promise.all(started.map((signal) => signal.promise));
      f.service.quiesceInboxExecutions();
      await vi.advanceTimersByTimeAsync(0);
      await f.service.waitForInboxReleases();
      await Promise.all(turns);
      expect(statisticsStarted).toBe(false);
      for (const fixture of fixtures) {
        expect(
          f.store.inbox.inputEnded('workspace-1', fixture.message.sessionId, 'human-input')
        ).toBe(true);
        expect(
          f.store.inbox.activeExecution('workspace-1', fixture.message.sessionId)
        ).toBeUndefined();
      }
    } finally {
      raw.forEach((work) => work.resolve());
      slow.resolve();
      await Promise.all(fixtures.map((fixture) => fixture.close()));
      vi.useRealTimers();
    }
  });

  it('bounds a slow yielded finalization, retains its raw work and releases the next input', async () => {
    const finalization = createDeferred<void>();
    const registered = createDeferred<void>();
    let service: SessionExecutionService | undefined;
    const f = inboxExecutionFixture(async () => {
      // A yielded turn's ancillary finalization outlives the old 5 s bound while
      // the prompt fails, so the turn body exits early and the release waits.
      const runtime = (
        service as unknown as {
          turnRuntimeBySession: Map<SessionId, { yieldedFinalization: Promise<void> }>;
        }
      ).turnRuntimeBySession.get('inbox-session' as SessionId);
      if (runtime) runtime.yieldedFinalization = finalization.promise;
      registered.resolve();
      throw new Error('agent crashed');
    });
    service = f.service;
    vi.useFakeTimers();
    try {
      await f.accept();
      const turn = f.service.continueSession(f.message);
      await registered.promise;
      await vi.advanceTimersByTimeAsync(30_000);
      await turn.catch(() => undefined);
      expect(f.service.getExecutionSnapshot(f.message.sessionId)).toMatchObject({
        hasActiveTurn: false,
      });
      expect(f.service.getExecutionSnapshot(f.message.sessionId).releaseBlocked).toBeUndefined();

      expect(f.store.inbox.inputEnded('workspace-1', f.message.sessionId, 'human-input')).toBe(
        true
      );
      let drained = false;
      const drain = f.service.drainInboxExecutions().then(() => {
        drained = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(drained).toBe(false);
      finalization.resolve();
      await drain;
      expect(drained).toBe(true);
      expect(f.service.getExecutionSnapshot(f.message.sessionId)).toMatchObject({
        hasActiveTurn: false,
      });
      expect(f.service.getExecutionSnapshot(f.message.sessionId).releaseBlocked).toBeUndefined();
    } finally {
      finalization.resolve();
      await f.close();
      vi.useRealTimers();
    }
  });

  it.each(['valid', 'absent', 'foreign', 'canceled'] as const)(
    'restores human identity only from a matching, uncanceled durable receipt (%s) after RPC loss',
    async (mode) => {
      const received: ContentBlock[][] = [];
      const f = inboxExecutionFixture(async (blocks) => {
        received.push(structuredClone(blocks));
        return { stopReason: 'end_turn' };
      });
      try {
        const prior = {
          workspaceId: 'workspace-1',
          sessionId: f.message.sessionId,
          userId: 'user-1',
          inputId: 'prior-human',
          kind: 'human' as const,
          config: f.message.acpSessionConfig,
        };
        f.store.inbox.accept(prior);
        f.store.inbox.begin(prior, 'prior-execution');
        f.store.inbox.pause(
          prior,
          'prior-execution',
          mode === 'canceled' ? ['human-input'] : [],
          'stop-1'
        );
        f.store.inbox.release({ ...prior, executionId: 'prior-execution', outcome: 'user_stop' });
        f.add('queued-result');
        const { LoroDoc, LoroMap } = await import('loro-crdt');
        const raw = f.doc.handle!.doc;
        if (mode !== 'absent') {
          const receipt = raw
            .getMap('humanInputReceipts')
            .setContainer('human-input', new LoroMap());
          receipt.set('userId', mode === 'foreign' ? 'other-user' : 'user-1');
          raw.commit();
        }
        const reopened = new LoroDoc();
        reopened.import(raw.export({ mode: 'snapshot' }));
        composeTestSessionDoc(f.doc, { doc: reopened });
        await f.service.continueSession(f.message, { dispatchSource: 'crdt' });
        if (mode === 'valid') {
          expect(received).toHaveLength(1);
          expect(JSON.stringify(received[0])).toContain('CURRENT_REQUEST');
          expect(JSON.stringify(received[0])).toContain('queued-result');
          expect(f.store.inbox.inputKind(prior, 'human-input')).toBe('human');
          // Re-delivered receipts retain their original accepted identity; after
          // another Stop they cannot grant fresh authorization or another prompt.
          const later = { ...prior, inputId: 'later-human' };
          f.store.inbox.accept(later);
          f.store.inbox.begin(later, 'later-execution');
          f.store.inbox.pause(later, 'later-execution', [], 'stop-2');
          f.store.inbox.release({ ...later, executionId: 'later-execution', outcome: 'user_stop' });
          await f.service.acceptInboxHumanInput({
            sessionId: f.message.sessionId,
            inputId: 'human-input',
            userId: 'user-1',
            config: f.message.acpSessionConfig,
          });
          expect(
            (f.store as unknown as { db: Database.Database }).db
              .prepare('SELECT MAX(paused) AS paused FROM inbox_sessions WHERE session_id=?')
              .get(f.message.sessionId)
          ).toEqual({ paused: 1 });
          expect(received).toHaveLength(1);
        } else if (mode === 'canceled') {
          expect(received).toEqual([]);
          expect(f.store.inbox.pending('workspace-1')).toEqual([]);
        } else {
          // Post-Stop input without a matching receipt still runs, as an Agent-rank task.
          expect(received).toHaveLength(1);
          expect(f.store.inbox.inputKind(prior, 'human-input')).toBe('task');
        }
      } finally {
        await f.close();
      }
    }
  );

  it.each<TurnResultAudience>([
    { kind: 'user' },
    { kind: 'agent', sessionId: 'sender-session' as SessionId, turnId: 'sender-turn' },
    { kind: 'unknown' },
  ])('preserves the $kind audience when an input carries eight Inbox results', async (audience) => {
    const received: ContentBlock[][] = [];
    const f = inboxExecutionFixture(async (blocks) => {
      expect(f.service.getActiveInvocationContext(f.message.sessionId)?.sender).toEqual(
        audience.kind === 'unknown'
          ? undefined
          : audience.kind === 'user'
            ? { kind: 'user' }
            : { kind: 'agent', sessionId: audience.sessionId }
      );
      received.push(structuredClone(blocks));
      return { stopReason: 'end_turn' };
    });
    const notificationFacts: TurnOutcomeFact[] = [];
    f.deps.turnFinalization.onTurnOutcome = async (fact) => {
      notificationFacts.push(fact);
    };
    try {
      for (let i = 0; i < 8; i++) f.add(`saved-${i}`, i === 0 ? 15 : 0);
      await f.accept();
      await f.service.continueSession(f.message, { notificationAudience: audience });
      await f.service.drainInboxExecutions();
      expect(notificationFacts).toEqual([
        {
          scope: { workspaceId: 'workspace-1', recipientId: 'user-1' },
          sessionId: f.message.sessionId,
          turnId: 'human-input',
          originTurnIds: audience.kind === 'user' ? ['human-input'] : [],
          assistantTurnId: 'assistant:human-input',
          audience,
          outcome: { kind: 'succeeded' },
        },
      ]);
      expect(received).toHaveLength(1);
      expect(received[0][0]).toEqual({ type: 'text', text: 'CURRENT_REQUEST' });
      const results = received[0]
        .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      for (let i = 0; i < 8; i++) expect(results).toContain(`saved-${i}`);
      expect(results).not.toContain('OBSOLETE_REQUEST');
      const history = await (await createSessionBackend(f.doc)).readHistory();
      const input = history.find((e) => e.id === 'human-input')!;
      expect(input.inputConfig?.chainDepth).toBe(0);
      expect(input.items).toEqual([{ type: 'text', text: 'CURRENT_REQUEST' }]);
      const item = history
        .flatMap((e) => e.items ?? [])
        .find((i) => i.type === 'operation_completion_batch')!;
      expect(item).toMatchObject({ memberCount: 8 });
      const batch = f.store.inbox.getBatch(
        (item as Extract<typeof item, { type: 'operation_completion_batch' }>).batchId,
        { workspaceId: 'workspace-1', sessionId: f.message.sessionId, userId: 'user-1' }
      )!;
      expect(batch.state).toBe('settled');
      expect(batch.chainDepth).toBe(0);
      expect(f.store.inbox.pending('workspace-1')).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('naturally releases into one actual automatic input containing busy receipts then wakes again for a late receipt', async () => {
    const started = createDeferred<void>();
    const complete = createDeferred<void>();
    const automatic = createDeferred<void>();
    const lateAutomatic = createDeferred<void>();
    let automaticCount = 0;
    const received: ContentBlock[][] = [];
    const f = inboxExecutionFixture(
      async (blocks) => {
        received.push(structuredClone(blocks));
        if (received.length === 1) {
          started.resolve();
          await complete.promise;
        }
        return { stopReason: 'end_turn' };
      },
      undefined,
      () => {
        automaticCount++;
        if (automaticCount === 1) automatic.resolve();
        else lateAutomatic.resolve();
      }
    );
    try {
      await f.accept();
      const running = f.service.continueSession(f.message);
      await started.promise;
      for (let n = 0; n < 8; n++) f.add(`busy-${n}`);
      expect(received).toHaveLength(1);
      complete.resolve();
      await running;
      await automatic.promise;
      expect(received).toHaveLength(2);
      const result = received[1]!
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      for (let n = 0; n < 8; n++) expect(result).toContain(`busy-${n}`);
      const history = await (await createSessionBackend(f.doc)).readHistory();
      const batches = history
        .flatMap((e) => e.items ?? [])
        .filter((i) => i.type === 'operation_completion_batch');
      expect(batches).toMatchObject([{ memberCount: 8, deliveryStatus: 'settled' }]);
      expect(f.store.inbox.pending('workspace-1')).toEqual([]);
      f.add('late-nine');
      expect(f.store.inbox.pending('workspace-1')).toHaveLength(1);
      await f.wake();
      await lateAutomatic.promise;
      expect(received).toHaveLength(3);
      const lateBlocks = received[2];
      if (!lateBlocks) throw new Error('Missing late receipt input');
      const late = lateBlocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      expect(late).toContain('late-nine');
      expect(late).not.toContain('busy-0');
      expect(f.store.inbox.pending('workspace-1')).toEqual([]);
    } finally {
      complete.resolve();
      await f.close();
    }
  });

  it('legacy Stop cancels the turn without locking out the next legacy user input', async () => {
    const building = createDeferred();
    const release = createDeferred();
    const received: ContentBlock[][] = [];
    let hold = true;
    const f = inboxExecutionFixture(
      async (blocks) => {
        received.push(blocks);
        return {};
      },
      async (blocks) => {
        if (hold) {
          building.resolve();
          await release.promise;
        }
        return blocks as ContentBlock[];
      }
    );
    try {
      const running = f.service.continueSession(f.message); // No human receipt, like a released client.
      await building.promise;
      const turnId = f.service.getExecutionSnapshot(f.message.sessionId).activeTurnId!;
      await f.service.cancelSession({
        type: 'session/cancel',
        sessionId: f.message.sessionId,
        turnId,
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
      });
      release.resolve();
      await running;
      expect(received).toEqual([]);
      hold = false;
      f.client.isCreated = () => true; // A fresh Agent is available after the cancelled acquisition.
      await f.doc.sessionData.commands.applyHistoryAction({
        kind: 'upsert-turn',
        turn: {
          id: 'legacy-next',
          role: 'user',
          timestamp: '2026-10-12T00:00:00Z',
          status: 'pending',
          read: false,
          items: [{ type: 'text', text: 'next' }],
          inputConfig: f.message.acpSessionConfig,
          finished: true,
          fileDiff: [],
        },
      });
      await f.service.continueSession({ ...f.message, userTurnId: 'legacy-next' });
      expect(received).toHaveLength(1);
      expect(
        (await (await createSessionBackend(f.doc)).readHistory()).find(
          (entry) => entry.id === 'legacy-next'
        )?.status
      ).toBe('handled');
      expect(
        (f.store as unknown as { db: Database.Database }).db
          .prepare('SELECT paused FROM inbox_sessions')
          .get()
      ).toEqual({ paused: 0 });
    } finally {
      release.resolve();
      await f.close();
    }
  });

  it('Stop preserves all queued drafts and an explicit resend runs only its selected task', async () => {
    const prompting = createDeferred();
    const release = createDeferred();
    const received: string[] = [];
    const f = inboxExecutionFixture(async (blocks) => {
      const text = blocks.map((block) => (block.type === 'text' ? block.text : '')).join('');
      received.push(text);
      if (text === 'CURRENT_REQUEST') {
        prompting.resolve();
        await release.promise;
      }
      return {};
    });
    try {
      await f.accept();
      const running = f.service.continueSession(f.message);
      await prompting.promise;
      const turnId = f.service.getExecutionSnapshot(f.message.sessionId).activeTurnId!;
      for (const id of ['B', 'C', 'D', 'E', 'F']) {
        await f.doc.pushMessageQueue({
          task: id,
          userTurnId: id,
          userId: 'user-1',
          timestamp: '2026-11-20T00:00:00Z',
          project: undefined,
          acpSessionConfig: { ...f.message.acpSessionConfig, prompt: id },
        });
      }
      const stop = {
        type: 'session/cancel' as const,
        sessionId: f.message.sessionId,
        turnId,
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        cancelId: 'stop-A',
      };
      await f.service.cancelSession(stop);
      release.resolve();
      await running;
      expect(received).toEqual(['CURRENT_REQUEST']);
      const retained = await f.doc.getMessageQueue();
      expect(retained.map((item) => [item.userTurnId, item.paused])).toEqual(
        ['B', 'C', 'D', 'E', 'F'].map((id) => [id, true])
      );
      expect(await f.doc.peekReadyMessageQueue()).toBeNull();
      const config = { ...f.message.acpSessionConfig, prompt: 'C' };
      const inputId = 'queue-resend:C';
      await f.doc.appendUserTurn({
        id: inputId,
        role: 'user',
        userId: 'user-1',
        timestamp: '2026-11-20T00:00:01Z',
        status: 'pending',
        items: [{ type: 'text', text: 'C' }],
        inputConfig: config,
      });
      await f.service.acceptInboxHumanInput({
        sessionId: f.message.sessionId,
        inputId,
        userId: 'user-1',
        config,
      });
      await f.doc.removeMessageQueueItem(retained[1]!.$cid);
      await f.service.continueSession({
        ...f.message,
        userTurnId: inputId,
        acpSessionConfig: config,
      });
      expect(received).toEqual(['CURRENT_REQUEST', 'C']);
      expect(f.service.isInboxInputCanceled(f.message.sessionId, 'C')).toBe(true);
      expect((await f.doc.getMessageQueue()).map((item) => item.userTurnId)).toEqual([
        'B',
        'D',
        'E',
        'F',
      ]);
      expect(await f.doc.peekReadyMessageQueue()).toBeNull();
      // A duplicate old Stop cannot pause a later queued input.
      await f.doc.pushMessageQueue({
        task: 'G',
        userTurnId: 'G',
        userId: 'user-1',
        timestamp: '2026-11-20T00:00:02Z',
        project: undefined,
        acpSessionConfig: { ...config, prompt: 'G' },
      });
      await f.service.cancelSession(stop);
      expect(await f.doc.peekReadyMessageQueue()).toMatchObject({ userTurnId: 'G' });
    } finally {
      release.resolve();
      await f.close();
    }
  });

  // #2050: interrupt-and-send ends the running turn so the queued guidance runs
  // next. It must not use the Stop identity, which pauses the Inbox and cancels
  // the eligibility of every input queued before it.
  it.each([
    ['interrupt', 'running', { pauseInbox: false }, ['CURRENT_REQUEST', 'GUIDANCE'], 'handled'],
    [
      'interrupt',
      'already finished',
      { pauseInbox: false },
      ['CURRENT_REQUEST', 'GUIDANCE'],
      'handled',
    ],
    // RPC lost: the daemon reads the durable turn-id marker, which carries no Stop identity.
    ['interrupt marker', 'running', {}, ['CURRENT_REQUEST', 'GUIDANCE'], 'handled'],
    ['Stop', 'running', { cancelId: 'user-stop' }, ['CURRENT_REQUEST'], 'seen'],
  ] as const)(
    '%s of a %s turn decides whether queued guidance runs',
    async (kind, turnState, request, expectedPrompts, guidanceStatus) => {
      const release = createDeferred();
      const prompting = createDeferred();
      const received: string[] = [];
      const f = inboxExecutionFixture(async (blocks) => {
        const text = blocks.map((block) => (block.type === 'text' ? block.text : '')).join('');
        received.push(text);
        if (text === 'CURRENT_REQUEST') {
          prompting.resolve();
          await release.promise;
        }
        return {};
      });
      try {
        await f.accept();
        const running = f.service.continueSession(f.message);
        await prompting.promise;
        const turnId = f.service.getExecutionSnapshot(f.message.sessionId).activeTurnId!;
        const guidanceConfig = {
          ...f.message.acpSessionConfig,
          prompt: 'GUIDANCE',
          inputBlocks: [{ type: 'text' as const, text: 'GUIDANCE' }],
        };
        // The composer queues the guidance, then cancels the running turn.
        await f.doc.pushMessageQueue({
          task: 'GUIDANCE',
          userId: 'user-1',
          userTurnId: 'guidance',
          timestamp: '2026-10-12T00:00:01Z',
          project: undefined,
          acpSessionConfig: guidanceConfig,
        });
        if (turnState === 'already finished') {
          release.resolve();
          await running;
        }
        await f.service.cancelSession({
          ...request,
          type: 'session/cancel',
          sessionId: f.message.sessionId,
          turnId,
          machineId: 'machine-1',
          workspaceId: 'workspace-1' as WorkspaceId,
        });
        release.resolve();
        await running;
        // The dispatch watcher's queue-promotion gate: a canceled head is retired, not run.
        expect(f.service.isInboxInputCanceled(f.message.sessionId, 'guidance')).toBe(
          kind === 'Stop'
        );

        // Queue promotion after release: history row, human receipt, dispatch.
        await f.doc.sessionData.commands.applyHistoryAction({
          kind: 'upsert-turn',
          turn: {
            id: 'guidance',
            role: 'user',
            userId: 'user-1',
            timestamp: '2026-10-12T00:00:01Z',
            status: 'pending',
            read: false,
            items: [{ type: 'text', text: 'GUIDANCE' }],
            inputConfig: guidanceConfig,
            finished: true,
            fileDiff: [],
          },
        });
        const [queued] = await f.doc.getMessageQueue();
        if (queued) await f.doc.removeMessageQueueItem(queued.$cid);
        await f.service.acceptInboxHumanInput({
          sessionId: f.message.sessionId,
          inputId: 'guidance',
          userId: 'user-1',
          config: guidanceConfig,
        });
        await f.service.continueSession({
          ...f.message,
          userTurnId: 'guidance',
          acpSessionConfig: guidanceConfig,
        });

        expect(received).toEqual(expectedPrompts);
        // Even a Stop keeps the typed guidance in history instead of deleting it.
        expect(
          (await (await createSessionBackend(f.doc)).readHistory()).find(
            (entry) => entry.id === 'guidance'
          )?.status
        ).toBe(guidanceStatus);
      } finally {
        release.resolve();
        await f.close();
      }
    }
  );

  it('runs an Agent chat sent after an Inbox-aware Stop and clears the pause', async () => {
    const building = createDeferred();
    const release = createDeferred();
    const received: ContentBlock[][] = [];
    let hold = true;
    const f = inboxExecutionFixture(
      async (blocks) => {
        received.push(blocks);
        return {};
      },
      async (blocks) => {
        if (hold) {
          building.resolve();
          await release.promise;
        }
        return blocks as ContentBlock[];
      }
    );
    try {
      await f.accept();
      const running = f.service.continueSession(f.message);
      await building.promise;
      const turnId = f.service.getExecutionSnapshot(f.message.sessionId).activeTurnId!;
      await f.service.cancelSession({
        cancelId: 'modern-stop',
        type: 'session/cancel',
        sessionId: f.message.sessionId,
        turnId,
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
      });
      release.resolve();
      await running;
      expect(received).toEqual([]);
      hold = false;
      f.client.isCreated = () => true;
      // An Agent chat carries no human receipt, so the Inbox records it as a task.
      await f.doc.sessionData.commands.applyHistoryAction({
        kind: 'upsert-turn',
        turn: {
          id: 'agent-chat',
          role: 'user',
          timestamp: '2026-10-18T02:02:17Z',
          status: 'pending',
          read: false,
          items: [{ type: 'text', text: 'delegated work' }],
          inputConfig: f.message.acpSessionConfig,
          finished: true,
          fileDiff: [],
        },
      });
      await f.service.continueSession({ ...f.message, userTurnId: 'agent-chat' });
      expect(received).toHaveLength(1);
      expect(
        (await (await createSessionBackend(f.doc)).readHistory()).find(
          (entry) => entry.id === 'agent-chat'
        )?.status
      ).toBe('handled');
      expect(
        (f.store as unknown as { db: Database.Database }).db
          .prepare('SELECT MAX(paused) AS paused FROM inbox_sessions WHERE session_id=?')
          .get(f.message.sessionId)
      ).toEqual({ paused: 0 });
    } finally {
      release.resolve();
      await f.close();
    }
  });

  it.each(['legacy', 'without Inbox'] as const)(
    'retains queued drafts on %s Stop',
    async (mode) => {
      const prompting = createDeferred();
      const release = createDeferred();
      const received: string[] = [];
      const f = inboxExecutionFixture(async (blocks) => {
        received.push(blocks.map((b) => (b.type === 'text' ? b.text : '')).join(''));
        prompting.resolve();
        await release.promise;
        return {};
      });
      if (mode === 'without Inbox') f.service.setOperationInbox(undefined);
      try {
        await f.accept();
        const running = f.service.continueSession(f.message);
        await prompting.promise;
        await f.doc.pushMessageQueue({
          task: 'B',
          userTurnId: 'B',
          userId: 'user-1',
          timestamp: '2026-11-20T00:00:00Z',
          project: undefined,
          acpSessionConfig: { ...f.message.acpSessionConfig, prompt: 'B' },
        });
        const turnId = f.service.getExecutionSnapshot(f.message.sessionId).activeTurnId!;
        await f.service.cancelSession({
          type: 'session/cancel',
          sessionId: f.message.sessionId,
          turnId,
          machineId: 'machine-1',
          workspaceId: 'workspace-1' as WorkspaceId,
        });
        release.resolve();
        await running;
        expect(await f.doc.getMessageQueue()).toEqual([
          expect.objectContaining({ userTurnId: 'B', paused: true }),
        ]);
        expect(await f.doc.peekReadyMessageQueue()).toBeNull();
        expect(received).toEqual(['CURRENT_REQUEST']);
      } finally {
        release.resolve();
        await f.close();
      }
    }
  );

  it('Stop accepted while input is being built submits nothing and retains all eight results', async () => {
    const building = createDeferred();
    const release = createDeferred();
    const received: ContentBlock[][] = [];
    const f = inboxExecutionFixture(
      async (blocks) => {
        received.push(blocks);
        return {};
      },
      async (blocks) => {
        building.resolve();
        await release.promise;
        return blocks as ContentBlock[];
      }
    );
    try {
      for (let i = 0; i < 8; i++) f.add(`saved-${i}`);
      await f.accept();
      const running = f.service.continueSession(f.message);
      await building.promise;
      const turnId = f.service.getExecutionSnapshot(f.message.sessionId).activeTurnId!;
      await f.service.cancelSession({
        cancelId: 'modern-stop',
        type: 'session/cancel',
        sessionId: f.message.sessionId,
        turnId,
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
      });
      release.resolve();
      await running;
      expect(
        (await (await createSessionBackend(f.doc)).readHistory()).find(
          (turn) => turn.id === 'human-input'
        )
      ).toMatchObject({ status: 'canceled', cancellationReason: 'user_stop' });
      expect(received).toEqual([]);
      expect(
        (f.store as unknown as { db: Database.Database }).db
          .prepare('SELECT COUNT(*) AS count FROM inbox_results WHERE consumed=0')
          .get()
      ).toEqual({ count: 8 });
      expect(f.store.inbox.pending('workspace-1')).toEqual([]);
      expect(
        (f.store as unknown as { db: Database.Database }).db
          .prepare('SELECT MAX(paused) AS paused FROM inbox_sessions WHERE session_id=?')
          .get(f.message.sessionId)
      ).toEqual({ paused: 1 });
    } finally {
      release.resolve();
      await f.close();
    }
  });

  it('received user-plus-batch input is unknown after disconnection and cannot replay on reopen', async () => {
    const received: ContentBlock[][] = [];
    const f = inboxExecutionFixture(async (blocks) => {
      received.push(structuredClone(blocks));
      throw new RequestError(-32603, 'connection disposed');
    });
    try {
      f.add('saved');
      await f.accept();
      await f.service.continueSession(f.message);
      expect(received).toHaveLength(1);
      const item = (await (await createSessionBackend(f.doc)).readHistory())
        .flatMap((e) => e.items ?? [])
        .find((i) => i.type === 'operation_completion_batch')!;
      const scope = {
        workspaceId: 'workspace-1',
        sessionId: f.message.sessionId,
        userId: 'user-1',
      };
      const id = (item as Extract<typeof item, { type: 'operation_completion_batch' }>).batchId;
      expect(f.store.inbox.getBatch(id, scope)?.state).toBe('unknown');
      const other = new LodyOperationStore(f.storePath, f.now);
      try {
        other.inbox.activate('workspace-1', 'replacement');
        expect(other.inbox.getBatch(id, scope)?.state).toBe('unknown');
        expect(
          other.inbox.prepare(
            { ...scope, inputId: 'human-input', kind: 'human', config: f.message.acpSessionConfig },
            'replacement'
          )
        ).toBeUndefined();
      } finally {
        other.close();
      }
      expect(received).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
});

describe('Provider quota refresh', () => {
  it('publishes a cold query for its exact Provider and coalesces concurrent consumers', async () => {
    const pending = createDeferred<typeof snapshot>();
    const ready = createDeferred();
    const read = vi.spyOn(quotaRunner, 'queryLocalAcpRateLimits').mockImplementation(async () => {
      ready.resolve();
      return pending.promise;
    });
    try {
      const harness = quotaHarness();
      const first = harness.service.refreshProviderRateLimits(capabilityConfigId);
      await ready.promise;
      const second = harness.service.refreshProviderRateLimits(capabilityConfigId);
      pending.resolve(snapshot);
      expect((await first).success).toBe(true);
      expect((await second).success).toBe(true);
      expect([...harness.rows.entries()]).toEqual([
        [`${capabilityConfigId}/example`, snapshot.rateLimits[0]],
      ]);
    } finally {
      read.mockRestore();
    }
  });

  it('forwards pushed capacity snapshots with the originating binding to Automation', async () => {
    const harness = quotaHarness();
    const observed = createDeferred<{
      bindingId: string;
      fingerprint: string;
      snapshot: typeof snapshot;
      source: string;
    }>();
    harness.service.setAutomationObservations({
      stage: () => {},
      turn: async () => {},
      capacity: async (binding, value, source) =>
        observed.resolve({ ...binding, snapshot: value, source }),
    });
    harness.service.noteProviderRateLimitsUpdate(
      capabilityConfigId,
      { bindingId: capabilityConfigId, fingerprint: 'origin' },
      snapshot
    );
    expect(await observed.promise).toEqual({
      bindingId: capabilityConfigId,
      fingerprint: 'origin',
      snapshot,
      source: 'push',
    });
  });

  it.each([
    ['codex', 'OPENAI_API_KEY'],
    ['claude', 'ANTHROPIC_BASE_URL'],
    ['grok', 'XAI_API_KEY'],
  ])(
    'refreshes %s with tool env but preserves cached quota for account overrides',
    async (agentType, accountKey) => {
      const read = vi
        .spyOn(quotaRunner, 'queryLocalAcpRateLimits')
        .mockImplementation(async (options) => {
          expect(options.agentConfigId).toBe(capabilityConfigId);
          expect(options.env?.OP_TOKEN).toBe('synthetic');
          return snapshot;
        });
      const status = vi
        .spyOn(SessionExecutionService.prototype, 'getMachineAcpBinaryStatus')
        .mockResolvedValue({
          type: 'machine/acp-binary-status_response',
          machineId: 'machine-1',
          agentType,
          success: true,
          status: 'installed',
        });
      try {
        const allowed = quotaHarness(true, {
          cliType: 'builtin',
          agentType,
          env: { OP_TOKEN: 'synthetic' },
        });
        expect((await allowed.service.refreshProviderRateLimits(capabilityConfigId)).success).toBe(
          true
        );
        const key = `${capabilityConfigId}/example`;
        expect(allowed.rows.get(key)).toEqual(snapshot.rateLimits[0]);

        const blocked = quotaHarness(true, {
          cliType: 'builtin',
          agentType,
          env: { OP_TOKEN: 'synthetic', [accountKey]: 'synthetic' },
        });
        blocked.rows.set(key, 'previous');
        expect((await blocked.service.refreshProviderRateLimits(capabilityConfigId)).success).toBe(
          false
        );
        expect(blocked.rows.get(key)).toBe('previous');
      } finally {
        read.mockRestore();
        status.mockRestore();
      }
    }
  );

  it.each(['empty', 'failure', 'push', 'deleted', 'changed', 'unsupported'] as const)(
    'preserves old quota on %s',
    async (mode) => {
      const pending = createDeferred<typeof snapshot>();
      const ready = createDeferred();
      const read = vi.spyOn(quotaRunner, 'queryLocalAcpRateLimits').mockImplementation(async () => {
        ready.resolve();
        return pending.promise;
      });
      try {
        const harness = quotaHarness(mode !== 'unsupported');
        const key = `${capabilityConfigId}/example`;
        harness.rows.set(key, 'previous');
        const request = harness.service.refreshProviderRateLimits(capabilityConfigId);
        if (mode !== 'unsupported') await ready.promise;
        if (mode === 'push') {
          harness.service.noteProviderRateLimitsUpdate(capabilityConfigId, undefined, snapshot);
          harness.rows.set(key, 'newer-push');
        }
        if (mode === 'deleted') harness.remove();
        if (mode === 'changed') harness.change();
        if (mode === 'failure') pending.reject(new Error('provider unavailable'));
        else pending.resolve(mode === 'empty' ? { rateLimits: [] } : snapshot);
        expect((await request).success).toBe(false);
        expect(harness.rows.get(key)).toBe(mode === 'push' ? 'newer-push' : 'previous');
      } finally {
        read.mockRestore();
      }
    }
  );

  it('keeps independent Providers, bounds freshness, and waits for the prior launch before replacement', async () => {
    let now = 0;
    const cache = new ProviderQuotaRefreshCache(() => now);
    const pending = createDeferred<boolean>();
    const ready = createDeferred();
    const states: string[] = [];
    const first = cache.run('a', 'old', async () => {
      ready.resolve();
      await pending.promise;
      states.push('old-released');
      return true;
    });
    await ready.promise;
    const same = cache.run('a', 'old', async () => {
      throw new Error('duplicate owner');
    });
    const next = cache.run('a', 'new', async () => {
      states.push('new');
      return true;
    });
    await expect(cache.run('b', 'other', async () => false)).resolves.toBe(false);
    expect(states).toEqual([]);
    pending.resolve(true);
    await Promise.all([first, same, next]);
    expect(states).toEqual(['old-released', 'new']);
    await expect(cache.run('a', 'new', async () => false)).resolves.toBe(true);
    now = 15_000;
    await expect(cache.run('a', 'new', async () => false)).resolves.toBe(false);
    now += 5_000;
    await expect(cache.run('a', 'new', async () => true)).resolves.toBe(true);
  });

  it('quarantines unconfirmed process cleanup across launch changes', async () => {
    const cache = new ProviderQuotaRefreshCache(
      () => 100_000,
      () => false
    );
    await expect(
      cache.run('a', 'old', async () => {
        throw new Error('unreleased child');
      })
    ).resolves.toBe(false);
    await expect(cache.run('a', 'new', async () => true)).resolves.toBe(false);
    await expect(cache.run('b', 'other', async () => true)).resolves.toBe(true);
  });
});

describe('session start retry pacing', () => {
  it('caps retries per window across Sessions and frees them as the window passes', () => {
    const startedAt: number[] = [];
    const budget = { limit: 2, windowMs: 60_000 };
    expect(takeSessionStartRetry(startedAt, 0, budget)).toBe(true);
    expect(takeSessionStartRetry(startedAt, 1_000, budget)).toBe(true);
    // A machine-wide failure must not turn every turn's retries into more load.
    expect(takeSessionStartRetry(startedAt, 2_000, budget)).toBe(false);
    expect(takeSessionStartRetry(startedAt, 60_000, budget)).toBe(true);
    expect(startedAt).toEqual([1_000, 60_000]);
  });

  it('spreads retry delays over the upper half of the base delay', () => {
    expect(jitterSessionStartRetryDelay(1_000, 0)).toBe(500);
    expect(jitterSessionStartRetryDelay(1_000, 0.999)).toBe(1_000);
    expect(jitterSessionStartRetryDelay(3_000, 0.5)).toBe(2_250);
  });
});
