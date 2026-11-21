import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LoroDoc } from 'loro-crdt';
import { Mirror } from 'loro-mirror';
import { withHistoryPort } from '../../../tests/history-port-fixture';
import {
  commitPreparedSessionDispatch,
  isPreparedSessionDispatched,
  materializePreparedSessionInput,
  type PreparedSessionInput,
} from '../prepared-session-input';
import type { StreamsRoomBinding } from '../loro/streams-room-binding';
import { findNextDispatchableUserTurn } from '@/session/session-dispatch-logic';
import { ScheduleEngine, type ScheduleEnginePorts } from './schedule-engine';
import { ScheduleStore, type ScheduleRun } from './schedule-store';
import { createScheduleSyncGate } from './schedule-sync-gate';
import {
  destinationSessionProblem,
  scheduleDestinationSessionId,
  withScheduledMessageInput,
} from './schedule-run-preparation';
import { projectTurnAttention } from '@lody/shared/notifications';
import { turnNotificationAudience } from '../notifications/turn-notification-audience';
import { describe, expect, it, vi } from 'vitest';
import {
  buildScheduleRegistryRow,
  getSessionRoomId,
  ScheduleAgentSchema,
  ScheduleDefinitionSchema,
  type AcpCapabilityCacheEntry,
  type AgentConfigMeta,
  type MachineMeta,
  type ProjectRef,
  type ScheduleDefinition,
  type ScheduleDocument,
  type SessionHistoryInput,
  type SessionId,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';
import { sessionDocSchema } from '@lody/shared/session-doc-schemas';

import { prepareSessionInput, resolveTurnDispatchConfig } from '@/commands/session';
import type { AuthContext } from '../command-runtime';
import type { LoroDocumentManager } from '../loro/doc';
import type { WorkspaceSummary } from '../workspace';
import {
  buildScheduleRunTarget,
  resolveScheduleAgentRunConfig,
  buildScheduleSessionCreateOptions,
} from './schedule-run-preparation';

/**
 * The PRODUCTION `prepareSessionInput`, not a stand-in for it.
 *
 * Only the pieces a scheduled run genuinely does not reach are absent: the
 * workspace-meta prewrite is already satisfied by the engine, and the quota
 * check short-circuits without a billing entitlement. Everything that decides
 * where a run happens — the target, the create options, and the `SessionMeta`
 * they produce — is the real code path.
 */
const auth = { userId: 'owner', machineId: 'machine' } as unknown as AuthContext;
const workspace = { id: 'workspace' } as unknown as WorkspaceSummary;
const targetMachine = {
  id: 'machine',
  ownerUserId: 'owner',
  protocolCapabilities: {},
} as unknown as MachineMeta;
const agentConfig = {
  id: 'agent',
  machineId: 'machine',
  cliType: 'claude',
  agentType: 'claude',
} as unknown as AgentConfigMeta;

/** No billing entitlement, so the quota check returns before any scan. */
const manager = {
  repo: {
    getDocMeta: async () => undefined,
    getWorkspaceMeta: async () => undefined,
    openFlockDoc: async () => ({ flock: { scan: () => [] } }),
  },
  syncMetaOrThrow: async () => {},
} as unknown as LoroDocumentManager;

const prepare = (
  project?: ProjectRef,
  { prompt = 'Say good morning.', title = 'Morning check-in' } = {}
) =>
  prepareSessionInput(
    auth,
    workspace,
    manager,
    prompt,
    buildScheduleSessionCreateOptions({
      sessionId: 'session-1' as SessionId,
      userTurnId: 'turn-1',
      agentConfigId: 'agent',
      title,
      project,
    }),
    {
      ...resolveTurnDispatchConfig({}),
      inheritSessionDefaults: false,
    },
    buildScheduleRunTarget({ targetMachine, agentConfig, project })
  );

describe('Session preparation for a scheduled run', () => {
  it('produces no project, repository or branch for a chat-only schedule', async () => {
    const prepared = await prepare();
    for (const field of ['project', 'repoFullName', 'baseBranch'] as const)
      expect(prepared.meta).not.toHaveProperty(field);
    expect(prepared.meta.machineId).toBe('machine');
    expect(prepared.meta.agentConfigId).toBe('agent');
    expect(prepared.userTurn.inputConfig?.mcpServerIds).toEqual([]);
  });

  it('hands complete message blocks to both history and frozen execution input', async () => {
    const base = await prepare();
    const blocks = [
      {
        type: 'file' as const,
        fileId: 'frozen-file',
        fileName: 'notes.txt',
        mimeType: 'text/plain',
        sizeBytes: 5,
        sha256: 'a'.repeat(64),
        textPreview: true,
        transport: 'local' as const,
        machineId: 'machine',
        uploadedAt: 1,
      },
      { type: 'text' as const, text: 'Say good morning.' },
    ];
    const prepared = withScheduledMessageInput(base, { inputBlocks: blocks });
    expect(prepared.userTurn.items).toContainEqual(
      expect.objectContaining({ type: 'file', fileId: 'frozen-file', transport: 'local' })
    );
    expect(prepared.userTurn.items).toContainEqual({ type: 'text', text: 'Say good morning.' });
    expect(prepared.userTurn.inputConfig?.inputBlocks).toEqual(blocks);
    expect(prepared.userTurn.inputConfig?.mcpServerIds).toEqual([]);
    expect(prepared.userTurn.status).toBe('prepared');
    expect(prepared.userTurn.id).toBe('turn-1');
    expect(base.userTurn.items).not.toContainEqual(expect.objectContaining({ type: 'file' }));
  });

  it('treats a prepared scheduled turn as an ordinary user notification source', async () => {
    const prepared = await prepare();
    expect(prepared.userTurn.role).toBe('user');
    const audience = turnNotificationAudience(prepared.userTurn.author);
    expect(audience).toEqual({ kind: 'user' });
    for (const outcome of [{ kind: 'succeeded' }, { kind: 'failed', code: 'synthetic' }] as const) {
      const item = projectTurnAttention({
        scope: { workspaceId: 'workspace' as WorkspaceId, recipientId: prepared.meta.userId },
        sessionId: prepared.sessionId,
        turnId: prepared.userTurn.id,
        audience,
        outcome,
      });
      expect(item?.source.turnId).toBe(prepared.userTurn.id);
      expect(item?.outcome).toBe(outcome.kind);
    }
  });
});

describe('Schedule ACP values reach ordinary Session preparation', () => {
  const capability: AcpCapabilityCacheEntry = {
    cliType: 'custom',
    agentType: 'acp',
    modes: [],
    models: [{ modelId: 'opus', name: 'Opus' }],
    fetchedAt: 0,
    configOptions: [
      { id: 'plan_mode', name: 'Plan', type: 'boolean', currentValue: false, options: [] },
      {
        id: 'select_flag',
        name: 'String choice',
        type: 'select',
        currentValue: 'false',
        options: [{ value: 'false', name: 'False' }],
      },
    ],
  };
  const config = { ...agentConfig, cliType: 'custom' as const, agentType: 'acp' };
  const localManager = {
    syncMetaOrThrow: async () => {},
    repo: {
      getDocMeta: async () => undefined,
      getWorkspaceMeta: async () => undefined,
      openFlockDoc: async () => ({
        flock: {
          scan: () => [{ key: ['acpCapability', 'agent'], value: capability }],
        },
      }),
    },
  } as unknown as LoroDocumentManager;
  const prepareOptions = async (
    planMode: string | boolean,
    fastValues: Record<string, string | boolean> = {}
  ) => {
    const stored = ScheduleAgentSchema.parse({
      agentConfigId: 'agent',
      modelId: Object.keys(fastValues).length > 0 ? 'opus' : undefined,
      configOptionValues: { plan_mode: planMode, select_flag: 'false', ...fastValues },
    });
    const agent = await resolveScheduleAgentRunConfig(
      localManager,
      'workspace' as WorkspaceId,
      targetMachine.id,
      stored
    );
    const prepared = await prepareSessionInput(
      auth,
      workspace,
      localManager,
      'Synthetic scheduled prompt',
      buildScheduleSessionCreateOptions({
        sessionId: 'session-1' as SessionId,
        userTurnId: 'turn-1',
        agentConfigId: 'agent',
        title: 'Schedule',
      }),
      { ...resolveTurnDispatchConfig({}), ...agent, inheritSessionDefaults: false },
      buildScheduleRunTarget({ targetMachine, agentConfig: config })
    );
    expect(stored.configOptionValues?.plan_mode).toBe(planMode);
    return prepared;
  };
  it.each([false, true, 'false', 'true'])(
    'prepares typed and legacy boolean %s without changing select strings',
    async (value) => {
      const prepared = await prepareOptions(value);
      expect(prepared.userTurn.status).toBe('prepared');
      expect(prepared.userTurn.inputConfig?.configOptionValues).toEqual({
        plan_mode: value === true || value === 'true',
        select_flag: 'false',
      });
    }
  );
  it.each([
    { fast: 'false', 'fast-mode': 'true', expected: { fast: false, 'fast-mode': true } },
    { fast: 'true', 'fast-mode': 'false', expected: { fast: true, 'fast-mode': false } },
  ])('prepares legacy Fast values when the probe omits both Fast controls', async (values) => {
    const { expected, ...fastValues } = values;
    const prepared = await prepareOptions(false, fastValues);

    expect(prepared.userTurn.inputConfig?.configOptionValues).toEqual({
      plan_mode: false,
      select_flag: 'false',
      ...expected,
    });
  });
});

describe('Where a run is sent', () => {
  const machineId = 'machine';
  const meta = (overrides: Partial<SessionMeta> = {}) =>
    ({
      id: 's1',
      userId: 'owner',
      machineId,
      agentConfigId: 'agent',
      ...overrides,
    }) as SessionMeta;

  it('lets an owned chat be created by the first run, but never a picked chat', () => {
    const base = { userId: 'owner', machineId, agentConfigId: 'agent' };
    expect(
      destinationSessionProblem({
        ...base,
        destination: { kind: 'own_session', epoch: 0 },
        session: { kind: 'absent' },
      })
    ).toBeNull();
    expect(
      destinationSessionProblem({
        ...base,
        destination: { kind: 'existing_session', sessionId: 's1' },
        session: { kind: 'absent' },
      })
    ).toBe('SESSION_UNAVAILABLE');
  });

  it('refuses a chat that is deleted, someone else’s, elsewhere, or driven by another Agent', () => {
    const base = { userId: 'owner', machineId, agentConfigId: 'agent' };
    const destination = { kind: 'existing_session', sessionId: 's1' } as const;
    expect(
      destinationSessionProblem({
        ...base,
        destination,
        session: { kind: 'present', meta: meta() },
      })
    ).toBeNull();
    expect(destinationSessionProblem({ ...base, destination, session: { kind: 'deleted' } })).toBe(
      'SESSION_UNAVAILABLE'
    );
    for (const wrong of [{ userId: 'other' }, { machineId: 'laptop' }, { agentConfigId: 'writer' }])
      expect(
        destinationSessionProblem({
          ...base,
          destination,
          session: { kind: 'present', meta: meta(wrong) },
        })
      ).toBe('SESSION_UNAVAILABLE');
  });
});

describe('Owned-chat schedule handoff', () => {
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

  it('sends two runs into one Session as two prepared turns', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'lody-schedule-own-'));
    const store = new ScheduleStore<PreparedSessionInput>(path.join(directory, 'runs.sqlite'));
    const metas = new Map<string, SessionMeta>();
    const mirrors = new Map<string, Mirror<typeof sessionDocSchema>>();
    const handoffManager = {
      repo: {
        getDocMeta: async (id: string) => (metas.has(id) ? { meta: metas.get(id) } : undefined),
        upsertDocMeta: async (id: string, patch: Partial<SessionMeta>) => {
          metas.set(id, { ...metas.get(id), ...patch } as SessionMeta);
        },
        flush: async () => {},
      },
      isEncryptedWorkspace: () => false,
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
          },
        } satisfies PreparedSessionInput;
      },
      materialize: (prepared) => materializePreparedSessionInput(handoffManager, prepared),
      isDispatched: (prepared) => isPreparedSessionDispatched(handoffManager, prepared),
      dispatch: (prepared) => commitPreparedSessionDispatch(handoffManager, prepared),
      isFinished: async () => true,
      publish: async () => {},
      onError: () => {},
    };
    const engine = new ScheduleEngine(ports);
    try {
      await engine.evaluate();
      expect(store.unfinished('workspace')).toHaveLength(0);
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

describe('Schedule to ordinary Session handoff', () => {
  for (const crashAt of ['prepared', 'pointer'] as const) {
    it(`restarts after ${crashAt} without creating a second Session or changing frozen input`, async () => {
      const directory = mkdtempSync(path.join(os.tmpdir(), 'lody-schedule-handoff-'));
      const filename = path.join(directory, 'runs.sqlite');
      let store = new ScheduleStore<PreparedSessionInput>(filename);
      const metaFile = path.join(directory, 'meta.json');
      const metas = new Map<string, SessionMeta>();
      const docs = new Map<string, Mirror<typeof sessionDocSchema>>();
      const loroDocs = new Map<string, LoroDoc>();
      const handoffManager = {
        repo: {
          getDocMeta: async (id: string) => (metas.has(id) ? { meta: metas.get(id) } : undefined),
          upsertDocMeta: async (id: string, patch: Partial<SessionMeta>) => {
            metas.set(id, { ...metas.get(id), ...patch } as SessionMeta);
            writeFileSync(metaFile, JSON.stringify([...metas]));
          },
          flush: async () => {
            for (const [id, doc] of loroDocs)
              writeFileSync(path.join(directory, id + '.loro'), doc.export({ mode: 'snapshot' }));
          },
        },
        isEncryptedWorkspace: () => false,
        getOrCreateSessionDoc: async (id: string) => {
          if (!docs.has(id)) {
            const doc = new LoroDoc();
            const snapshot = path.join(directory, id + '.loro');
            if (existsSync(snapshot)) doc.import(readFileSync(snapshot));
            loroDocs.set(id, doc);
            docs.set(
              id,
              new Mirror({ doc, schema: sessionDocSchema, initialState: { history: [] } })
            );
          }
          const mirror = docs.get(id)!;
          return withHistoryPort({
            getHistory: () => mirror.getState().history,
            updateHistory: async (
              update: (history: SessionHistoryInput[]) => SessionHistoryInput[]
            ) => {
              mirror.setState({ ...mirror.getState(), history: update(mirror.getState().history) });
            },
          });
        },
      } as unknown as LoroDocumentManager;
      const document: ScheduleDocument = {
        definition: ScheduleDefinitionSchema.parse({
          scheduleId: 'once',
          title: 'Once',
          ownerId: 'owner',
          machineId: 'machine',
          enabled: true,
          activationId: 'activation',
          activeFrom: 0,
          trigger: { kind: 'once', at: '1970-01-01T00:01:00Z' },
          misfirePolicy: { kind: 'run_once' },
          overlapPolicy: 'queue_one',
          agent: { agentConfigId: 'agent', modeId: 'safe' },
          project: { kind: 'github', repoFullName: 'example/project', branch: 'main' },
          retryPolicy: { dispatchMaxAttempts: 5, dispatchMaxAgeMs: 86_400_000 },
          createdAt: 0,
          updatedAt: 0,
          createdBy: 'owner',
        }),
        prompt: 'Frozen prompt',
        timeline: [],
      };
      let now = 60_000;
      let connected = true;
      let crash = true;
      const prepareRun = vi.fn(
        async (run: ScheduleRun<PreparedSessionInput>): Promise<PreparedSessionInput> => ({
          sessionId: run.sessionId as PreparedSessionInput['sessionId'],
          meta: {
            id: run.sessionId,
            machineId: 'machine',
            userId: 'owner',
            agentConfigId: 'agent',
            title: 'Once',
            scheduleId: 'once',
          } as SessionMeta,
          userTurn: {
            id: run.userTurnId,
            role: 'user',
            status: 'prepared',
            read: true,
            timestamp: new Date(now).toISOString(),
            items: [{ type: 'text', text: run.prompt }],
            fileDiff: [],
          },
        })
      );
      const dispatch = vi.fn(async (prepared: PreparedSessionInput) => {
        await commitPreparedSessionDispatch(handoffManager, prepared);
      });
      const ports = (): ScheduleEnginePorts<PreparedSessionInput> => ({
        workspaceId: 'workspace',
        machineId: 'machine',
        userId: 'owner',
        store,
        now: () => now,
        ready: () => connected,
        disabled: () => false,
        list: async () => [buildScheduleRegistryRow(document)],
        read: async () => document,
        validateTarget: async () => {},
        prepare: prepareRun,
        materialize: async (prepared) => {
          await materializePreparedSessionInput(handoffManager, prepared);
          if (crash && crashAt === 'prepared') {
            crash = false;
            connected = false;
          }
        },
        isDispatched: (prepared) => isPreparedSessionDispatched(handoffManager, prepared),
        dispatch,
        isFinished: async () => false,
        publish: async () => {},
        onError: () => {},
      });
      try {
        if (crashAt === 'pointer') {
          const transition = store.transition.bind(store);
          vi.spyOn(store, 'transition').mockImplementation((key, states, patch) => {
            if (patch.state === 'dispatched')
              throw new Error('process stopped before ledger acknowledgement');
            return transition(key, states, patch);
          });
        }
        let engine = new ScheduleEngine(ports());
        await engine.evaluate();
        const run = store.unfinished('workspace')[0]!;
        const history = docs.get(run.sessionId)!.getState().history;
        expect(history).toHaveLength(1);
        expect(
          findNextDispatchableUserTurn(history, metas.get(getSessionRoomId(run.sessionId))!)
        ).toEqual(crashAt === 'prepared' ? null : expect.objectContaining({ id: run.userTurnId }));
        await engine.stop();
        expect(store.get(run.runKey)?.state).toBe('session_prepared');
        store.close();
        for (const mirror of docs.values()) mirror.dispose();
        docs.clear();
        loroDocs.clear();
        metas.clear();
        for (const [id, meta] of JSON.parse(readFileSync(metaFile, 'utf8')) as [
          string,
          SessionMeta,
        ][])
          metas.set(id, meta);
        store = new ScheduleStore(filename);
        connected = true;
        now = 90_000;
        engine = new ScheduleEngine(ports());
        await engine.evaluate();
        await engine.evaluate();
        expect(prepareRun).toHaveBeenCalledOnce();
        expect(dispatch).toHaveBeenCalledOnce();
        expect(metas.size).toBe(1);
        expect(docs.size).toBe(1);
        expect(store.unfinished('workspace')[0]?.state).toBe('dispatched');
        expect(docs.get(run.sessionId)!.getState().history).toHaveLength(1);
        const prepared = store.get(run.runKey)!.prepared!;
        await handoffManager.repo.upsertDocMeta(getSessionRoomId(run.sessionId), {
          title: 'User renamed this chat',
        });
        await materializePreparedSessionInput(handoffManager, prepared);
        expect(metas.get(getSessionRoomId(run.sessionId))?.title).toBe('User renamed this chat');
        await expect(
          materializePreparedSessionInput(handoffManager, {
            ...prepared,
            userTurn: { ...prepared.userTurn, items: [{ type: 'text', text: 'different prompt' }] },
          })
        ).rejects.toThrow('identity conflict');
        await engine.stop();
      } finally {
        store.close();
        for (const mirror of docs.values()) mirror.dispose();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});

describe('createScheduleSyncGate', () => {
  it('requires the initial and each current connection sync, ignoring stale completions and disposal', async () => {
    let status: StreamsRoomBinding['status'] = 'joined';
    let notify!: () => void;
    let initial!: () => void;
    let finish!: () => void;
    let waiting!: () => void;
    let started = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    const ready = vi.fn();
    const binding: StreamsRoomBinding = {
      get status() {
        return status;
      },
      onStatusChange: (callback) => {
        notify = () => callback(status);
        return () => {};
      },
      firstSyncedWithRemote: new Promise<void>((resolve) => {
        initial = resolve;
      }),
      waitUntilSynced: () => {
        waiting();
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
    };
    const gate = createScheduleSyncGate(binding, ready, vi.fn());
    expect(gate.isReady()).toBe(false);
    initial();
    await started;
    finish();
    await Promise.resolve();
    expect(gate.isReady()).toBe(true);
    status = 'disconnected';
    notify();
    expect(gate.isReady()).toBe(false);
    started = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    status = 'joined';
    notify();
    await started;
    expect(gate.isReady()).toBe(false);
    status = 'disconnected';
    notify();
    finish();
    await Promise.resolve();
    expect(gate.isReady()).toBe(false);
    expect(ready).toHaveBeenCalledTimes(1);
    started = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    status = 'joined';
    notify();
    await started;
    gate.dispose();
    finish();
    await Promise.resolve();
    expect(gate.isReady()).toBe(false);
  });
});
