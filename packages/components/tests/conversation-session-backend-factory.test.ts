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
  it('keeps a restored owner while following local identity changes for input and history', async () => {
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
        if (request.type !== 'session/history-write') throw new Error('Unexpected input transport');
        expect(request.operation).toBe('accept_input');
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
      expect(await session.inputAcceptance!.accept(entry)).toEqual({
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
  });

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
