import { afterEach, describe, expect, it, vi } from 'vitest';
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
  const ack = {
    type: 'session/dispatch-turn_response' as const,
    sessionId: 'session-1',
    userTurnId: 'one',
    accepted: true,
    disposition: 'accepted' as const,
  };
  const setup = (options: {
    ready: boolean;
    call?: () => Promise<string[]>;
    frames?: string[];
  }) => {
    const appended = Promise.withResolvers<{ id: string; frame: string }>();
    const appendedFrames: { id: string; frame: string }[] = [];
    const calls: { machineId: string; envelope: { id: string; frame: string } }[] = [];
    const accepted: string[] = [];
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
        appendedFrames.push(value);
        appended.resolve(value);
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
      client: async () => client,
      iroh: {
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
    const t = setup({ ready: true });
    try {
      const prepared = await t.dispatcher.prepare('machine-1', input('one'));
      expect(await prepared.send()).toEqual(ack);
      expect(t.calls).toEqual([
        { machineId: 'machine-1', envelope: { id: '44'.repeat(16), frame: 'ab'.repeat(200) } },
      ]);
      // An unverifiable reply is skipped; only the verified ACK is returned.
      expect(t.accepted).toEqual(['00'.repeat(150), 'ef'.repeat(150)]);
      expect(t.appendedFrames).toEqual([]);
    } finally {
      await t.dispatcher.close();
    }
  });

  it.each([
    { name: 'no live connection', ready: false, call: undefined },
    {
      name: 'a failed iroh call',
      ready: true,
      call: () => Promise.reject(new Error('iroh_call')),
    },
    { name: 'no verifiable reply', ready: true, call: async () => [] },
  ])('falls back to Streams with the same original after $name', async ({ ready, call }) => {
    const t = setup({ ready, ...(call ? { call } : {}) });
    try {
      const prepared = await t.dispatcher.prepare('machine-1', input('one'));
      void prepared.send().catch(() => null);
      expect(await t.appended.promise).toEqual({ id: '44'.repeat(16), frame: 'ab'.repeat(200) });
      expect(t.calls.length).toBe(ready ? 1 : 0);
    } finally {
      await t.dispatcher.close();
    }
  });

  it('keeps chunked originals on Streams', async () => {
    const frames = ['ab'.repeat(200), 'cd'.repeat(200)];
    const t = setup({ ready: true, frames });
    try {
      const prepared = await t.dispatcher.prepare('machine-1', input('one'));
      void prepared.send().catch(() => null);
      expect(await t.appended.promise).toEqual({ id: '44'.repeat(16), frame: frames[0] });
      expect(t.calls).toEqual([]);
    } finally {
      await t.dispatcher.close();
    }
  });
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
