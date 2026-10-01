import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  DEFAULT_PREVIEW_IDLE_TIMEOUT_MS,
  LocalMachineRpcRequestSchema,
  type IosSimulatorRequest,
  type IosSimulatorDevice,
} from '@lody/shared';
import { IosSimulatorService } from './service';
import { SimulatorControlLeases } from './control-leases';
import { parseSimulatorDevices } from './devices';
import { MessageHandler } from '@/lib/message-handler';
const udid = '5519CB11-71C9-46D9-AEFF-73C96F1104E0';
const device: IosSimulatorDevice = {
  udid,
  name: 'Phone',
  runtime: 'iOS 26',
  deviceType: 'iPhone',
  state: 'Booted',
  available: true,
  occupancy: 'available',
};
const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  setDebug: () => {},
  child: () => logger,
  close: () => {},
};
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const services: IosSimulatorService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.closeAll()));
  vi.useRealTimers();
});
function fixture(workspaceId = 'w', leases = new SimulatorControlLeases(), boot = async () => {}) {
  const ready = deferred<void>();
  const processClosed = deferred<void>();
  let active: (() => boolean) | undefined;
  let renew: (() => void) | undefined;
  let released = false;
  let captureSignal: AbortSignal | undefined;
  let captureAbortedBeforeGatewayClose: boolean | undefined;
  const service = new IosSimulatorService({
    workspaceId,
    leases,
    logger,
    runtimeBaseUrl: 'https://example.test',
    authorize: async () => {},
    list: async () => [device],
    boot,
    binary: async () => '/managed/Baguette',
    process: async (_binary, signal) => {
      captureSignal = signal;
      return {
        port: 1,
        closed: processClosed.promise,
        control: async () => {},
        stop: async () => {
          processClosed.resolve();
        },
      };
    },
    gateway: async (o) => {
      active = o.active;
      renew = o.renew;
      return {
        port: 2,
        path: '/simulator/secret/',
        close: async () => {
          captureAbortedBeforeGatewayClose = captureSignal?.aborted;
          released = true;
        },
      };
    },
    localProxy: {
      acquire: async () => {
        ready.resolve();
        return {
          endpointId: 'endpoint',
          kind: 'local-proxy',
          viewerUrl: 'http://127.0.0.1:2/?token=secret',
          capabilities: { visualAnnotation: false, shareable: false },
          createdAt: 0,
        };
      },
      closeSession: async () => {},
    },
  });
  services.push(service);
  const call = (command: IosSimulatorRequest['command'], sessionId = 's') =>
    service.control({ sessionId, requestedByUserId: 'u', command }, false);
  return {
    service,
    call,
    agentCall: (command: IosSimulatorRequest['command']) =>
      service.controlFromAgent({ sessionId: 's', requestedByUserId: 'u', command }),
    captureStarted: () => captureSignal !== undefined,
    ready,
    active: () => active?.(),
    renew: () => renew?.(),
    released: () => released,
    captureAbortedBeforeGatewayClose: () => captureAbortedBeforeGatewayClose,
  };
}
describe('simulator ownership and lifecycle', () => {
  it('local agent ingress derives the active user and fails closed without that identity', async () => {
    const service = new IosSimulatorService({
      workspaceId: 'w',
      logger,
      runtimeBaseUrl: 'https://example.test',
      authorize: async (request) => {
        if (request.sessionId !== 's' || request.requestedByUserId !== 'session-owner')
          throw new Error('not owner');
      },
      list: async () => [device],
    });
    services.push(service);
    let requesterUserId: string | undefined;
    const handler: MessageHandler = Object.assign(Object.create(MessageHandler.prototype), {
      iosSimulatorService: service,
      executionService: {
        getActiveInvocationContext: (sessionId: string) =>
          sessionId === 's' && requesterUserId ? { requesterUserId } : null,
      },
    });
    const input = {
      machineId: 'm',
      workspaceId: 'w',
      method: 'ios-simulator/agent-control',
      params: { sessionId: 's', command: { action: 'list' } },
    };
    const request = LocalMachineRpcRequestSchema.parse(input);
    expect(
      LocalMachineRpcRequestSchema.safeParse({
        ...input,
        params: { ...input.params, requestedByUserId: 'session-owner' },
      }).success
    ).toBe(false);
    expect(await handler.handleLocalMachineRpc(request)).toMatchObject({
      ok: true,
      result: { success: false, error: 'denied' },
    });
    requesterUserId = 'teammate';
    expect(await handler.handleLocalMachineRpc(request)).toMatchObject({
      ok: true,
      result: { success: false, error: 'denied' },
    });
    requesterUserId = 'session-owner';
    expect(await handler.handleLocalMachineRpc(request)).toMatchObject({
      ok: true,
      result: { success: true, devices: [device] },
    });
  });

  it('agent preparation waits for a panel and agent status cannot attach or renew it', async () => {
    vi.useFakeTimers();
    const a = fixture();
    const started = await a.agentCall({ action: 'start', udid });
    expect(started.success).toBe(true);
    const waiting = await a.agentCall({ action: 'status' });
    expect(waiting.preview?.phase).toBe('connecting');
    expect(a.captureStarted()).toBe(false);
    await vi.advanceTimersByTimeAsync(DEFAULT_PREVIEW_IDLE_TIMEOUT_MS / 2);
    await a.agentCall({ action: 'status' });
    await vi.advanceTimersByTimeAsync(DEFAULT_PREVIEW_IDLE_TIMEOUT_MS / 2);
    expect((await a.agentCall({ action: 'status' })).preview?.phase).toBe('closed');
    expect(a.captureStarted()).toBe(false);
    expect((await a.call({ action: 'list' })).devices?.[0]?.occupancy).toBe('available');
  });

  it('the local panel attaches an agent operation, and a stale stop cannot cancel its replacement', async () => {
    const a = fixture();
    const first = await a.agentCall({ action: 'start', udid });
    const operationId = first.preview!.operationId;
    expect((await a.call({ action: 'status' })).preview?.operationId).toBe(operationId);
    await a.ready.promise;
    expect((await a.agentCall({ action: 'status' })).preview).toMatchObject({
      phase: 'ready',
      transport: 'local',
    });
    expect((await a.agentCall({ action: 'start', udid })).preview?.operationId).toBe(operationId);
    await a.agentCall({ action: 'stop', operationId });
    const next = await a.agentCall({ action: 'start', udid });
    await a.agentCall({ action: 'stop', operationId });
    expect((await a.agentCall({ action: 'status' })).preview?.operationId).toBe(
      next.preview?.operationId
    );
    await a.agentCall({ action: 'stop', operationId: next.preview!.operationId });
    expect((await a.call({ action: 'list' })).devices?.[0]?.occupancy).toBe('available');
  });

  it('only an authorized remote panel selects the deferred plane, and revocation cancels it', async () => {
    const boot = deferred<void>();
    const a = fixture('w', undefined, () => boot.promise);
    await a.agentCall({ action: 'start', udid });
    const request: IosSimulatorRequest = {
      sessionId: 's',
      requestedByUserId: 'u',
      command: { action: 'status' },
    };
    expect((await a.service.control(request, true, async () => {})).error).toBe('denied');
    a.service.enableRemote();
    expect(
      (
        await a.service.control(request, true, async () => {
          throw new Error('invalid proof');
        })
      ).error
    ).toBe('denied');
    expect((await a.agentCall({ action: 'status' })).preview?.transport).toBe('local');
    expect((await a.service.control(request, true, async () => {})).preview?.transport).toBe(
      'remote'
    );
    expect((await a.agentCall({ action: 'start', udid })).preview?.transport).toBe('remote');
    a.service.revokeRemote();
    boot.resolve();
    await a.service.closeSession('s');
    expect(a.captureStarted()).toBe(false);
    expect((await a.call({ action: 'list' })).devices?.[0]?.occupancy).toBe('available');
  });

  it('revokes admission while a remote proof is pending and stays disabled until re-enabled', async () => {
    const a = fixture();
    const proof = deferred<void>();
    const entered = deferred<void>();
    a.service.enableRemote();
    const pending = a.service.control(
      { sessionId: 's', requestedByUserId: 'u', command: { action: 'start', udid } },
      true,
      async () => {
        entered.resolve();
        await proof.promise;
      }
    );
    await entered.promise;
    a.service.revokeRemote();
    proof.resolve();
    expect((await pending).success).toBe(false);
    expect((await a.call({ action: 'status' })).preview).toBeUndefined();
    expect((await a.call({ action: 'list' })).devices?.[0]?.occupancy).toBe('available');
    const remoteList = () =>
      a.service.control(
        { sessionId: 's', requestedByUserId: 'u', command: { action: 'list' } },
        true,
        async () => {}
      );
    expect((await remoteList()).error).toBe('denied');
    a.service.enableRemote();
    expect((await remoteList()).success).toBe(true);
  });

  it('lists without acquiring a lease and serializes competing workspaces before boot', async () => {
    const leases = new SimulatorControlLeases();
    const boot = deferred<void>();
    const a = fixture('a', leases, () => boot.promise),
      b = fixture('b', leases);
    expect((await a.call({ action: 'list' })).devices?.[0]?.occupancy).toBe('available');
    const [first, second] = await Promise.all([
      a.call({ action: 'start', udid }),
      b.call({ action: 'start', udid: udid.toLowerCase() }),
    ]);
    expect([first.success, second.success]).toEqual([true, false]);
    expect(second.error).toBe('occupied');
    expect((await b.call({ action: 'list' })).devices?.[0]?.occupancy).toBe('other-session');
    boot.resolve();
    await a.ready.promise;
    expect(a.active()).toBe(true);
    await a.call({ action: 'stop', operationId: first.preview?.operationId ?? 'missing' });
    expect(a.released()).toBe(true);
    expect(a.captureAbortedBeforeGatewayClose()).toBe(false);
    expect(a.active()).toBe(false);
    expect((await b.call({ action: 'start', udid })).success).toBe(true);
  });
  it('cancels preparation, waits for cleanup, and never lets late completion create an endpoint', async () => {
    const gate = deferred<void>();
    const bootEntered = deferred<void>();
    const a = fixture('a', undefined, async () => {
      bootEntered.resolve();
      await gate.promise;
    });
    const started = await a.call({ action: 'start', udid });
    await bootEntered.promise;
    let stopped = false;
    const stopping = a
      .call({ action: 'stop', operationId: started.preview?.operationId ?? 'missing' })
      .then((r) => {
        stopped = true;
        return r;
      });
    expect(stopped).toBe(false);
    gate.resolve();
    const result = await stopping;
    expect(result.preview?.phase).toBe('closed');
    expect(result.preview?.viewerUrl).toBeUndefined();
    expect(a.released()).toBe(false);
  });
  it('stale stop cannot release a replacement and background observation does not renew', async () => {
    vi.useFakeTimers();
    const a = fixture();
    const first = await a.call({ action: 'start', udid });
    await a.ready.promise;
    await a.call({ action: 'stop', operationId: first.preview?.operationId ?? 'missing' });
    const second = await a.call({ action: 'start', udid });
    await a.call({ action: 'stop', operationId: first.preview?.operationId ?? 'missing' });
    expect((await a.call({ action: 'status' })).preview?.operationId).toBe(
      second.preview?.operationId
    );
    await vi.advanceTimersByTimeAsync(DEFAULT_PREVIEW_IDLE_TIMEOUT_MS);
    expect((await a.call({ action: 'status' })).preview?.viewerUrl).toBeUndefined();
  });
  it('generation checks prevent an old owner releasing a new lease', () => {
    const leases = new SimulatorControlLeases();
    expect(leases.acquire(udid, 'a', 'one')).toBe(true);
    leases.release(udid, 'a', 'one');
    expect(leases.acquire(udid, 'b', 'two')).toBe(true);
    leases.release(udid, 'a', 'one');
    expect(leases.occupancy(udid, 'a')).toBe('other-session');
  });
  it('validates simctl output and includes unavailable iOS devices without non-iOS targets', () => {
    const result = parseSimulatorDevices({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [
          {
            udid,
            name: 'Phone',
            state: 'Shutdown',
            isAvailable: false,
            availabilityError: 'Missing runtime',
          },
        ],
        'com.apple.CoreSimulator.SimRuntime.watchOS-26-0': [],
      },
    });
    expect(result).toEqual([
      expect.objectContaining({
        available: false,
        runtime: 'iOS 26.0',
        unavailableReason: 'Missing runtime',
      }),
    ]);
    expect(() => parseSimulatorDevices({ devices: { ios: [{ udid: '../../bad' }] } })).toThrow();
  });
});
