import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import { withHistoryPort } from '../../../tests/history-port-fixture';
import { Mirror } from 'loro-mirror';
import {
  ScheduleDefinitionSchema,
  buildScheduleRegistryRow,
  getSessionRoomId,
  sessionDocSchema,
  type ScheduleDefinition,
  type ScheduleDocument,
  type SessionHistoryInput,
  type SessionMeta,
} from '@lody/shared';
import type { LoroDocumentManager } from '../loro/doc';
import { AgentExecutionSlots } from '../agent-execution-slots';
import {
  commitPreparedSessionDispatch,
  isPreparedSessionDispatched,
  materializePreparedSessionInput,
  type PreparedSessionInput,
} from '../prepared-session-input';
import { findNextDispatchableUserTurn } from '@/session/session-dispatch-logic';
import { ScheduleEngine, type ScheduleEnginePorts } from './schedule-engine';
import { ScheduleStore, type ScheduleRun } from './schedule-store';
import {
  buildScheduleRunTarget,
  buildScheduleSessionCreateOptions,
  scheduleDestinationSessionId,
  scheduleRequiredLocalProjectId,
} from './schedule-run-preparation';

/** Selectors that would put a scheduled run inside a working directory. */
const WORKSPACE_SELECTORS = ['repo', 'branch', 'localProject', 'worktree'] as const;

const definition = (project?: ScheduleDefinition['project']): ScheduleDefinition =>
  ScheduleDefinitionSchema.parse({
    scheduleId: 'chat',
    title: 'Morning check-in',
    ownerId: 'owner',
    machineId: 'machine',
    enabled: true,
    activationId: 'activation',
    activeFrom: 0,
    trigger: { kind: 'once', at: '1970-01-01T00:01:00Z' },
    misfirePolicy: { kind: 'run_once' },
    overlapPolicy: 'queue_one',
    agent: { agentConfigId: 'agent', modeId: 'safe' },
    ...(project ? { project } : {}),
    retryPolicy: { dispatchMaxAttempts: 5, dispatchMaxAgeMs: 86_400_000 },
    createdAt: 0,
    updatedAt: 0,
    createdBy: 'owner',
  });

/**
 * A chat-only schedule, driven through the real engine, ledger and Loro history.
 *
 * The point of running the whole handoff rather than only the pure builders is
 * that "no project" has to survive the part that actually places a run: the
 * options handed to `prepareSessionInput`, the resolved target, and the durable
 * user turn that the ordinary dispatch watcher then owns.
 */
describe('Chat-only schedule handoff', () => {
  const run = async (
    project: ScheduleDefinition['project'] | undefined,
    body: (context: {
      options: Record<string, unknown>[];
      targets: { project?: unknown }[];
      history: SessionHistoryInput[];
      meta: SessionMeta | undefined;
      sessionId: string;
      userTurnId: string;
      state: string | undefined;
    }) => void
  ) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'lody-schedule-chat-'));
    const store = new ScheduleStore<PreparedSessionInput>(path.join(directory, 'runs.sqlite'));
    const metas = new Map<string, SessionMeta>();
    const mirrors = new Map<string, Mirror<typeof sessionDocSchema>>();
    const manager = {
      repo: {
        getDocMeta: async (id: string) => (metas.has(id) ? { meta: metas.get(id) } : undefined),
        upsertDocMeta: async (id: string, patch: Partial<SessionMeta>) => {
          metas.set(id, { ...metas.get(id), ...patch } as SessionMeta);
        },
        flush: async () => {},
      },
      getOrCreateSessionDoc: async (id: string) => {
        if (!mirrors.has(id))
          mirrors.set(
            id,
            new Mirror({
              doc: new LoroDoc(),
              schema: sessionDocSchema,
              initialState: { history: [] },
            })
          );
        const mirror = mirrors.get(id)!;
        return withHistoryPort({
          getHistory: () => mirror.getState().history,
          updateHistory: async (update: (h: SessionHistoryInput[]) => SessionHistoryInput[]) => {
            mirror.setState({ ...mirror.getState(), history: update(mirror.getState().history) });
          },
        });
      },
    } as unknown as LoroDocumentManager;

    const document: ScheduleDocument = {
      definition: definition(project),
      prompt: 'Say good morning.',
      timeline: [],
    };
    const options: Record<string, unknown>[] = [];
    const targets: { project?: unknown }[] = [];
    let identity = { sessionId: '', userTurnId: '' };

    const ports: ScheduleEnginePorts<PreparedSessionInput> = {
      workspaceId: 'workspace',
      machineId: 'machine',
      userId: 'owner',
      store,
      slots: new AgentExecutionSlots(),
      now: () => 60_000,
      ready: () => true,
      disabled: () => false,
      list: async () => [buildScheduleRegistryRow(document)],
      read: async () => document,
      validateTarget: async () => {
        // Same guard the workspace runs: nothing to look up without a project.
        expect(scheduleRequiredLocalProjectId(document.definition.project)).toBe(
          project?.kind === 'local' ? project.localProjectId : undefined
        );
      },
      prepare: async (scheduled: ScheduleRun<PreparedSessionInput>) => {
        // The real builders, so this asserts what reaches session preparation.
        options.push(
          buildScheduleSessionCreateOptions({
            sessionId: scheduled.sessionId as PreparedSessionInput['sessionId'],
            userTurnId: scheduled.userTurnId,
            agentConfigId: scheduled.definition.agent.agentConfigId,
            title: scheduled.definition.title,
            project: scheduled.definition.project,
          })
        );
        targets.push(
          buildScheduleRunTarget({
            targetMachine: { id: 'machine' } as never,
            agentConfig: { id: 'agent' } as never,
            project: scheduled.definition.project,
          })
        );
        identity = { sessionId: scheduled.sessionId, userTurnId: scheduled.userTurnId };
        return {
          sessionId: scheduled.sessionId as PreparedSessionInput['sessionId'],
          meta: {
            id: scheduled.sessionId,
            machineId: 'machine',
            userId: 'owner',
            agentConfigId: 'agent',
            title: scheduled.definition.title,
            scheduleId: scheduled.scheduleId,
          } as SessionMeta,
          userTurn: {
            id: scheduled.userTurnId,
            role: 'user',
            status: 'prepared',
            read: true,
            timestamp: new Date(60_000).toISOString(),
            items: [{ type: 'text', text: scheduled.prompt }],
            fileDiff: [],
            inputConfig: { scheduleToolsEnabled: true },
          },
        } satisfies PreparedSessionInput;
      },
      materialize: (prepared) => materializePreparedSessionInput(manager, prepared),
      isDispatched: (prepared) => isPreparedSessionDispatched(manager, prepared),
      dispatch: (prepared) => commitPreparedSessionDispatch(manager, prepared),
      isFinished: async () => false,
      publish: async () => {},
      onError: () => {},
    };

    const engine = new ScheduleEngine(ports);
    try {
      await engine.evaluate();
      const ledger = store.unfinished('workspace')[0];
      body({
        options,
        targets,
        history: mirrors.get(identity.sessionId)?.getState().history ?? [],
        meta: metas.get(getSessionRoomId(identity.sessionId as never)),
        sessionId: identity.sessionId,
        userTurnId: identity.userTurnId,
        state: ledger?.state,
      });
    } finally {
      await engine.stop();
      store.close();
      for (const mirror of mirrors.values()) mirror.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  };

  it('dispatches a run with no workspace selector and no target project', async () => {
    await run(undefined, (context) => {
      expect(context.options).toHaveLength(1);
      for (const selector of WORKSPACE_SELECTORS)
        expect(context.options[0]).not.toHaveProperty(selector);
      expect('project' in context.targets[0]!).toBe(false);

      // It really did hand off: one durable prepared turn the ordinary watcher
      // can now execute, and a dispatched ledger row.
      expect(context.history).toHaveLength(1);
      expect(findNextDispatchableUserTurn(context.history, context.meta!)).toEqual(
        expect.objectContaining({ id: context.userTurnId })
      );
      expect(context.meta?.scheduleId).toBe('chat');
      expect(context.state).toBe('dispatched');
    });
  });

  it('still carries a project when the schedule has one', async () => {
    await run({ kind: 'github', repoFullName: 'loro-dev/lody', branch: 'main' }, (context) => {
      expect(context.options[0]).toMatchObject({ repo: 'loro-dev/lody', branch: 'main' });
      expect(context.targets[0]).toMatchObject({
        project: { kind: 'github', repoFullName: 'loro-dev/lody' },
      });
      expect(context.state).toBe('dispatched');
    });
  });

  it('still requires a local project to exist for a local schedule', async () => {
    await run({ kind: 'local', localProjectId: 'p1' as never, useWorktree: true }, (context) => {
      expect(context.options[0]).toMatchObject({ localProject: 'p1', worktree: true });
    });
  });
});

/**
 * An owned chat: every run of the schedule is a new turn in ONE Session. The
 * ids come from the same derivation the engine uses, through the real ledger
 * and Loro history, so this fails if a retry or a second run ever creates a
 * second chat.
 */
describe('Owned-chat schedule handoff', () => {
  it('sends two runs into one Session as two prepared turns', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'lody-schedule-own-'));
    const store = new ScheduleStore<PreparedSessionInput>(path.join(directory, 'runs.sqlite'));
    const metas = new Map<string, SessionMeta>();
    const mirrors = new Map<string, Mirror<typeof sessionDocSchema>>();
    const manager = {
      repo: {
        getDocMeta: async (id: string) => (metas.has(id) ? { meta: metas.get(id) } : undefined),
        upsertDocMeta: async (id: string, patch: Partial<SessionMeta>) => {
          metas.set(id, { ...metas.get(id), ...patch } as SessionMeta);
        },
        flush: async () => {},
      },
      getOrCreateSessionDoc: async (id: string) => {
        if (!mirrors.has(id))
          mirrors.set(
            id,
            new Mirror({
              doc: new LoroDoc(),
              schema: sessionDocSchema,
              initialState: { history: [] },
            })
          );
        const mirror = mirrors.get(id)!;
        return withHistoryPort({
          getHistory: () => mirror.getState().history,
          updateHistory: async (update: (h: SessionHistoryInput[]) => SessionHistoryInput[]) => {
            mirror.setState({ ...mirror.getState(), history: update(mirror.getState().history) });
          },
        });
      },
    } as unknown as LoroDocumentManager;
    const document: ScheduleDocument = {
      definition: {
        ...definition(),
        scheduleId: 'own',
        trigger: { kind: 'manual' },
        destination: { kind: 'own_session', epoch: 0 },
      },
      prompt: 'Daily note.',
      timeline: [],
    };
    const fingerprint = buildScheduleRegistryRow(document).definitionFingerprint;
    const sessions = new Set<string>();
    const turns: string[] = [];
    const ports: ScheduleEnginePorts<PreparedSessionInput> = {
      workspaceId: 'workspace',
      machineId: 'machine',
      userId: 'owner',
      store,
      slots: new AgentExecutionSlots(),
      now: () => 60_000,
      ready: () => true,
      disabled: () => false,
      list: async () => [buildScheduleRegistryRow(document)],
      read: async () => document,
      validateTarget: async () => {},
      prepare: async (scheduled) => {
        sessions.add(scheduled.sessionId);
        turns.push(scheduled.userTurnId);
        return {
          sessionId: scheduled.sessionId as PreparedSessionInput['sessionId'],
          meta: {
            id: scheduled.sessionId,
            machineId: 'machine',
            userId: 'owner',
            agentConfigId: 'agent',
            title: 'Daily note',
            scheduleId: 'own',
          } as SessionMeta,
          userTurn: {
            id: scheduled.userTurnId,
            role: 'user',
            status: 'prepared',
            read: true,
            timestamp: new Date(60_000).toISOString(),
            items: [{ type: 'text', text: scheduled.prompt }],
            fileDiff: [],
            inputConfig: { scheduleToolsEnabled: true },
          },
        } satisfies PreparedSessionInput;
      },
      materialize: (prepared) => materializePreparedSessionInput(manager, prepared),
      isDispatched: (prepared) => isPreparedSessionDispatched(manager, prepared),
      dispatch: (prepared) => commitPreparedSessionDispatch(manager, prepared),
      // The chat is idle between runs, so the second run may be handed off.
      isFinished: async () => true,
      publish: async () => {},
      onError: () => {},
    };
    const engine = new ScheduleEngine(ports);
    try {
      // A manual trigger is never planned by the clock…
      await engine.evaluate();
      expect(store.unfinished('workspace')).toHaveLength(0);
      // …only by request. Two requests, evaluated one after the other.
      store.planManual('workspace', document, fingerprint, 'first', 60_000);
      await engine.evaluate();
      store.planManual('workspace', document, fingerprint, 'second', 61_000);
      await engine.evaluate();

      expect(sessions.size).toBe(1);
      expect(new Set(turns).size).toBe(2);
      const [sessionId] = sessions;
      expect(sessionId).toBe(
        scheduleDestinationSessionId('own', { kind: 'own_session', epoch: 0 })
      );
      expect(mirrors.size).toBe(1);
      const history = mirrors.get(sessionId!)!.getState().history;
      expect(history.filter((entry) => entry.role === 'user').map((entry) => entry.id)).toEqual(
        turns
      );
      expect(metas.get(getSessionRoomId(sessionId as never))?.latestUserMsgId).toBe(turns[1]);
    } finally {
      await engine.stop();
      store.close();
      for (const mirror of mirrors.values()) mirror.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
