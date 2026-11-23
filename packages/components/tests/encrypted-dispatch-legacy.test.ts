import { installIrohDailyRecorder, type IrohObservation } from '../src/lib/iroh-daily';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { LoroStreamsJsonStreamClient } from '@lody/loro-streams-rpc';
import { createEncryptedDispatchLegacy } from '../src/providers/encrypted-dispatch-legacy';

afterEach(() => vi.unstubAllGlobals());

const original = (requestId: string) => ({
  requestId,
  targetMachineId: 'machine-1',
  requesterDevice: '22'.repeat(32),
  expiresAt: 4_102_444_800_000,
  frameHex: 'ab'.repeat(200),
});
const input = (userTurnId: string) => ({
  sessionId: 'session-1',
  userTurnId,
  userId: 'member',
  timestamp: '2026-10-30T00:00:00Z',
  inputConfig: {},
});

it.each([
  { name: 'single-send control', duplicate: false, separatePrepare: false, frames: 1, fail: false },
  {
    name: 'same prepared send twice',
    duplicate: true,
    separatePrepare: false,
    frames: 1,
    fail: false,
  },
  {
    name: 'two preparations of the same original',
    duplicate: true,
    separatePrepare: true,
    frames: 1,
    fail: false,
  },
  {
    name: 'duplicate between chunk appends',
    duplicate: true,
    separatePrepare: false,
    frames: 2,
    fail: false,
  },
  {
    name: 'rejected append with a duplicate',
    duplicate: true,
    separatePrepare: false,
    frames: 1,
    fail: true,
  },
])(
  'preserves dispatch accounting: $name',
  async ({ name, duplicate, separatePrepare, frames, fail }) => {
    // Keep the SDK receipt deadline inert: all ordering comes from explicit signals.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<void>();
    type Report = { effects: { turnStarts: number; pendingDispatches: number } };
    const reports: Report[] = [];
    vi.stubGlobal('window', {
      __LODY_E2E_CLIENT_LOSS__: true,
      ipc: { send: (_channel: string, payload: Report) => reports.push(payload) },
    });
    const trace = vi.spyOn(console, 'debug').mockImplementation((_tag, event) => {
      if (event?.stage === 'append-complete') completed.resolve();
    });
    const appended: { id: string; frame: string }[] = [];
    const originalFrames = Array.from({ length: frames }, (_, i) => (i ? 'cd' : 'ab').repeat(200));
    const client = {
      ensureJsonStream: async () => undefined,
      readJsonLive: (
        _stream: string,
        _state: unknown,
        _batch: unknown,
        options: { signal: AbortSignal }
      ) =>
        new Promise<void>((resolve) => options.signal.addEventListener('abort', () => resolve())),
      appendJson: async (_stream: string, value: { id: string; frame: string }) => {
        if (appended.length === frames - 1) {
          entered.resolve();
          await release.promise;
        }
        if (fail) throw new Error('token rejected');
        appended.push(value);
      },
    } as unknown as LoroStreamsJsonStreamClient;
    const dispatcher = createEncryptedDispatchLegacy({
      workspaceId: `dispatch-accounting-${name}`,
      prepare: async () => ({ ...original('33'.repeat(16)), frames: originalFrames }),
      accept: async () => ({}) as never,
      client: async () => client,
    });
    let sending: Promise<unknown> | undefined;
    try {
      const prepared = await dispatcher.prepare('machine-1', input('one'));
      sending = prepared.send().catch(() => null);
      await entered.promise;
      if (duplicate) {
        const other = separatePrepare
          ? await dispatcher.prepare('machine-1', input('one'))
          : prepared;
        // Exercise the real SDK pending-request rejection, not a stubbed send.
        expect(await other.send()).toBeNull();
        expect(reports.at(-1)?.effects.pendingDispatches).toBe(1);
      }
      release.resolve();
      if (fail) expect(await sending).toBeNull();
      else await completed.promise;
      expect(appended).toEqual(
        fail ? [] : originalFrames.map((frame) => ({ id: '33'.repeat(16), frame }))
      );
      expect(reports.at(-1)?.effects.turnStarts).toBe(fail ? 0 : 1);
      if (!fail) {
        // A rejected duplicate after append must not count another turn either.
        expect(await prepared.send()).toBeNull();
        expect(reports.at(-1)?.effects).toMatchObject({ turnStarts: 1, pendingDispatches: 1 });
      }
      await dispatcher.close();
      await sending;
      expect(reports.at(-1)?.effects).toMatchObject({
        turnStarts: fail ? 0 : 1,
        pendingDispatches: 0,
      });
      await expect(prepared.send()).rejects.toThrow('e2ee_rpc_closed');
      expect(appended).toHaveLength(fail ? 0 : frames);
    } finally {
      release.resolve();
      await dispatcher.close();
      await sending;
      trace.mockRestore();
      vi.useRealTimers();
    }
  }
);

describe('iroh route', () => {
  let observations: IrohObservation[];
  let observed: ReturnType<typeof Promise.withResolvers<void>>;
  let removeRecorder: () => void;
  beforeEach(() => {
    observations = [];
    observed = Promise.withResolvers<void>();
    removeRecorder = installIrohDailyRecorder(async (observation) => {
      observations.push({ ...observation, path: await observation.path });
      observed.resolve();
    });
  });
  afterEach(() => removeRecorder());
  const ack = {
    type: 'session/dispatch-turn_response' as const,
    sessionId: 'session-1',
    userTurnId: 'one',
    accepted: true,
    disposition: 'accepted' as const,
  };
  const setup = (options: {
    ready: boolean;
    path?: () => Promise<'direct' | 'relay' | 'none'>;
    call?: () => Promise<string[]>;
    frames?: string[];
    unavailable?: boolean;
    streamsFail?: boolean;
    streamsUnverified?: boolean;
    clientFail?: boolean;
  }) => {
    const appended = Promise.withResolvers<{ id: string; frame: string }>();
    const appendedFrames: { id: string; frame: string }[] = [];
    const calls: { machineId: string; envelope: { id: string; frame: string } }[] = [];
    const accepted: string[] = [];
    const readerReady = Promise.withResolvers<void>();
    let replyBatch: (batch: { messages: unknown[] }) => void;
    const client = {
      ensureJsonStream: async () => undefined,
      readJsonLive: (
        _stream: string,
        _state: unknown,
        onBatch: typeof replyBatch,
        options: { signal: AbortSignal }
      ) => {
        replyBatch = onBatch;
        readerReady.resolve();
        return new Promise<void>((resolve) =>
          options.signal.addEventListener('abort', () => resolve())
        );
      },
      appendJson: async (_stream: string, value: { id: string; frame: string }) => {
        appendedFrames.push(value);
        appended.resolve(value);
        if (options.streamsFail) throw new Error('streams rejected');
        await readerReady.promise;
        replyBatch({
          messages: [
            { id: value.id, frame: (options.streamsUnverified ? '00' : 'ef').repeat(150) },
          ],
        });
      },
    } as unknown as LoroStreamsJsonStreamClient;
    const dispatcher = createEncryptedDispatchLegacy({
      workspaceId: `iroh-${Math.random()}`,
      prepare: async () => ({
        ...original('44'.repeat(16)),
        ...(options.frames ? { frames: options.frames } : {}),
      }),
      accept: async (_machineId, _input, frame) => {
        accepted.push(frame);
        if (frame !== 'ef'.repeat(150)) throw new Error('e2ee_rpc_response_invalid');
        return ack;
      },
      client: async () => {
        if (options.clientFail) throw new Error('streams token unavailable');
        return client;
      },
      iroh: options.unavailable
        ? undefined
        : {
            path: options.path,
            ready: async () => options.ready,
            call: async (machineId, envelope) => {
              calls.push({ machineId, envelope });
              return options.call ? options.call() : ['00'.repeat(150), 'ef'.repeat(150)];
            },
          },
    });
    return { dispatcher, appended, appendedFrames, calls, accepted };
  };

  it('sends the exact original over a live iroh connection and verifies its reply', async () => {
    const t = setup({ ready: true, path: async () => 'direct' });
    try {
      const prepared = await t.dispatcher.prepare('machine-1', input('one'));
      expect(await prepared.send()).toEqual(ack);
      expect(t.calls).toEqual([
        { machineId: 'machine-1', envelope: { id: '44'.repeat(16), frame: 'ab'.repeat(200) } },
      ]);
      // An unverifiable reply is skipped; only the verified ACK is returned.
      expect(t.accepted).toEqual(['00'.repeat(150), 'ef'.repeat(150)]);
      expect(t.appendedFrames).toEqual([]);
      await observed.promise;
      expect(observations).toMatchObject([
        { kind: 'dispatch', outcome: 'iroh_ok', path: 'direct' },
      ]);
    } finally {
      await t.dispatcher.close();
    }
  });

  it.each([
    { name: 'no live connection', ready: false, call: undefined, outcome: 'fallback_not_ready' },
    {
      name: 'a failed iroh call',
      outcome: 'fallback_call_failed',
      ready: true,
      call: () => Promise.reject(new Error('iroh_call')),
    },
    {
      name: 'no verifiable reply',
      ready: true,
      call: async () => [],
      outcome: 'fallback_unverified',
    },
  ])(
    'falls back to Streams with the same original after $name',
    async ({ ready, call, outcome }) => {
      const t = setup({ ready, ...(call ? { call } : {}) });
      try {
        const prepared = await t.dispatcher.prepare('machine-1', input('one'));
        const result = await prepared.send();
        expect(result).toEqual(ack);
        await observed.promise;
        expect(await t.appended.promise).toEqual({ id: '44'.repeat(16), frame: 'ab'.repeat(200) });
        expect(t.calls.length).toBe(ready ? 1 : 0);
        expect(observations).toMatchObject([
          { kind: 'dispatch', outcome, streams: { success: true } },
        ]);
      } finally {
        await t.dispatcher.close();
      }
    }
  );

  it.each([false, true])(
    'only verified Streams replies count as success after fallback (append failure: %s)',
    async (streamsFail) => {
      const t = setup({ ready: false, streamsFail });
      try {
        const prepared = await t.dispatcher.prepare('machine-1', input('one'));
        const result = await prepared.send();
        await observed.promise;
        expect(result).toEqual(streamsFail ? null : ack);
        expect(observations).toMatchObject([
          { outcome: 'fallback_not_ready', streams: { success: !streamsFail } },
        ]);
      } finally {
        await t.dispatcher.close();
      }
    }
  );

  it('an E2EE client without iroh still counts the completed Streams route', async () => {
    const t = setup({ ready: false, unavailable: true });
    try {
      const prepared = await t.dispatcher.prepare('machine-1', input('one'));
      expect(await prepared.send()).toEqual(ack);
      await observed.promise;
      expect(observations).toMatchObject([{ outcome: 'unavailable', streams: { success: true } }]);
    } finally {
      await t.dispatcher.close();
    }
  });

  it('a Streams initialization failure remains a failed fallback attempt instead of disappearing', async () => {
    const t = setup({ ready: false, clientFail: true });
    try {
      const prepared = await t.dispatcher.prepare('machine-1', input('one'));
      await expect(prepared.send()).rejects.toThrow();
      await observed.promise;
      expect(observations).toMatchObject([
        { outcome: 'fallback_not_ready', streams: { success: false } },
      ]);
    } finally {
      await t.dispatcher.close();
    }
  });

  it('unverified Streams replies time out without increasing successful replies', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const t = setup({ ready: false, streamsUnverified: true });
    try {
      const prepared = await t.dispatcher.prepare('machine-1', input('one'));
      const sending = prepared.send();
      await t.appended.promise;
      await vi.advanceTimersByTimeAsync(800);
      expect(await sending).toBeNull();
      await observed.promise;
      expect(observations).toMatchObject([
        { outcome: 'fallback_not_ready', streams: { success: false } },
      ]);
    } finally {
      await t.dispatcher.close();
      vi.useRealTimers();
    }
  });

  it('cancelling after iroh readiness but before Streams excludes the unfinished encrypted request', async () => {
    const abort = new AbortController();
    const dispatcher = createEncryptedDispatchLegacy({
      workspaceId: 'cancelled-e2ee-telemetry',
      prepare: async () => original('77'.repeat(16)),
      accept: async () => ack,
      prepareFeature: async () => original('77'.repeat(16)),
      acceptFeature: async () => ({ ok: true }),
      client: async () => {
        throw new Error('Streams must not be opened');
      },
      iroh: {
        ready: async () => {
          abort.abort();
          return false;
        },
        call: async () => [],
      },
    });
    try {
      await expect(
        dispatcher.requestFeature(
          { machineId: 'machine-1', type: 'machine/get-features' } as never,
          { signal: abort.signal, requestId: '77'.repeat(16) }
        )
      ).rejects.toThrow('e2ee_rpc_aborted');
      expect(observations).toEqual([]);
    } finally {
      await dispatcher.close();
    }
  });

  it('keeps chunked originals on Streams', async () => {
    const frames = ['ab'.repeat(200), 'cd'.repeat(200)];
    const t = setup({ ready: true, frames });
    try {
      const prepared = await t.dispatcher.prepare('machine-1', input('one'));
      expect(await prepared.send()).toEqual(ack);
      await observed.promise;
      expect(await t.appended.promise).toEqual({ id: '44'.repeat(16), frame: frames[0] });
      expect(t.calls).toEqual([]);
      expect(observations).toMatchObject([{ kind: 'dispatch', outcome: 'chunked' }]);
    } finally {
      await t.dispatcher.close();
    }
  });
});

it('does not wait for an iroh call held by its host past the call budget', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const appended = Promise.withResolvers<{ id: string; frame: string }>();
    const client = {
      ensureJsonStream: async () => undefined,
      readJsonLive: (
        _stream: string,
        _state: unknown,
        _batch: unknown,
        options: { signal: AbortSignal }
      ) =>
        new Promise<void>((resolve) => options.signal.addEventListener('abort', () => resolve())),
      appendJson: async (_stream: string, value: { id: string; frame: string }) => {
        appended.resolve(value);
      },
    } as unknown as LoroStreamsJsonStreamClient;
    let appendedEarly = false;
    void appended.promise.then(() => (appendedEarly = true));
    const dispatcher = createEncryptedDispatchLegacy({
      workspaceId: 'iroh-held-call',
      prepare: async () => original('66'.repeat(16)),
      accept: async () => ({}) as never,
      client: async () => client,
      iroh: {
        ready: async () => true,
        // The host is still waiting for its account lock and never answers.
        call: () => new Promise<string[]>(() => {}),
      },
    });
    try {
      const prepared = await dispatcher.prepare('machine-1', input('held'));
      void prepared.send().catch(() => null);
      await vi.advanceTimersByTimeAsync(799);
      expect(appendedEarly).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await appended.promise).toEqual({ id: '66'.repeat(16), frame: 'ab'.repeat(200) });
    } finally {
      await dispatcher.close();
    }
  } finally {
    vi.useRealTimers();
  }
});

it('does not wait for a slow iroh readiness answer before sending on Streams', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const appended = Promise.withResolvers<{ id: string; frame: string }>();
    const client = {
      ensureJsonStream: async () => undefined,
      readJsonLive: (
        _stream: string,
        _state: unknown,
        _batch: unknown,
        options: { signal: AbortSignal }
      ) =>
        new Promise<void>((resolve) => options.signal.addEventListener('abort', () => resolve())),
      appendJson: async (_stream: string, value: { id: string; frame: string }) => {
        appended.resolve(value);
      },
    } as unknown as LoroStreamsJsonStreamClient;
    let calls = 0;
    const dispatcher = createEncryptedDispatchLegacy({
      workspaceId: 'iroh-slow-ready',
      prepare: async () => original('55'.repeat(16)),
      accept: async () => ({}) as never,
      client: async () => client,
      iroh: {
        // Never answers: a busy host lock or a stalled check.
        ready: () => new Promise<boolean>(() => {}),
        call: async () => {
          calls++;
          return [];
        },
      },
    });
    try {
      const prepared = await dispatcher.prepare('machine-1', input('slow'));
      void prepared.send().catch(() => null);
      await vi.advanceTimersByTimeAsync(100);
      expect(await appended.promise).toEqual({ id: '55'.repeat(16), frame: 'ab'.repeat(200) });
      expect(calls).toBe(0);
    } finally {
      await dispatcher.close();
    }
  } finally {
    vi.useRealTimers();
  }
});
