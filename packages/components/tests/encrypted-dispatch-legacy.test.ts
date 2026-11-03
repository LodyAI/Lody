import { afterEach, expect, it, vi } from 'vitest';
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

it('counts an E2E turn dispatch only when its frame was actually appended', async () => {
  type Report = { effects: { turnStarts: number; pendingDispatches: number } };
  const reports: Report[] = [];
  const waiters: { until: (report: Report) => boolean; resolve: () => void }[] = [];
  vi.stubGlobal('window', {
    __LODY_E2E_CLIENT_LOSS__: true,
    ipc: {
      send: (_channel: string, payload: Report) => {
        reports.push(payload);
        for (const waiter of waiters.splice(0))
          if (waiter.until(payload)) waiter.resolve();
          else waiters.push(waiter);
      },
    },
  });
  const reported = (until: (report: Report) => boolean) =>
    new Promise<void>((resolve) => waiters.push({ until, resolve }));
  const appended: string[] = [];
  let failAppends = false;
  const appendSettled: (() => void)[] = [];
  const client = {
    ensureJsonStream: async () => undefined,
    readJsonLive: (
      _stream: string,
      _state: unknown,
      _batch: unknown,
      options: { signal: AbortSignal }
    ) => new Promise<void>((resolve) => options.signal.addEventListener('abort', () => resolve())),
    appendJson: async (_stream: string, value: { id: string }) => {
      try {
        if (failAppends) throw new Error('token rejected');
        appended.push(value.id);
      } finally {
        appendSettled.shift()?.();
      }
    },
  } as unknown as LoroStreamsJsonStreamClient;
  const dispatcher = createEncryptedDispatchLegacy({
    workspaceId: 'dispatch-workspace',
    prepare: async (_machine, value) =>
      original(value.userTurnId === 'one' ? '11'.repeat(16) : '22'.repeat(16)),
    accept: async () => ({}) as never,
    client: async () => client,
  });
  const appendOnce = () => new Promise<void>((resolve) => appendSettled.push(resolve));
  try {
    const first = await dispatcher.prepare('machine-1', input('one'));
    const counted = reported((report) => report.effects.turnStarts === 1);
    const sending = first.send().catch(() => null);
    await counted;
    expect(appended).toEqual(['11'.repeat(16)]);
    expect(reports.at(-1)?.effects).toMatchObject({ turnStarts: 1, pendingDispatches: 1 });

    failAppends = true;
    const second = await dispatcher.prepare('machine-1', input('two'));
    const settled = appendOnce();
    // The channel turns an append failure into a null receipt; it is never a turn.
    expect(await second.send()).toBeNull();
    await settled;
    expect(reports.at(-1)?.effects.turnStarts).toBe(1);
    await dispatcher.close();
    await sending;
    expect(reports.at(-1)?.effects).toMatchObject({ turnStarts: 1, pendingDispatches: 0 });
  } finally {
    await dispatcher.close();
  }
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
