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
import {
  commitPreparedSessionDispatch,
  isPreparedSessionDispatched,
  materializePreparedSessionInput,
  type PreparedSessionInput,
} from '../prepared-session-input';

import { ScheduleEngine, type ScheduleEnginePorts } from './schedule-engine';
import { ScheduleStore } from './schedule-store';
import { scheduleDestinationSessionId } from './schedule-run-preparation';

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
