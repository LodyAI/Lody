import { LoroDoc } from 'loro-crdt';
import { ScheduleRepository, type ScheduleRepositoryPort } from '@lody/shared';
import { isScheduledMessageFile } from './scheduled-message-files';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildScheduleRegistryRow,
  ScheduleDefinitionSchema,
  zonedLocalInputToInstant,
  type ScheduleDocument,
} from '@lody/shared';
import { findNextDispatchableUserTurn } from '@/session/session-dispatch-logic';
import { ScheduleStore } from './schedule-store';
import {
  ScheduleConfigurationError,
  ScheduleEngine,
  type ScheduleEnginePorts,
} from './schedule-engine';

const document = (): ScheduleDocument => ({
  definition: ScheduleDefinitionSchema.parse({
    scheduleId: 'schedule',
    title: 'Nightly',
    ownerId: 'owner',
    machineId: 'machine',
    enabled: true,
    activationId: 'activation',
    activeFrom: 0,
    trigger: { kind: 'interval', everyMs: 60_000, anchorAt: '1970-01-01T00:00:00Z' },
    misfirePolicy: { kind: 'run_once' },
    overlapPolicy: 'queue_one',
    agent: { agentConfigId: 'agent', modeId: 'safe' },
    project: { kind: 'github', repoFullName: 'loro-dev/lody', branch: 'main' },
    retryPolicy: { dispatchMaxAttempts: 5, dispatchMaxAgeMs: 86_400_000 },
    createdAt: 0,
    updatedAt: 0,
    createdBy: 'owner',
  }),
  prompt: 'original',
  timeline: [],
});
const stores: ScheduleStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function harness(d = document()) {
  const store = new ScheduleStore<{ prompt: string }>(':memory:');
  stores.push(store);
  let row = buildScheduleRegistryRow(d);
  let now = 60_000;
  let ready = true;
  let disabled = false;
  let accepted = false;
  let finished = false;
  const ports: ScheduleEnginePorts<{ prompt: string }> = {
    workspaceId: 'workspace',
    machineId: 'machine',
    userId: 'owner',
    store,
    now: () => now,
    ready: () => ready,
    disabled: () => disabled,
    list: async () => [row],
    read: async () => d,
    validateTarget: async () => {},
    prepare: vi.fn(async (run) => ({ prompt: run.prompt })),
    materialize: vi.fn(async () => {}),
    isDispatched: async () => accepted,
    dispatch: vi.fn(async () => {
      accepted = true;
    }),
    isFinished: async () => finished,
    publish: vi.fn(async () => {}),
    onError: vi.fn(),
  };
  const engine = new ScheduleEngine(ports);
  return {
    store,
    d,
    ports,
    engine,
    time: (n: number) => {
      now = n;
    },
    ready: (v: boolean) => {
      ready = v;
    },
    disabled: (v: boolean) => {
      disabled = v;
    },
    finished: () => {
      finished = true;
    },
    accepted: () => {
      accepted = true;
    },
    pause: () => {
      d.definition.enabled = false;
      row = buildScheduleRegistryRow(d);
    },
  };
}

describe('Schedule worker handoff', () => {
  it('dispatches a machine-clock Once slot at its saved instant, retaining the ledger on restart', async () => {
    const instant = zonedLocalInputToInstant('2026-10-01T02:21', 'America/Los_Angeles');
    expect(instant).toBe(Date.parse('2026-10-01T09:21:00Z'));
    const d = document();
    d.definition.trigger = { kind: 'once', at: '2026-10-01T09:21:00.000Z' };
    d.definition.activeFrom = Date.parse('2026-10-01T00:00:00Z');
    const h = harness(d);
    h.time(Date.parse('2026-10-01T09:20:59Z'));
    await h.engine.evaluate();
    expect(h.store.history('workspace', 'schedule')).toEqual([]);
    h.time(Date.parse('2026-10-01T09:21:00Z'));
    await h.engine.evaluate();
    expect(h.store.history('workspace', 'schedule')).toMatchObject([
      { scheduledFor: instant, state: 'dispatched' },
    ]);
    h.time(Date.parse('2026-10-01T09:22:00Z'));
    const restarted = new ScheduleEngine(h.ports);
    await restarted.evaluate();
    expect(h.store.history('workspace', 'schedule')).toHaveLength(1);
    expect(h.store.history('workspace', 'schedule')[0]?.scheduledFor).toBe(instant);
  });
  it('never materializes before initial/reconnect sync and never dispatches twice', async () => {
    const h = harness();
    h.ready(false);
    await h.engine.evaluate();
    expect(h.ports.prepare).not.toHaveBeenCalled();
    h.ready(true);
    await h.engine.evaluate();
    await h.engine.evaluate();
    expect(h.ports.dispatch).toHaveBeenCalledTimes(1);
    expect(h.store.unfinished('workspace')[0]?.state).toBe('dispatched');
    h.pause();
    h.disabled(true);
    h.finished();
    await h.engine.evaluate();
    expect(h.store.unfinished('workspace')).toEqual([]);
  });
  it('keeps prepared history inert if paused before the pointer handoff', async () => {
    const h = harness();
    h.ports.materialize = vi.fn(async () => {
      h.pause();
    });
    await h.engine.evaluate();
    expect(h.ports.dispatch).not.toHaveBeenCalled();
    expect(h.store.history('workspace', 'schedule')[0]?.state).toBe('skipped');
    const turn = {
      id: 'turn',
      role: 'user' as const,
      status: 'prepared' as const,
      read: true,
      timestamp: '',
      fileDiff: [],
    };
    expect(findNextDispatchableUserTurn([turn], {} as never)).toBeNull();
    expect(findNextDispatchableUserTurn([turn], { latestUserMsgId: 'turn' } as never)?.id).toBe(
      'turn'
    );
  });
  it('recognizes a committed pointer even when acknowledgement throws', async () => {
    const h = harness();
    h.ports.dispatch = vi.fn(async () => {
      h.accepted();
      throw new Error('lost acknowledgement');
    });
    await h.engine.evaluate();
    await h.engine.evaluate();
    expect(h.ports.dispatch).toHaveBeenCalledTimes(1);
    expect(h.store.unfinished('workspace')[0]?.state).toBe('dispatched');
  });
  it('retries frozen preparation and preserves attempt age', async () => {
    const h = harness();
    h.ports.materialize = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary storage failure'))
      .mockResolvedValue(undefined);
    await h.engine.evaluate();
    const run = h.store.unfinished('workspace')[0]!;
    expect(run.state).toBe('retry_wait');
    expect(run.retryAt).toBe(90_000);
    h.d.prompt = 'edited Agent default outside the frozen run';
    h.ports.read = async () => ({ ...h.d, prompt: 'original' });
    h.time(90_000);
    await h.engine.evaluate();
    expect(h.ports.prepare).toHaveBeenCalledTimes(1);
    expect(h.ports.dispatch).toHaveBeenCalledWith({ prompt: 'original' });
    expect(h.store.get(run.runKey)?.plannedAt).toBe(60_000);
  });
  it('retains prepared input when scheduling is disabled', async () => {
    const h = harness();
    h.ports.materialize = async () => {
      h.ready(false);
    };
    await h.engine.evaluate();
    h.ready(true);
    h.disabled(true);
    await h.engine.evaluate();
    expect(h.store.unfinished('workspace')[0]).toMatchObject({
      state: 'session_prepared',
      prepared: { prompt: 'original' },
    });
    expect(h.ports.dispatch).not.toHaveBeenCalled();
    expect(h.ports.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ blockedCode: 'SCHEDULES_DISABLED' })
    );
  });

  it('does not reopen future definitions on every timer tick', async () => {
    const h = harness();
    h.time(1);
    h.ports.read = vi.fn(async () => h.d);
    await h.engine.evaluate();
    h.ports.read = vi.fn(async () => h.d);
    h.time(15_000);
    await h.engine.evaluate();
    expect(h.ports.read).not.toHaveBeenCalled();
    h.time(60_000);
    await h.engine.evaluate();
    expect(h.ports.dispatch).toHaveBeenCalledTimes(1);
  });
  it('waits for target permission recovery without spending attempts or losing the slot', async () => {
    const h = harness();
    h.ports.validateTarget = async () => {
      throw new ScheduleConfigurationError('PROJECT_UNAVAILABLE');
    };
    await h.engine.evaluate();
    await h.engine.evaluate();
    expect(h.ports.dispatch).not.toHaveBeenCalled();
    expect(h.store.unfinished('workspace')[0]).toMatchObject({
      state: 'retry_wait',
      attempts: 0,
      errorCode: 'PROJECT_UNAVAILABLE',
    });
    expect(h.ports.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ queueState: 'blocked', blockedCode: 'PROJECT_UNAVAILABLE' })
    );
    h.ports.validateTarget = async () => {};
    h.time(90_000);
    await h.engine.evaluate();
    expect(h.ports.dispatch).toHaveBeenCalledTimes(1);
    expect(h.store.unfinished('workspace')[0]?.scheduledFor).toBe(60_000);
  });
  it('does not hand off a preparation that outlives its dispatch deadline', async () => {
    const h = harness();
    h.ports.materialize = vi.fn(async () => {
      h.time(86_460_000);
    });
    await h.engine.evaluate();
    expect(h.ports.dispatch).not.toHaveBeenCalled();
    expect(h.store.history('workspace', 'schedule')[0]?.errorCode).toBe('DISPATCH_EXPIRED');
  });
  it('publishes one complete projection and settles its own subscription wake', async () => {
    const h = harness();
    let last = '';
    h.ports.publish = vi.fn(async (runtime) => {
      const value = JSON.stringify(runtime);
      if (last !== value) {
        last = value;
        void h.engine.evaluate();
      }
    });
    await h.engine.evaluate();
    expect(h.ports.publish).toHaveBeenCalledTimes(2);
    expect(JSON.parse(last)).toMatchObject({
      lastDispatch: { scheduledFor: 60_000 },
      nextScheduledAt: 120_000,
    });
  });
});

it('recovers the committed ledger after closing a real SQLite file without repeating its slot', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'lody-schedule-test-'));
  const filename = path.join(directory, 'ledger.sqlite');
  const d = document();
  const fingerprint = buildScheduleRegistryRow(d).definitionFingerprint;
  let store = new ScheduleStore(filename);
  try {
    store.plan('workspace', d, fingerprint, 60_000);
    const run = store.unfinished('workspace')[0]!;
    store.transition(run.runKey, ['pending'], {
      state: 'claimed',
      attempts: 1,
      prepared: { prompt: 'frozen' },
    });
    store.close();
    store = new ScheduleStore(filename);
    store.plan('workspace', d, fingerprint, 60_000);
    expect(store.unfinished('workspace')).toHaveLength(1);
    expect(store.get(run.runKey)?.prepared).toEqual({ prompt: 'frozen' });
    expect(store.get(run.runKey)?.sessionId).toBe(run.sessionId);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('One-time complete messages', () => {
  function message() {
    const d = document();
    d.definition = {
      ...d.definition,
      messageVersion: 1,
      project: undefined,
      destination: { kind: 'existing_session', sessionId: 'chat' },
      trigger: { kind: 'once', at: '1970-01-01T00:01:00Z' },
      misfirePolicy: { kind: 'run_once' },
    };
    d.prompt = 'Frozen message';
    d.message = { inputBlocks: [{ type: 'text', text: 'Frozen message' }], mcpServerIds: [] };
    return d;
  }
  it.each([
    ['message', 'message'],
    ['task', 'message'],
    ['message', 'task'],
  ] as const)(
    'does not couple a running %s to an unrelated %s on the same agent',
    async (firstKind, nextKind) => {
      const first = firstKind === 'message' ? message() : document();
      const next = nextKind === 'message' ? message() : document();
      next.definition.scheduleId = 'other-schedule';
      next.definition.destination = { kind: 'existing_session', sessionId: 'other-chat' };
      const documents = [first];
      const h = harness(first);
      h.ports.list = async () => documents.map(buildScheduleRegistryRow);
      h.ports.read = async (id) =>
        documents.find((entry) => entry.definition.scheduleId === id) ?? null;
      h.ports.prepare = async (run) => ({ prompt: run.scheduleId });
      const sent: string[] = [];
      h.ports.dispatch = async (prepared) => {
        sent.push(prepared.prompt);
      };
      h.ports.isDispatched = async (prepared) => sent.includes(prepared.prompt);
      await h.engine.evaluate();
      expect(sent).toEqual(['schedule']);
      expect(h.store.history('workspace', 'schedule')[0]?.state).toBe('dispatched');
      // Restart while the first conversation is still running. Its delivery must
      // neither repeat nor block another conversation's admission.
      const restarted = new ScheduleEngine(h.ports);
      documents.push(next);
      h.time(60_001);
      await restarted.evaluate();
      expect(sent).toEqual(['schedule', 'other-schedule']);
      expect(h.store.history('workspace', 'other-schedule')[0]?.state).toBe('dispatched');
      expect(h.store.history('workspace', 'schedule')[0]?.state).toBe('dispatched');
      await restarted.evaluate();
      expect(sent).toEqual(['schedule', 'other-schedule']);
    }
  );

  it('waits for its own busy chat and sends once after it becomes idle', async () => {
    const h = harness(message());
    let busy = true;
    const sent: string[] = [];
    h.ports.validateTarget = async () => {
      if (busy) throw new ScheduleConfigurationError('SESSION_BUSY');
    };
    h.ports.dispatch = async (prepared) => {
      sent.push(prepared.prompt);
      h.accepted();
    };
    await h.engine.evaluate();
    expect(sent).toEqual([]);
    expect(h.store.history('workspace', 'schedule')[0]).toMatchObject({
      state: 'retry_wait',
      errorCode: 'SESSION_BUSY',
      attempts: 0,
    });
    busy = false;
    h.time(90_000);
    await h.engine.evaluate();
    await h.engine.evaluate();
    expect(sent).toEqual(['Frozen message']);
    expect(h.store.history('workspace', 'schedule')[0]?.state).toBe('dispatched');
  });

  it('retains frozen blocks in the ledger and restores sent status without sending again', async () => {
    const h = harness(message());
    h.time(600_000); // Offline at the due time: one catch-up.
    await h.engine.evaluate();
    const [run] = h.store.history('workspace', 'schedule');
    expect(run?.message).toEqual(h.d.message);
    expect(run?.sessionId).toBe('chat');
    expect(run?.state).toBe('dispatched');
    const restarted = new ScheduleEngine(h.ports);
    await restarted.evaluate();
    expect(h.store.history('workspace', 'schedule')).toHaveLength(1);
    expect(h.store.history('workspace', 'schedule')[0]?.state).toBe('dispatched');
    expect(h.ports.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messageState: 'sent',
        lastDispatch: expect.objectContaining({ sessionId: 'chat' }),
      })
    );
  });
  it('never sends a consumed message again after a stale edit, even after restart', async () => {
    const h = harness(message());
    const delivered: string[] = [];
    h.ports.dispatch = async (prepared) => {
      delivered.push(prepared.prompt);
      h.accepted();
    };
    await h.engine.evaluate();
    h.finished();
    await h.engine.evaluate();
    h.d.prompt = 'edited after delivery';
    h.d.message = { inputBlocks: [{ type: 'text', text: h.d.prompt }] };
    h.d.definition.activationId = 'stale-client-edit';
    h.d.definition.trigger = { kind: 'once', at: new Date(120_000).toISOString() };
    h.ports.list = async () => [buildScheduleRegistryRow(h.d)];
    h.time(120_000);
    const restarted = new ScheduleEngine(h.ports);
    await restarted.evaluate();
    expect(delivered).toEqual(['Frozen message']);
    expect(h.store.history('workspace', 'schedule')).toHaveLength(1);
    expect(h.ports.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({
        activationId: 'stale-client-edit',
        messageState: 'sent',
        lastDispatch: expect.objectContaining({ sessionId: 'chat' }),
      })
    );
  });

  it('acknowledges cancellation before a future message has a run', async () => {
    const h = harness(message());
    h.time(1);
    h.pause();
    await h.engine.evaluate();
    expect(h.store.history('workspace', 'schedule')).toEqual([]);
    expect(h.ports.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ messageState: 'cancelled' })
    );
  });
  it('reports sent if a cancellation races a committed dispatch receipt', async () => {
    const h = harness(message());
    h.ports.dispatch = async () => {
      h.accepted();
      h.pause();
      throw new Error('lost receipt');
    };
    await h.engine.evaluate();
    expect(h.store.history('workspace', 'schedule')[0]?.state).toBe('dispatched');
    expect(h.ports.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ messageState: 'sent' })
    );
  });
});

it('retains scheduled local bytes without history and releases the reservation after deletion', async () => {
  const docs = new Map<string, LoroDoc>();
  const rows = new Map<string, unknown>();
  const port: ScheduleRepositoryPort = {
    openPersistedDoc: async (id) => {
      if (!docs.has(id)) docs.set(id, new LoroDoc());
      return { doc: docs.get(id)! };
    },
    openFlockDoc: async () => ({
      flock: {
        scan: () => [...rows].map(([key, value]) => ({ key: JSON.parse(key), value })),
        get: (key) => rows.get(JSON.stringify(key)),
        set: (key, value) => rows.set(JSON.stringify(key), value),
      },
    }),
    flush: async () => {},
  };
  const repository = new ScheduleRepository(port, 'workspace' as never);
  const d = document().definition;
  await repository.save({
    scheduleId: 'message-file',
    actorId: 'owner',
    now: 1,
    activationId: 'a',
    activityId: 'create',
    create: true,
    draft: {
      title: d.title,
      machineId: d.machineId,
      agent: d.agent,
      retryPolicy: d.retryPolicy,
      misfirePolicy: d.misfirePolicy,
      overlapPolicy: d.overlapPolicy,
      prompt: '',
      destination: { kind: 'existing_session', sessionId: 'chat' },
      trigger: { kind: 'once', at: '2099-01-01T00:00:00Z' },
      message: {
        inputBlocks: [
          {
            type: 'file',
            fileId: 'blob',
            fileName: 'notes.txt',
            mimeType: 'text/plain',
            sizeBytes: 5,
            sha256: 'a'.repeat(64),
            textPreview: true,
            uploadedAt: 1,
            transport: 'local',
            machineId: 'machine',
          },
        ],
      },
    },
  });
  const args = {
    repo: port,
    workspaceId: 'workspace' as never,
    sessionId: 'chat' as never,
    fileId: 'blob',
  };
  expect(await isScheduledMessageFile(args)).toBe(true);
  expect(await isScheduledMessageFile({ ...args, sessionId: 'other' as never })).toBe(false);
  await repository.delete('message-file', 'owner', 2);
  expect(await isScheduledMessageFile(args)).toBe(false);
});
