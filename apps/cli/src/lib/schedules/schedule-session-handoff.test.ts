import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import { Mirror } from 'loro-mirror';
import {
  ScheduleDefinitionSchema,
  buildScheduleRegistryRow,
  getSessionRoomId,
  sessionDocSchema,
  type ScheduleDocument,
  type SessionMeta,
  type SessionHistoryInput,
} from '@lody/shared';
import type { LoroDocumentManager } from '../loro/doc';
import { AgentExecutionSlots } from '../agent-execution-slots';
import {
  commitPreparedSessionDispatch,
  materializePreparedSessionInput,
  isPreparedSessionDispatched,
  type PreparedSessionInput,
} from '../prepared-session-input';
import { findNextDispatchableUserTurn } from '@/session/session-dispatch-logic';
import { ScheduleEngine, type ScheduleEnginePorts } from './schedule-engine';
import { ScheduleStore, type ScheduleRun } from './schedule-store';

/** Real persisted SQLite + Loro histories, with only provider/network I/O replaced. */
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
      const manager = {
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
          return {
            getHistory: async () => mirror.getState().history,
            updateHistory: async (
              update: (history: SessionHistoryInput[]) => SessionHistoryInput[]
            ) => {
              mirror.setState({ ...mirror.getState(), history: update(mirror.getState().history) });
            },
          };
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
      const prepare = vi.fn(
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
            inputConfig: { scheduleToolsEnabled: true },
          },
        })
      );
      const dispatch = vi.fn(async (prepared: PreparedSessionInput) => {
        await commitPreparedSessionDispatch(manager, prepared);
      });
      const ports = (): ScheduleEnginePorts<PreparedSessionInput> => ({
        workspaceId: 'workspace',
        machineId: 'machine',
        userId: 'owner',
        store,
        slots: new AgentExecutionSlots(),
        now: () => now,
        ready: () => connected,
        disabled: () => false,
        list: async () => [buildScheduleRegistryRow(document)],
        read: async () => document,
        validateTarget: async () => {},
        prepare,
        materialize: async (prepared) => {
          await materializePreparedSessionInput(manager, prepared);
          if (crash && crashAt === 'prepared') {
            crash = false;
            connected = false;
          }
        },
        isDispatched: (prepared) => isPreparedSessionDispatched(manager, prepared),
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
        engine.restoreOccupancy();
        await engine.evaluate();
        await engine.evaluate();
        expect(prepare).toHaveBeenCalledOnce();
        expect(dispatch).toHaveBeenCalledOnce();
        expect(metas.size).toBe(1);
        expect(docs.size).toBe(1);
        expect(store.unfinished('workspace')[0]?.state).toBe('dispatched');
        expect(docs.get(run.sessionId)!.getState().history).toHaveLength(1);
        const prepared = store.get(run.runKey)!.prepared!;
        await manager.repo.upsertDocMeta(getSessionRoomId(run.sessionId), {
          title: 'User renamed this chat',
        });
        await materializePreparedSessionInput(manager, prepared);
        expect(metas.get(getSessionRoomId(run.sessionId))?.title).toBe('User renamed this chat');
        await expect(
          materializePreparedSessionInput(manager, {
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
