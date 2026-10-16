import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { createRoostHistoryCache } from '../src/lib/roost-history-cache';
import { createRoostDirectoryRow } from '@lody/shared/session-data';
import type { SessionHistoryInput, SessionHistoryReadResponse } from '@lody/shared';
import { describe, expect, it, vi } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import { createLoroSessionData } from '@lody/shared/session-data';
import type { SessionId, MachineId, WorkspaceId } from '@lody/shared';
import { createConversationSession } from '../src/lib/conversation-view/create-conversation-session';
import {
  createLocalRoostSessionDataFactory,
  createRemoteRoostSessionDataFactory,
  createRoostSessionDataFactoryForMachine,
} from '../src/lib/roost-session-bridge';
import { RoostHistoryError, SessionHistoryRequestError } from '../src/lib/roost-history-error';
import {
  createLoroStreamsJsonStreamClient,
  LoroStreamsMachineRpcClient,
} from '@lody/loro-streams-rpc';
import { initI18n } from '../src/i18n';

describe('createConversationSession backend seam', () => {
  it.each([
    ['accept', 'accept_input'],
    ['acceptAndDispatch', 'accept_input_and_dispatch'],
  ] as const)(
    'keeps a restored owner while following local identity changes for %s and history',
    async (method, operation) => {
      const machineId = 'synthetic-restored-owner' as MachineId;
      const sessionId = 'synthetic-restored-session' as SessionId;
      const entry = {
        id: 'synthetic-restored-input',
        role: 'user' as const,
        userId: 'synthetic-user',
        timestamp: '2026-10-13T00:00:00Z',
        items: [{ type: 'text' as const, text: 'Saved input' }],
        status: 'pending' as const,
      };
      let plane: 'local' | 'cloud' = 'cloud';
      let admitted = false;
      const receipt = () =>
        admitted
          ? { status: 'accepted', turnId: entry.id, active: plane === 'local' }
          : { status: 'unobserved' };
      const factory = createRoostSessionDataFactoryForMachine({
        accountId: 'synthetic-account',
        workspaceId: 'synthetic-workspace' as WorkspaceId,
        machineId,
        resolvePlane: async (owner) => {
          expect(owner).toBe(machineId);
          return plane;
        },
        sendControl: async (request) => {
          expect(request.machineId).toBe(machineId);
          expect(request.sessionId).toBe(sessionId);
          if (request.type === 'session/history-read') {
            return {
              ok: true,
              responses: [
                {
                  type: 'session/history-read_response',
                  sessionId,
                  success: true,
                  result:
                    request.query.kind === 'inputAcceptance' ? receipt() : admitted ? [entry] : [],
                  historyRevision: admitted ? 1 : 0,
                  historyCount: admitted ? 1 : 0,
                },
              ],
            };
          }
          if (request.type !== 'session/history-write')
            throw new Error('Unexpected input transport');
          expect(request.operation).toBe(operation);
          expect(request.payload).toEqual({ entry });
          admitted = true;
          return {
            ok: true,
            responses: [
              {
                type: 'session/history-write_response',
                sessionId,
                operation: request.operation,
                success: true,
                result: receipt(),
                historyRevision: 1,
                historyCount: 1,
                historyChange: null,
              },
            ],
          };
        },
        requestHistoryRead: async (owner, id) => {
          expect(owner).toBe(machineId);
          expect(id).toBe(sessionId);
          if (plane === 'local') throw new Error('Local history must use local control');
          return {
            type: 'session/history-read_response',
            sessionId,
            success: true,
            result: receipt(),
            historyRevision: admitted ? 1 : 0,
            historyCount: admitted ? 1 : 0,
          };
        },
        requestHistoryWrite: async () => {
          throw new Error('An input for the now-local owner must not use cloud RPC');
        },
      });
      const doc = new LoroDoc();
      const session = factory({ doc, sessionId, backendKind: 'roost' });
      try {
        expect(await session.inputAcceptance!.lookup(entry)).toEqual({ status: 'unobserved' });
        plane = 'local';
        const accept = session.inputAcceptance?.[method];
        if (!accept) throw new Error('Expected input acceptance method');
        expect(await accept(entry)).toEqual({
          status: 'accepted',
          turnId: entry.id,
          active: true,
        });
        expect(await session.history.readAll()).toMatchObject([{ id: entry.id }]);
        expect(doc.getList('history').length).toBe(0);
        plane = 'cloud';
        expect(await session.inputAcceptance!.lookup(entry)).toEqual({
          status: 'accepted',
          turnId: entry.id,
          active: false,
        });
        expect(session.inputAcceptance!.targetMachineId).toBe(machineId);
      } finally {
        session.dispose?.();
      }
    }
  );

  it.each([
    ['en', 'append'],
    ['zh_CN', 'append'],
    ['en', 'response'],
    ['zh_CN', 'response'],
  ] as const)(
    'distinguishes a %s %s transport timeout from Roost storage',
    async (locale, phase) => {
      await initI18n(locale);
      vi.useFakeTimers();
      let entered!: () => void;
      const fetching = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const json = createLoroStreamsJsonStreamClient({
        bucketId: 'synthetic-bucket',
        getToken: async () => 'synthetic-token',
        baseUrl: 'https://streams.example.com',
        fetchImpl: async (_url, init) => {
          entered();
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true }
            );
          });
        },
      });
      const destinations: string[] = [];
      const rpc = new LoroStreamsMachineRpcClient({
        workspaceId: 'synthetic-workspace',
        machineId: 'synthetic-wsl',
        streamClient: {
          ensureJsonStream: async () => {},
          appendJson: async (id, value) => {
            destinations.push(id);
            if (phase === 'response') {
              entered();
              return 'synthetic-offset';
            }
            return json.appendJson(id, value);
          },
          readJsonLive: async (_id, _state, _batch, options) =>
            new Promise<void>((resolve) => {
              if (options?.signal?.aborted) resolve();
              else options?.signal?.addEventListener('abort', () => resolve(), { once: true });
            }),
        },
      });
      const factory = createRemoteRoostSessionDataFactory({
        workspaceId: 'synthetic-workspace' as WorkspaceId,
        machineId: 'synthetic-wsl' as MachineId,
        requestHistoryRead: async () => {
          throw new Error('Unexpected synthetic read');
        },
        requestHistoryWrite: async ({ sessionId, operation, payload }) => {
          const response = await rpc.requestSessionHistoryWrite({ sessionId, operation, payload });
          if (!response) throw new Error('Missing synthetic response');
          return response;
        },
      });
      const doc = new LoroDoc();
      const session = factory({
        doc,
        sessionId: 'synthetic-session' as SessionId,
        backendKind: 'roost',
      });
      try {
        const writing = session.commands
          .appendTurn({
            id: 'synthetic-turn',
            role: 'user',
            timestamp: '2026-10-12T00:00:00Z',
            items: [{ type: 'text', text: 'synthetic input' }],
          })
          .catch((error: unknown) => error);
        await fetching;
        await vi.advanceTimersByTimeAsync(phase === 'append' ? 10_000 : 30_000);
        const error = await writing;
        expect(error).toBeInstanceOf(SessionHistoryRequestError);
        expect(error).toMatchObject({
          failure: {
            source: 'transport',
            code: phase === 'append' ? 'request_failed' : 'response_timeout',
            machineId: 'synthetic-wsl',
            requestId: expect.any(String),
          },
        });
        expect(String(error)).toContain(
          locale === 'en' ? 'write may have reached it' : '请求可能已经到达'
        );
        expect(String(error)).not.toContain(locale === 'en' ? 'local logs' : '本地日志');
        expect(destinations).toEqual(['synthetic-workspace:rpc:req:synthetic-wsl']);
        expect(doc.getList('history').length).toBe(0);
      } finally {
        session.dispose?.();
        rpc.stop();
        vi.useRealTimers();
      }
    }
  );

  it.each(['transport', 'metadata', 'protocol', 'owner'] as const)(
    'preserves %s failure provenance through history reads and writes',
    async (scenario) => {
      await initI18n('en');
      const sessionId = 'synthetic-session' as SessionId;
      const failure = {
        source:
          scenario === 'transport'
            ? ('transport' as const)
            : scenario === 'protocol'
              ? ('protocol' as const)
              : ('remote' as const),
        code:
          scenario === 'metadata'
            ? 'session_metadata_pending'
            : scenario === 'owner'
              ? 'session_owner_mismatch'
              : 'request_failed',
        requestId: 'synthetic-request',
        machineId: 'synthetic-wsl',
      };
      const factory = createRemoteRoostSessionDataFactory({
        workspaceId: 'synthetic-workspace' as WorkspaceId,
        machineId: 'synthetic-wsl' as MachineId,
        requestHistoryRead: async () => ({
          type: 'session/history-read_response',
          sessionId,
          success: false,
          error: 'synthetic failure',
          rpcFailure: failure,
        }),
        requestHistoryWrite: async ({ operation }) => ({
          type: 'session/history-write_response',
          sessionId,
          operation,
          success: false,
          error: 'synthetic failure',
          rpcFailure: failure,
        }),
      });
      const doc = new LoroDoc();
      const session = factory({ doc, sessionId, backendKind: 'roost' });
      try {
        const read = await session.history.count().catch((error: unknown) => error);
        const write = await session.commands
          .appendTurn({ id: 'first', role: 'user', timestamp: 'synthetic', items: [] })
          .catch((error: unknown) => error);
        for (const error of [read, write]) {
          expect(error).toBeInstanceOf(SessionHistoryRequestError);
          expect(error).toMatchObject({ failure });
          expect(String(error)).toContain('request=synthetic-request; machine=synthetic-wsl');
          expect(String(error)).not.toContain('local logs');
        }
        if (scenario === 'metadata') expect(String(write)).toContain('operation did not start');
        expect(doc.getList('history').length).toBe(0);
      } finally {
        session.dispose?.();
      }
    }
  );

  it.each(['en', 'zh_CN'] as const)(
    'surfaces an owner diagnostic in %s through local and remote Roost bridges',
    async (locale) => {
      await initI18n(locale);
      const sessionId = `diagnostic-${locale}` as SessionId;
      const machineId = 'synthetic-machine' as MachineId;
      const workspaceId = 'synthetic-workspace' as WorkspaceId;
      const detail =
        'Roost history initialize failed (code=workerFailed; diagnostic=65b4a1d8-6f6a-4ea0-87e8-2dbd563d25f6)';
      const factories = [
        createLocalRoostSessionDataFactory({
          machineId,
          workspaceId,
          sendControl: async (request) => {
            if (request.type === 'session/history-write')
              return {
                ok: true,
                responses: [
                  {
                    type: 'session/history-write_response',
                    sessionId,
                    operation: request.operation,
                    success: false,
                    error: detail,
                  },
                ],
              };
            if (request.type === 'session/history-read')
              return {
                ok: true,
                responses: [
                  {
                    type: 'session/history-read_response',
                    sessionId,
                    success: false,
                    error: detail,
                  },
                ],
              };
            throw new Error('Unexpected synthetic request');
          },
        }),
        createRemoteRoostSessionDataFactory({
          machineId,
          workspaceId,
          requestHistoryRead: async () => ({
            type: 'session/history-read_response',
            sessionId,
            success: false,
            error: detail,
          }),
          requestHistoryWrite: async ({ operation }) => ({
            type: 'session/history-write_response',
            sessionId,
            operation,
            success: false,
            error: detail,
          }),
        }),
      ];
      for (const factory of factories) {
        const doc = new LoroDoc();
        const session = factory({ doc, sessionId, backendKind: 'roost' });
        try {
          const writeError = await session.commands
            .appendTurn({
              id: 'synthetic-turn',
              role: 'user',
              timestamp: '2026-10-10T00:00:00.000Z',
              items: [{ type: 'text', text: 'synthetic draft' }],
            })
            .catch((error: unknown) => error);
          expect(writeError).toBeInstanceOf(RoostHistoryError);
          expect(writeError).toMatchObject({ backend: 'roost' });
          expect(String(writeError)).toContain(detail);
          expect(String(writeError)).toContain(locale === 'en' ? 'could not confirm' : '未能确认');
          await expect(session.history.count()).rejects.toBeInstanceOf(RoostHistoryError);
          expect(doc.getList('history').length).toBe(0);
        } finally {
          session.dispose?.();
        }
      }
    }
  );

  it('uses the injected SessionData factory and forwards the backend kind', async () => {
    const doc = new LoroDoc();
    const injectedDoc = new LoroDoc();
    const createSessionData = vi.fn(({ sessionId }) =>
      createLoroSessionData({ sessionId, doc: injectedDoc })
    );

    const session = createConversationSession(doc, {
      sessionId: 'session-1' as never,
      backendKind: 'roost',
      createSessionData,
      scheduleIdle: () => () => {},
    });

    expect(createSessionData).toHaveBeenCalledWith({
      sessionId: 'session-1',
      doc,
      backendKind: 'roost',
      writer: undefined,
    });
    expect(session.sessionData.sessionId).toBe('session-1');
    await session.sessionData.commands.appendTurn({
      id: 'injected-user',
      role: 'user',
      timestamp: '2026-10-10T00:00:00.000Z',
      items: [{ type: 'text', text: 'injected storage' }],
    });
    expect(await session.sessionData.history.readAll()).toMatchObject([{ id: 'injected-user' }]);
    expect(doc.getList('history').length).toBe(0);
    session.dispose();
  });

  it('fails closed when Roost metadata has no renderer factory', () => {
    expect(() =>
      createConversationSession(new LoroDoc(), {
        sessionId: 'session-1' as never,
        backendKind: 'roost',
        scheduleIdle: () => () => {},
      })
    ).toThrow(/requires a renderer SessionData factory/);
  });

  it('keeps the default Loro composition when no factory is supplied', () => {
    const session = createConversationSession(new LoroDoc(), {
      sessionId: 'session-1' as never,
      scheduleIdle: () => () => {},
    });

    expect(session.sessionData.sessionId).toBe('session-1');
    session.dispose();
  });
});

it.each([
  [120, false, false],
  [6000, false, false],
  [120, true, false],
  [6000, true, false],
  [6000, false, true],
  [6000, true, true],
] as const)(
  'patches missed changes in a %i-row durable replica without reading unchanged pages (inline=%s, tailOnly=%s)',
  async (count, inline, tailOnly) => {
    const first = tailOnly ? count - 40 : 0;
    Object.assign(globalThis, { indexedDB: new IDBFactory(), IDBKeyRange });
    const sessionId = 'synthetic-catchup' as SessionId;
    const workspaceId = 'synthetic-workspace' as WorkspaceId;
    const machineId = 'synthetic-machine' as MachineId;
    const entries: SessionHistoryInput[] = Array.from({ length: count }, (_, i) => ({
      id: `synthetic-${i}`,
      role: i % 2 ? 'assistant' : 'user',
      timestamp: '2026-10-16T00:00:00Z',
      items: [{ type: 'text', text: 'x'.repeat(4096) }],
    }));
    const cache = createRoostHistoryCache(
      JSON.stringify(['local', workspaceId, machineId, sessionId])
    );
    await cache.acceptPage(
      {
        checkpoint: 'synthetic-checkpoint-1',
        startPosition: first,
        totalCount: count,
        rows: entries
          .slice(first)
          .map((entry, offset) => createRoostDirectoryRow(first + offset, entry as never)),
        hasMoreOlder: first > 0,
        cursor: first > 0 ? 'synthetic-unloaded-prefix' : null,
      },
      entries.slice(first),
      1
    );
    const doc = new LoroDoc();
    const cursor = doc.getMap('roostHistoryCursor');
    const publish = (revision: number) => {
      cursor.set('historyRevision', revision);
      cursor.set('historyCount', entries.length);
      cursor.set(
        'historyChangeJson',
        JSON.stringify({ kind: 'changed', ids: [entries.at(-1)!.id] })
      );
      doc.commit();
    };
    publish(1);
    let revision = 1;
    const reads: { kind: string; rows: number }[] = [];
    const events: { kind: string }[] = [];
    const completions = new Map<number, () => void>();
    const complete = (value: number) =>
      new Promise<void>((resolve) => completions.set(value, resolve));
    const unexpectedPageRead = Promise.withResolvers<void>();
    const factory = createLocalRoostSessionDataFactory({
      incremental: true,
      workspaceId,
      machineId,
      sendControl: async (request) => {
        if (request.type !== 'session/history-read') throw new Error('Unexpected write');
        const query = request.query;
        let result: unknown;
        let bodies = 0;
        if (query.kind === 'readChanges') {
          const ids =
            revision === 1 ? [] : revision === 3 ? [entries[count - 1]!.id] : [entries[first]!.id];
          const changed = ids.map((id) =>
            structuredClone(entries.find((entry) => entry.id === id)!)
          );
          const suffix = revision === 5 ? structuredClone(entries.slice(count)) : [];
          if (inline) bodies = changed.length + suffix.length;
          result = {
            state: 'ready',
            checkpoint: `synthetic-checkpoint-${revision}`,
            ids,
            ...(revision === 5 ? { from: count } : {}),
            ...(inline
              ? { bodies: { changed, suffix, ...(revision === 5 ? { from: count } : {}) } }
              : {}),
          };
        } else if (query.kind === 'readTurn') {
          result = {
            state: 'ready',
            turn: structuredClone(entries.find((entry) => entry.id === query.turnId)),
          };
          bodies = 1;
        } else if (query.kind === 'readRange') {
          result = entries
            .slice(query.from, query.to)
            .map((turn) => ({ state: 'ready', turn: structuredClone(turn) }));
          bodies = query.to - query.from;
        } else {
          reads.push({ kind: query.kind, rows: 40 });
          // A correct checkpoint repair never needs this body-read boundary.
          // Parking it proves that the next change can still advance the cache.
          await unexpectedPageRead.promise;
          throw new Error(`Unexpected full page read: ${query.kind}`);
        }
        reads.push({ kind: query.kind, rows: bodies });
        const response: SessionHistoryReadResponse = {
          type: 'session/history-read_response',
          sessionId,
          success: true,
          result,
          historyRevision: revision,
          historyCount: entries.length,
          historyChange: { kind: 'changed', ids: [entries.at(-1)!.id] },
        };
        return { ok: true, responses: [response] };
      },
    });
    const data = factory({ sessionId, doc, backendKind: 'roost' });
    const observation = data.history.observe((event) => {
      events.push(event);
      void cache.getHead().then((head) => {
        if (head?.start === first) completions.get(head.revision)?.();
      });
    });
    try {
      await observation.initial;
      events.length = 0;
      entries[count - 1]!.items = [{ type: 'text', text: 'updated tail' }];
      const caughtUp = complete(3);
      revision = 3;
      publish(3);
      await caughtUp;
      expect(
        new Set(reads.filter((read) => read.rows > 0).map((read) => JSON.stringify(read)))
      ).toEqual(
        new Set(
          [{ kind: inline ? 'readChanges' : 'readTurn', rows: 1 }].map((read) =>
            JSON.stringify(read)
          )
        )
      );
      expect(events.every((event) => event.kind === 'changed')).toBe(true);
      expect(await cache.getHead()).toMatchObject({
        revision: 3,
        start: first,
        count,
        checkpoint: 'synthetic-checkpoint-3',
      });
      expect(await data.history.readTurn(entries[count - 1]!.id)).toMatchObject({
        state: 'ready',
        turn: { items: [{ type: 'text', text: 'updated tail' }] },
      });
      expect(
        await data.history.readOlderDirectoryPage!(`roost-cache:1:${tailOnly ? count : 40}`, 40)
      ).toMatchObject({
        startPosition: first,
        totalCount: count,
      });
      reads.length = 0;
      entries[first]!.status = 'seen';
      entries.push({
        id: 'synthetic-new-input',
        role: 'user',
        timestamp: '2026-10-16T00:00:01Z',
        items: [{ type: 'text', text: 'new input' }],
      });
      const appended = complete(5);
      revision = 5;
      publish(5);
      await appended;
      expect(
        new Set(reads.filter((read) => read.rows > 0).map((read) => JSON.stringify(read)))
      ).toEqual(
        new Set(
          (inline
            ? [{ kind: 'readChanges', rows: 2 }]
            : [
                { kind: 'readTurn', rows: 1 },
                { kind: 'readRange', rows: 1 },
              ]
          ).map((read) => JSON.stringify(read))
        )
      );
      expect(await cache.getHead()).toMatchObject({
        revision: 5,
        start: first,
        count: count + 1,
        checkpoint: 'synthetic-checkpoint-5',
      });
      const offline = createLocalRoostSessionDataFactory({
        incremental: true,
        workspaceId,
        machineId,
        sendControl: async () => {
          throw new Error('Synthetic offline owner');
        },
      })({ sessionId, doc, backendKind: 'roost' });
      try {
        expect(await offline.history.readTurn(entries[first]!.id)).toMatchObject({
          state: 'ready',
          turn: { status: 'seen' },
        });
        expect(await offline.history.readAt(count)).toMatchObject({
          state: 'ready',
          turn: { id: 'synthetic-new-input' },
        });
        expect(await offline.history.readTurn(entries[count - 1]!.id)).toMatchObject({
          state: 'ready',
          turn: { items: [{ type: 'text', text: 'updated tail' }] },
        });
      } finally {
        offline.dispose?.();
      }
    } finally {
      observation.unsubscribe();
      data.dispose?.();
      cache.dispose();
      unexpectedPageRead.resolve();
    }
  },
  30000
);

it('retries a superseded incremental observation immediately and publishes only a coherent replacement', async () => {
  Object.assign(globalThis, { indexedDB: new IDBFactory(), IDBKeyRange });
  const sessionId = 'synthetic-supersession' as SessionId;
  const workspaceId = 'synthetic-workspace' as WorkspaceId;
  const machineId = 'synthetic-machine' as MachineId;
  const entries: SessionHistoryInput[] = ['early', 'tail'].map((id) => ({
    id,
    role: 'user',
    timestamp: '2026-10-16T00:00:00Z',
    items: [{ type: 'text', text: 'old' }],
  }));
  const cache = createRoostHistoryCache(
    JSON.stringify(['local', workspaceId, machineId, sessionId])
  );
  await cache.acceptPage(
    {
      checkpoint: 'checkpoint-1',
      startPosition: 0,
      totalCount: 2,
      rows: entries.map((entry, position) => createRoostDirectoryRow(position, entry as never)),
      hasMoreOlder: false,
      cursor: null,
    },
    entries,
    1
  );
  let revision = 3;
  const timers: { callback: () => void; delay: number }[] = [];
  const waiters: ((timer: { callback: () => void; delay: number }) => void)[] = [];
  const nextTimer = () =>
    timers.length
      ? Promise.resolve(timers.shift()!)
      : new Promise<{ callback: () => void; delay: number }>((resolve) => waiters.push(resolve));
  const setTimer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    callback: () => void,
    delay = 0
  ) => {
    const timer = { callback, delay };
    const waiter = waiters.shift();
    if (waiter) waiter(timer);
    else timers.push(timer);
    return timer as never;
  }) as typeof setTimeout);
  const clearTimer = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {});
  let ready!: () => void;
  const complete = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const factory = createLocalRoostSessionDataFactory({
    incremental: true,
    workspaceId,
    machineId,
    sendControl: async (request) => {
      if (request.type !== 'session/history-read') throw new Error('Unexpected write');
      const query = request.query;
      let result: unknown;
      if (query.kind === 'readChanges')
        result = {
          state: 'ready',
          checkpoint: `checkpoint-${revision}`,
          ids: entries.map((entry) => entry.id),
        };
      else if (query.kind === 'readTurn') {
        revision = 5;
        result = {
          state: 'ready',
          turn: {
            ...entries.find((entry) => entry.id === query.turnId),
            items: [{ type: 'text', text: `current ${query.turnId}` }],
          },
        };
      } else throw new Error('Full history must not be read');
      return {
        ok: true,
        responses: [
          {
            type: 'session/history-read_response',
            sessionId,
            success: true,
            result,
            historyRevision: revision,
            historyCount: 2,
            historyChange: { kind: 'changed', ids: ['tail'] },
          },
        ],
      };
    },
  });
  const data = factory({ sessionId, doc: new LoroDoc(), backendKind: 'roost' });
  const observation = data.history.observe(() => {
    void cache.getHead().then((head) => {
      if (head?.revision === 5) ready();
    });
  });
  try {
    await observation.initial;
    const initial = await nextTimer();
    expect(initial.delay).toBe(0);
    initial.callback();
    const retry = await nextTimer();
    expect(retry.delay).toBe(0);
    expect(await cache.getHead()).toMatchObject({ revision: 1, checkpoint: 'checkpoint-1' });
    expect((await cache.readRows(0, 2))?.map((row) => row.turn.items)).toEqual(
      entries.map((entry) => entry.items)
    );
    retry.callback();
    await complete;
    expect(await cache.getHead()).toMatchObject({ revision: 5, checkpoint: 'checkpoint-5' });
    expect((await cache.readRows(0, 2))?.map((row) => row.turn.items)).toEqual(
      ['early', 'tail'].map((id) => [{ type: 'text', text: `current ${id}` }])
    );
  } finally {
    observation.unsubscribe();
    data.dispose?.();
    cache.dispose();
    setTimer.mockRestore();
    clearTimer.mockRestore();
  }
});

it('keeps cold-open supersession out of the UI failure path', async () => {
  Object.assign(globalThis, { indexedDB: new IDBFactory(), IDBKeyRange });
  const sessionId = 'synthetic-cold-open' as SessionId;
  let superseded = true;
  const data = createLocalRoostSessionDataFactory({
    incremental: true,
    workspaceId: 'synthetic-workspace' as WorkspaceId,
    machineId: 'synthetic-machine' as MachineId,
    sendControl: async (request) => {
      if (request.type !== 'session/history-read') throw new Error('Unexpected write');
      if (superseded) {
        superseded = false;
        return {
          ok: true,
          responses: [
            {
              type: 'session/history-read_response',
              sessionId,
              success: false,
              retryReason: 'superseded',
              error: 'Synthetic normal supersession',
            },
          ],
        };
      }
      const result =
        request.query.kind === 'readChanges'
          ? { state: 'ready', checkpoint: 'synthetic-zero', ids: [] }
          : {
              checkpoint: 'synthetic-zero',
              startPosition: 0,
              totalCount: 0,
              rows: [],
              hasMoreOlder: false,
              cursor: null,
            };
      return {
        ok: true,
        responses: [
          {
            type: 'session/history-read_response',
            sessionId,
            success: true,
            result,
            pageTurns: [],
            historyRevision: 0,
            historyCount: 0,
            historyChange: null,
          },
        ],
      };
    },
  })({ sessionId, doc: new LoroDoc(), backendKind: 'roost' });
  const observation = data.history.observe(() => {});
  try {
    expect(await observation.initial).toEqual([]);
    expect(await data.history.readAll()).toEqual([]);
  } finally {
    observation.unsubscribe();
    data.dispose?.();
  }
});

it.each([1, 2, 3])(
  'retains the old coherent replica until an unknown checkpoint replacement at revision %i is complete',
  async (revision) => {
    Object.assign(globalThis, { indexedDB: new IDBFactory(), IDBKeyRange });
    const sessionId = 'synthetic-reset' as SessionId;
    const workspaceId = 'synthetic-workspace' as WorkspaceId;
    const machineId = 'synthetic-machine' as MachineId;
    const entries: SessionHistoryInput[] = Array.from({ length: 120 }, (_, position) => ({
      id: `reset-${position}`,
      role: 'user',
      timestamp: '2026-10-16T00:00:00Z',
      items: [{ type: 'text', text: 'old' }],
    }));
    const cache = createRoostHistoryCache(
      JSON.stringify(['local', workspaceId, machineId, sessionId])
    );
    await cache.acceptPage(
      {
        checkpoint: 'unknown-checkpoint',
        startPosition: 0,
        totalCount: 120,
        rows: entries.map((entry, position) => createRoostDirectoryRow(position, entry as never)),
        hasMoreOlder: false,
        cursor: null,
      },
      entries,
      1
    );
    entries[0]!.items = [{ type: 'text', text: 'new early' }];
    entries[119]!.items = [{ type: 'text', text: 'new tail' }];
    let olderStarted!: () => void;
    const older = new Promise<void>((resolve) => {
      olderStarted = resolve;
    });
    let releaseOlder!: () => void;
    const holdOlder = new Promise<void>((resolve) => {
      releaseOlder = resolve;
    });
    const unverifiedDelta = Promise.withResolvers<void>();
    let ready!: () => void;
    const replaced = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const data = createLocalRoostSessionDataFactory({
      incremental: true,
      workspaceId,
      machineId,
      sendControl: async (request) => {
        if (request.type !== 'session/history-read') throw new Error('Unexpected write');
        const query = request.query;
        if (query.kind === 'readChanges')
          return {
            ok: true,
            responses: [
              {
                type: 'session/history-read_response',
                sessionId,
                success: true,
                result: { state: 'reset', checkpoint: `reset-${revision}` },
                historyRevision: revision,
                historyCount: 120,
                historyChange: { kind: 'changed', ids: ['reset-119'] },
              },
            ],
          };
        if (query.kind === 'readTurn') {
          unverifiedDelta.resolve();
          return {
            ok: true,
            responses: [
              {
                type: 'session/history-read_response',
                sessionId,
                success: true,
                result: {
                  state: 'ready',
                  turn: entries.find((entry) => entry.id === query.turnId),
                },
                historyRevision: revision,
                historyCount: 120,
                historyChange: { kind: 'changed', ids: ['reset-119'] },
              },
            ],
          };
        }
        if (query.kind !== 'readLatestPage' && query.kind !== 'readOlderPage')
          throw new Error('Unexpected full read');
        if (query.kind === 'readOlderPage' && query.cursor === '80') {
          olderStarted();
          await holdOlder;
        }
        const end = query.kind === 'readLatestPage' ? 120 : Number(query.cursor);
        const start = Math.max(0, end - query.limit);
        const turns = entries.slice(start, end);
        return {
          ok: true,
          responses: [
            {
              type: 'session/history-read_response',
              sessionId,
              success: true,
              result: {
                checkpoint: `reset-${revision}`,
                startPosition: start,
                totalCount: 120,
                rows: turns.map((turn, offset) =>
                  createRoostDirectoryRow(start + offset, turn as never)
                ),
                hasMoreOlder: start > 0,
                cursor: start > 0 ? String(start) : null,
              },
              pageTurns: turns,
              historyRevision: revision,
              historyCount: 120,
              historyChange: { kind: 'changed', ids: ['reset-119'] },
            },
          ],
        };
      },
    })({ sessionId, doc: new LoroDoc(), backendKind: 'roost' });
    const observation = data.history.observe(() => {
      void cache.getHead().then((head) => {
        if (
          head?.revision === revision &&
          head.checkpoint === `reset-${revision}` &&
          head.start === 0
        )
          ready();
      });
    });
    try {
      await observation.initial;
      expect(
        await Promise.race([
          older.then(() => 'replacement'),
          unverifiedDelta.promise.then(() => 'hint-delta'),
        ])
      ).toBe('replacement');
      expect(await cache.getHead()).toMatchObject({
        revision: 1,
        checkpoint: 'unknown-checkpoint',
        start: 0,
      });
      expect((await cache.readRows(0, 1))?.[0]?.turn.items).toEqual([
        { type: 'text', text: 'old' },
      ]);
      releaseOlder();
      await replaced;
      expect(await cache.getHead()).toMatchObject({
        revision,
        checkpoint: `reset-${revision}`,
        start: 0,
      });
      expect((await cache.readRows(0, 1))?.[0]?.turn.items).toEqual([
        { type: 'text', text: 'new early' },
      ]);
      expect((await cache.readRows(119, 120))?.[0]?.turn.items).toEqual([
        { type: 'text', text: 'new tail' },
      ]);
    } finally {
      releaseOlder();
      observation.unsubscribe();
      data.dispose?.();
      cache.dispose();
    }
  }
);

it('advances coherent streaming replies even while newer control revisions keep arriving', async () => {
  Object.assign(globalThis, { indexedDB: new IDBFactory(), IDBKeyRange });
  const sessionId = 'synthetic-continuous-stream' as SessionId;
  const workspaceId = 'synthetic-workspace' as WorkspaceId;
  const machineId = 'synthetic-machine' as MachineId;
  const entry: SessionHistoryInput = {
    id: 'stream-tail',
    role: 'assistant',
    timestamp: 'synthetic',
    items: [{ type: 'text', text: 'initial' }],
  };
  const cache = createRoostHistoryCache(
    JSON.stringify(['local', workspaceId, machineId, sessionId])
  );
  await cache.acceptPage(
    {
      checkpoint: 'checkpoint-1',
      startPosition: 0,
      totalCount: 1,
      rows: [createRoostDirectoryRow(0, entry as never)],
      hasMoreOlder: false,
      cursor: null,
    },
    [entry],
    1
  );
  const doc = new LoroDoc();
  let revision = 3;
  const timers: { callback: () => void; delay: number }[] = [];
  const timerWaiters: ((timer: { callback: () => void; delay: number }) => void)[] = [];
  const nextTimer = () =>
    timers.length
      ? Promise.resolve(timers.shift()!)
      : new Promise<{ callback: () => void; delay: number }>((resolve) =>
          timerWaiters.push(resolve)
        );
  const setTimer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    callback: () => void,
    delay = 0
  ) => {
    const timer = { callback, delay };
    const waiter = timerWaiters.shift();
    if (waiter) waiter(timer);
    else timers.push(timer);
    return timer as never;
  }) as typeof setTimeout);
  const clearTimer = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {});
  const completions = new Map<number, () => void>();
  const data = createLocalRoostSessionDataFactory({
    incremental: true,
    workspaceId,
    machineId,
    sendControl: async (request) => {
      if (request.type !== 'session/history-read' || request.query.kind !== 'readChanges')
        throw new Error('Streaming must advance within one observation reply');
      const atRevision = revision;
      expect(request.query.checkpoint).toBe(`checkpoint-${atRevision - 2}`);
      expect(request.query.includeBodiesFrom).toBe(0);
      revision += 2;
      const cursor = doc.getMap('roostHistoryCursor');
      cursor.set('historyRevision', revision);
      cursor.set('historyCount', 1);
      cursor.set('historyChangeJson', JSON.stringify({ kind: 'changed', ids: [entry.id] }));
      doc.commit();
      return {
        ok: true,
        responses: [
          {
            type: 'session/history-read_response',
            sessionId,
            success: true,
            historyRevision: atRevision,
            historyCount: 1,
            historyChange: { kind: 'changed', ids: [entry.id] },
            result: {
              state: 'ready',
              checkpoint: `checkpoint-${atRevision}`,
              ids: [entry.id],
              bodies: {
                changed: [{ ...entry, items: [{ type: 'text', text: `chunk-${atRevision}` }] }],
                suffix: [],
              },
            },
          },
        ],
      };
    },
  })({ sessionId, doc, backendKind: 'roost' });
  const observation = data.history.observe(() => {
    void cache.getHead().then((head) => {
      if (head) completions.get(head.revision)?.();
    });
  });
  try {
    await observation.initial;
    for (const expected of [3, 5, 7, 9]) {
      const completed = new Promise<void>((resolve) => completions.set(expected, resolve));
      const timer = await nextTimer();
      expect(timer.delay).toBe(0);
      timer.callback();
      await completed;
      expect(await cache.getHead()).toMatchObject({
        revision: expected,
        checkpoint: `checkpoint-${expected}`,
      });
      expect(doc.getMap('roostHistoryCursor').get('historyRevision')).toBe(expected + 2);
      expect(await data.history.readTurn(entry.id)).toMatchObject({
        state: 'ready',
        turn: { items: [{ type: 'text', text: `chunk-${expected}` }] },
      });
      expect(await data.history.count()).toBe(1);
    }
  } finally {
    observation.unsubscribe();
    data.dispose?.();
    cache.dispose();
    setTimer.mockRestore();
    clearTimer.mockRestore();
  }
});

it('adopts late owner capabilities and watches a quiet control document from the cached checkpoint', async () => {
  Object.assign(globalThis, { indexedDB: new IDBFactory(), IDBKeyRange });
  const sessionId = 'synthetic-quiet-peer' as SessionId;
  const workspaceId = 'synthetic-workspace' as WorkspaceId;
  const machineId = 'synthetic-machine' as MachineId;
  const entry: SessionHistoryInput = {
    id: 'quiet-tail',
    role: 'assistant',
    timestamp: 'synthetic',
    items: [{ type: 'text', text: 'before' }],
  };
  const cache = createRoostHistoryCache(
    JSON.stringify(['local', workspaceId, machineId, sessionId])
  );
  const page = {
    startPosition: 0,
    totalCount: 1,
    rows: [createRoostDirectoryRow(0, entry as never)],
    hasMoreOlder: false,
    cursor: null,
  };
  await cache.acceptPage({ ...page, checkpoint: 'checkpoint-1' }, [entry], 1);
  const timers: (() => void)[] = [];
  const timerWaiters: ((callback: () => void) => void)[] = [];
  const nextTimer = () =>
    timers.length
      ? Promise.resolve(timers.shift()!)
      : new Promise<() => void>((resolve) => timerWaiters.push(resolve));
  const setTimer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    callback: () => void
  ) => {
    const waiter = timerWaiters.shift();
    if (waiter) waiter(callback);
    else timers.push(callback);
    return callback as never;
  }) as typeof setTimeout);
  const clearTimer = vi.spyOn(globalThis, 'clearTimeout').mockImplementation((handle) => {
    const i = timers.indexOf(handle as never);
    if (i >= 0) timers.splice(i, 1);
  });
  let supports = false;
  let wake: (() => void) | undefined;
  const legacyVisited = Promise.withResolvers<void>();
  const watching = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<void>();
  const visible = Promise.withResolvers<void>();
  const doc = new LoroDoc();
  const data = createLocalRoostSessionDataFactory({
    workspaceId,
    machineId,
    incremental: () => supports,
    watch: () => supports,
    subscribeWake: (listener) => {
      wake = listener;
      return () => {
        wake = undefined;
      };
    },
    sendControl: async (request) => {
      if (request.type !== 'session/history-read') throw new Error('Unexpected write');
      const query = request.query;
      if (query.kind === 'readLatestPage') {
        if (!query.withCheckpoint) legacyVisited.resolve();
        return {
          ok: true,
          responses: [
            {
              type: 'session/history-read_response',
              sessionId,
              success: true,
              historyRevision: 1,
              historyCount: 1,
              result: { ...page, ...(query.withCheckpoint ? { checkpoint: 'checkpoint-1' } : {}) },
              pageTurns: [entry],
            },
          ],
        };
      }
      if (query.kind !== 'watchChanges') throw new Error('Expected independent owner observation');
      expect(query).toMatchObject({
        checkpoint: 'checkpoint-1',
        includeBodiesFrom: 0,
        waitMs: 15_000,
      });
      watching.resolve();
      await reply.promise;
      return {
        ok: true,
        responses: [
          {
            type: 'session/history-read_response',
            sessionId,
            success: true,
            historyRevision: 3,
            historyCount: 1,
            historyChange: { kind: 'changed', ids: [entry.id] },
            result: {
              state: 'ready',
              checkpoint: 'checkpoint-3',
              ids: [entry.id],
              bodies: {
                changed: [
                  { ...entry, items: [{ type: 'text', text: 'after missed owner changes' }] },
                ],
                suffix: [],
              },
            },
          },
        ],
      };
    },
  })({ sessionId, doc, backendKind: 'roost' });
  const observation = data.history.observe(() => {
    void cache.getHead().then((head) => {
      if (head?.revision === 3) visible.resolve();
    });
  });
  try {
    await observation.initial;
    (await nextTimer())(); // Legacy owner observation before its capability row arrives.
    await legacyVisited.promise;
    supports = true;
    wake?.();
    for (let i = 0; i < 3; i++) {
      const next = await Promise.race([nextTimer(), watching.promise.then(() => null)]);
      if (!next) break;
      next();
    }
    await watching.promise;
    reply.resolve();
    await visible.promise;
    expect(await data.history.readTurn(entry.id)).toMatchObject({
      state: 'ready',
      turn: { items: [{ type: 'text', text: 'after missed owner changes' }] },
    });
    expect(await cache.getHead()).toMatchObject({ revision: 3, checkpoint: 'checkpoint-3' });
    expect(doc.toJSON().roostHistoryCursor).toEqual({});
  } finally {
    observation.unsubscribe();
    data.dispose?.();
    cache.dispose();
    reply.resolve();
    setTimer.mockRestore();
    clearTimer.mockRestore();
  }
});

it('rolls back incomplete cache repairs and removes a truncated suffix with its checkpoint', async () => {
  Object.assign(globalThis, { indexedDB: new IDBFactory(), IDBKeyRange });
  const entries: SessionHistoryInput[] = ['first', 'second', 'third'].map((id) => ({
    id,
    role: 'user',
    timestamp: '2026-10-16T00:00:00Z',
    items: [{ type: 'text', text: id }],
  }));
  const cache = createRoostHistoryCache('synthetic-atomic-cache');
  try {
    await cache.acceptPage(
      {
        checkpoint: 'checkpoint-1',
        startPosition: 0,
        totalCount: 3,
        rows: entries.map((entry, position) => createRoostDirectoryRow(position, entry as never)),
        hasMoreOlder: false,
        cursor: null,
      },
      entries,
      1
    );
    const original = await cache.getHead();
    if (!original) throw new Error('Missing head');
    await expect(
      cache.applyChanges(original, 3, 4, 'checkpoint-3', 2, [{ position: 3, turn: entries[0]! }])
    ).rejects.toThrow();
    expect(await cache.getHead()).toEqual(original);
    expect((await cache.readRows(0, 3))?.map((row) => row.turn.id)).toEqual([
      'first',
      'second',
      'third',
    ]);
    expect(await cache.applyChanges(original, 5, 1, 'checkpoint-5', 1, [])).toBe(true);
    expect(await cache.getHead()).toMatchObject({
      revision: 5,
      count: 1,
      checkpoint: 'checkpoint-5',
    });
    expect((await cache.readRows(0, 1))?.[0]?.turn.id).toBe('first');
    expect(await cache.readAffected(['second', 'third'])).toEqual([]);
    expect(await cache.applyChanges(original, 6, 1, 'stale-checkpoint', undefined, [])).toBe(false);
    expect(await cache.getHead()).toMatchObject({
      revision: 5,
      count: 1,
      checkpoint: 'checkpoint-5',
    });
  } finally {
    cache.dispose();
  }
});
