import { expect, it, vi } from 'vitest';
import { DevicePreviewService } from './service';
import { DeviceControlLeases } from './control-leases';
import { createAndroidViewerIdleTimeout } from '../android-emulator/preview-policy';
vi.mock('@lody/shared', () => ({ DEFAULT_PREVIEW_IDLE_TIMEOUT_MS: 3_600_000 }));
vi.mock('@/preview/quick-tunnel-session', () => ({ QuickTunnelSession: class {} }));
vi.mock('@/preview/local-preview-proxy', () => ({ LocalPreviewProxyManager: class {} }));
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it.each(['idle', 'stop', 'switch'] as const)(
  'releases Android occupancy only after native cleanup (%s)',
  async (reason) => {
    vi.useFakeTimers();
    const closed = deferred();
    const cleanupStarted = deferred();
    const cleanupAllowed = deferred();
    const ready = deferred();
    const idle = createAndroidViewerIdleTimeout(closed.resolve);
    const options: unknown[] = [];
    const service = new DevicePreviewService({
      workspaceId: 'workspace',
      runtimeBaseUrl: 'https://example.test',
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
        success() {},
        setDebug() {},
        child() {
          return this;
        },
        async close() {},
      },
      leases: new DeviceControlLeases(),
      authorize: async () => {},
      localProxy: {
        acquire: async () => {
          ready.resolve();
          return {
            viewerUrl: 'http://localhost:1234/viewer',
            endpointId: 'local',
            kind: 'local-proxy',
            capabilities: { visualAnnotation: false, shareable: false },
            createdAt: 0,
          };
        },
        closeSession: async () => {},
      },
      adapter: {
        platform: 'android',
        normalize: (id) => id,
        environmentMessage: 'failed',
        list: async () => [
          {
            id: 'Pixel',
            name: 'Pixel',
            runtime: 'Android',
            deviceType: 'AVD',
            state: 'Booted',
            available: true,
            occupancy: 'available',
          },
        ],
        prepare: async () => '/runtime',
        boot: async () => {},
        open: async (_runtime, _device, _signal, quality) => {
          options.push(quality);
          return {
            closed: closed.promise,
            gateway: async () => ({
              port: 1234,
              path: '/viewer',
              remotePath: '/remote',
              close: async () => {},
            }),
            stop: async () => {
              cleanupStarted.resolve();
              await cleanupAllowed.promise;
              idle.dispose();
            },
          };
        },
      },
    });
    const call = (sessionId: string, command: Parameters<typeof service.control>[0]['command']) =>
      service.control({ sessionId, requestedByUserId: 'user', command }, false);
    try {
      const start = await call('first', { action: 'start', id: 'Pixel', quality: 'saver' });
      await ready.promise;
      expect(options).toEqual(['saver']);
      let stopping: ReturnType<typeof call> | undefined;
      if (reason === 'idle') await vi.advanceTimersByTimeAsync(30_000);
      else if (reason === 'switch')
        stopping = call('first', { action: 'start', id: 'Pixel', quality: 'clear' });
      else stopping = call('first', { action: 'stop', operationId: start.preview!.operationId });
      await cleanupStarted.promise;
      expect((await call('second', { action: 'start', id: 'Pixel' })).error).toBe('occupied');
      cleanupAllowed.resolve();
      if (stopping) await stopping;
      if (reason === 'switch') {
        await vi.advanceTimersByTimeAsync(0);
        expect(options).toEqual(['saver', 'clear']);
        expect((await call('second', { action: 'start', id: 'Pixel' })).error).toBe('occupied');
      }
      await service.closeSession('first');
      expect((await call('second', { action: 'start', id: 'Pixel' })).success).toBe(true);
    } finally {
      cleanupAllowed.resolve();
      idle.dispose();
      await service.closeAll();
      vi.useRealTimers();
    }
  }
);
it('expires an agent start with no first viewer after boot, without opening capture', async () => {
  vi.useFakeTimers();
  const boot = deferred();
  const service = new DevicePreviewService({
    workspaceId: 'workspace',
    runtimeBaseUrl: 'https://example.test',
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
      success() {},
      setDebug() {},
      child() {
        return this;
      },
      async close() {},
    },
    leases: new DeviceControlLeases(),
    authorize: async () => {},
    localProxy: {
      acquire: async () => {
        throw Error('unexpected viewer');
      },
      closeSession: async () => {},
    },
    adapter: {
      platform: 'android',
      normalize: (id) => id,
      environmentMessage: 'failed',
      viewerAttachTimeoutMs: 30_000,
      list: async () => [
        {
          id: 'Pixel',
          name: 'Pixel',
          runtime: 'Android',
          deviceType: 'AVD',
          state: 'Booted',
          available: true,
          occupancy: 'available',
        },
      ],
      prepare: async () => '/runtime',
      boot: () => boot.promise,
      open: async () => {
        throw Error('no viewer should mean no capture');
      },
    },
  });
  const request = {
    sessionId: 'first',
    requestedByUserId: 'user',
    command: { action: 'start' as const, id: 'Pixel' },
  };
  try {
    await service.controlFromAgent(request);
    await vi.advanceTimersByTimeAsync(60_000);
    const list = () =>
      service.control({ ...request, sessionId: 'second', command: { action: 'list' } }, false);
    expect((await list()).devices?.[0]?.occupancy).toBe('other-session');
    boot.resolve();
    await vi.advanceTimersByTimeAsync(29_999);
    expect((await list()).devices?.[0]?.occupancy).toBe('other-session');
    await vi.advanceTimersByTimeAsync(1);
    expect((await list()).devices?.[0]?.occupancy).toBe('available');
    const status = await service.control({ ...request, command: { action: 'status' } }, false);
    expect(status.preview?.phase).toBe('closed');
  } finally {
    boot.resolve();
    await service.closeAll();
    vi.useRealTimers();
  }
});
