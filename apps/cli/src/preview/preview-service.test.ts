import http from 'node:http';
import { once } from 'node:events';
import {
  Agent,
  MockAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
  fetch as directFetch,
} from 'undici';
import { WebSocket, WebSocketServer } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LocalSessionControlResponseSchema,
  DEFAULT_PREVIEW_IDLE_TIMEOUT_MS,
  PREVIEW_ACCESS_TOKEN_QUERY_PARAM,
  type MachineId,
  type SessionId,
  type SessionMeta,
  type SessionPreviewCreateRequest,
  type SessionPreviewDocState,
  type WorkspaceId,
} from '@lody/shared';
import { createLogger } from '@/utils/logger';
import { PreviewService } from './preview-service';
import { ensureCloudflaredBinary } from './cloudflared-binary';
import { CloudflaredError, startCloudflaredProcess } from './cloudflared-process';
import { verifyPreviewTunnelRoundTrip } from './preview-tunnel-readiness';

vi.mock('./cloudflared-binary', () => ({ ensureCloudflaredBinary: vi.fn() }));
vi.mock('./cloudflared-process', async (original) => ({
  ...(await original<typeof import('./cloudflared-process')>()),
  startCloudflaredProcess: vi.fn(),
}));
vi.mock('./preview-tunnel-readiness', async (original) => ({
  ...(await original<typeof import('./preview-tunnel-readiness')>()),
  verifyPreviewTunnelRoundTrip: vi.fn(),
}));

const machineId = 'machine-preview' as MachineId;
const workspaceId = 'workspace-preview' as WorkspaceId;
const sessionId = 'session-preview' as SessionId;
const userId = 'user-preview';
const logger = createLogger({ level: 'silent', transports: 'console' });

function fixture() {
  let preview: SessionPreviewDocState = {};
  let meta: SessionMeta = {
    id: sessionId,
    machineId,
    userId,
    createdAt: '2026-09-21',
    cliType: 'builtin',
    agentType: 'codex',
  };
  const changes: SessionPreviewDocState[] = [];
  const service = new PreviewService({
    logger,
    machineId,
    workspaceId,
    userId,
    now: () => Date.now(),
    runtimeBaseUrl: 'https://runtime.example.test',
    remotePreview: {
      verifyControl: async ({ intent }) => ({
        requesterUserId: intent.requesterUserId,
        expiresAt: Date.now() + 120_000,
      }),
    },
    workspaceDocument: {
      getOrCreateSessionDoc: async () => ({
        getPreviewState: async () => preview,
        setPreviewState: async (next) => {
          preview = next;
          changes.push(next);
        },
      }),
      repo: {
        getDocMeta: async () => ({ meta }),
        upsertDocMeta: async (_room, patch) => {
          meta = { ...meta, ...patch };
        },
      },
    },
  });
  return { service, changes, state: () => preview, meta: () => meta };
}

describe('PreviewService Quick Tunnel lifecycle', () => {
  const services: PreviewService[] = [];
  let server: http.Server;
  let port: number;
  let exit: (error: CloudflaredError | null) => void;
  let proxyOrigin: string;

  function createRequest(
    overrides: Partial<SessionPreviewCreateRequest> = {}
  ): SessionPreviewCreateRequest {
    const target = { protocol: 'http' as const, host: '127.0.0.1', port };
    return {
      type: 'session/preview-create',
      machineId,
      workspaceId,
      sessionId,
      requestedByUserId: userId,
      target,
      approval: {
        source: 'browser_address',
        targetClass: 'loopback',
        target,
        confirmedByUserId: userId,
        confirmedAt: Date.now(),
      },
      ...overrides,
    };
  }

  beforeEach(async () => {
    vi.mocked(ensureCloudflaredBinary).mockResolvedValue('/synthetic/cloudflared');
    vi.mocked(startCloudflaredProcess).mockImplementation(async (options) => {
      proxyOrigin = options.proxyOrigin;
      const closed = new Promise<CloudflaredError | null>((resolve) => {
        exit = resolve;
      });
      return {
        origin: 'https://synthetic-preview.trycloudflare.com',
        closed,
        diagnostic: () => undefined,
        stop: async () => {
          exit(null);
        },
      };
    });
    // Exercise the actual proxy; substitute only the Cloudflare network hop.
    vi.mocked(verifyPreviewTunnelRoundTrip).mockImplementation(async ({ publicUrl }) => {
      const url = new URL(publicUrl);
      const response = await fetch(`${proxyOrigin}${url.pathname}${url.search}`, {
        headers: { 'x-lody-preview-probe': '1' },
      });
      expect(response.headers.get('x-lody-preview-proxy')).toBe('1');
      expect(await response.text()).toBe('development server');
    });
    server = http.createServer((_request, response) => response.end('development server'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected loopback port');
    port = address.port;
  });

  afterEach(async () => {
    await Promise.all(
      services.splice(0).map((service) => service.closeAllActiveTunnelsForCleanup('test cleanup'))
    );
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  function setup() {
    const result = fixture();
    services.push(result.service);
    return result;
  }

  it('creates without an agent candidate and preserves local viewing and the dev server after revoke', async () => {
    const { service, state } = setup();
    const request = createRequest();
    const local = await service.acquireEndpoint(request);
    const remote = await service.createPreview(request);
    expect(remote.success).toBe(true);
    expect(remote.connection?.status).toBe('active');
    const publicUrl = new URL(remote.connection?.publicUrl ?? '');
    expect(publicUrl.origin).toBe('https://synthetic-preview.trycloudflare.com');
    expect(publicUrl.searchParams.get(PREVIEW_ACCESS_TOKEN_QUERY_PARAM)).toBeTruthy();
    expect((await fetch(proxyOrigin)).status).toBe(403);
    expect(LocalSessionControlResponseSchema.safeParse(remote).success).toBe(true);
    const revoked = await service.revokePreview({ ...request, type: 'session/preview-revoke' });
    expect(revoked.success).toBe(true);
    expect(state().connection?.status).toBe('closed');
    await expect(fetch(proxyOrigin)).rejects.toThrow();
    expect(await (await fetch(local.endpoint?.viewerUrl ?? '')).text()).toBe('development server');
    expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe('development server');
  });

  it('rejects stale consent, changed origins, unsafe hosts, and unauthorized revoke without altering active state', async () => {
    const { service, state } = setup();
    const request = createRequest();
    await service.createPreview(request);
    const active = state().connection;
    const stale = await service.createPreview({
      ...request,
      approval: { ...request.approval, confirmedAt: 0 },
    });
    expect(stale.error).toBe('user_confirmation_required');
    const changed = await service.createPreview({
      ...request,
      target: { ...request.target, port: port + 1 },
    });
    expect(changed.error).toBe('target_changed');
    for (const host of ['192.168.1.1', 'service.localhost', 'example.com']) {
      expect(
        (await service.createPreview({ ...request, target: { ...request.target, host } })).success
      ).toBe(false);
    }
    const denied = await service.revokePreview({
      ...request,
      type: 'session/preview-revoke',
      requestedByUserId: 'other-user',
    });
    expect(denied.error).toBe('grant_denied');
    expect(state().connection).toEqual(active);
  });

  it('aborts pending readiness on revoke and never publishes a late active state', async () => {
    const entered = Promise.withResolvers<void>();
    vi.mocked(verifyPreviewTunnelRoundTrip).mockImplementation(async ({ signal }) => {
      entered.resolve();
      await new Promise<void>((_resolve, reject) =>
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      );
    });
    const { service, changes, state } = setup();
    const request = createRequest();
    const creating = service.createPreview(request);
    await entered.promise;
    const revoke = service.revokePreview({ ...request, type: 'session/preview-revoke' });
    expect((await creating).success).toBe(false);
    expect((await revoke).success).toBe(true);
    expect(changes.some((change) => change.connection?.status === 'active')).toBe(false);
    expect(state().connection?.status).toBe('closed');
    await expect(fetch(proxyOrigin)).rejects.toThrow();
  });

  it('reports readiness failure, releases the proxy, and allows explicit new creation', async () => {
    const verify = vi.mocked(verifyPreviewTunnelRoundTrip).getMockImplementation();
    vi.mocked(verifyPreviewTunnelRoundTrip).mockRejectedValueOnce(
      new Error('public route unavailable')
    );
    const { service, state } = setup();
    expect((await service.createPreview(createRequest())).success).toBe(false);
    expect(state().connection?.error?.message).toContain('public route unavailable');
    await expect(fetch(proxyOrigin)).rejects.toThrow();
    if (!verify) throw new Error('Missing synthetic transport');
    vi.mocked(verifyPreviewTunnelRoundTrip).mockImplementation(verify);
    expect((await service.createPreview(createRequest())).success).toBe(true);
  });

  it('keeps timestamps integral and only status summaries in meta', async () => {
    const { service, state, meta } = setup();
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000.5);
    const reported = await service.reportCandidate({
      ...createRequest(),
      type: 'session/preview-candidate-report',
    });
    expect(reported.success).toBe(true);
    expect(reported.candidate?.updatedAt).toBe(1_800_000_000_001);
    expect(state().candidate?.target?.port).toBe(port);
    expect(Object.keys(meta().previewCandidate ?? {}).sort()).toEqual(['status', 'updatedAt']);
    expect(LocalSessionControlResponseSchema.safeParse(reported).success).toBe(true);
  });

  it('observes without extending the deadline and renews only the current endpoint', async () => {
    let now = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { service, changes } = setup();
    const request = createRequest();
    const created = await service.createPreview(request);
    const statusRequest = { ...request, type: 'session/preview-status' as const };
    const first = await service.getStatus(statusRequest);
    expect(first.expiresAt).toBe(now + DEFAULT_PREVIEW_IDLE_TIMEOUT_MS);
    const lifecycleWrites = changes.length;
    now += 30 * 60_000;
    expect((await service.getStatus(statusRequest)).expiresAt).toBe(first.expiresAt);
    expect(
      (await service.getStatus({ ...statusRequest, renewEndpointId: 'replaced-endpoint' }))
        .expiresAt
    ).toBe(first.expiresAt);
    const renewed = await service.getStatus({
      ...statusRequest,
      renewEndpointId: created.connection?.endpointId,
    });
    expect(renewed.expiresAt).toBe(now + DEFAULT_PREVIEW_IDLE_TIMEOUT_MS);
    expect(LocalSessionControlResponseSchema.safeParse(renewed).success).toBe(true);
    expect(changes).toHaveLength(lifecycleWrites);
    now += DEFAULT_PREVIEW_IDLE_TIMEOUT_MS;
    const expired = await service.getStatus({
      ...statusRequest,
      renewEndpointId: created.connection?.endpointId,
    });
    expect(expired.connection?.status).toBe('closed');
    expect(expired.connection?.closedReason).toBe('idle_timeout');
    expect(expired.connection?.publicUrl).toBeUndefined();
    await expect(fetch(proxyOrigin)).rejects.toThrow();
  });

  it('refuses an unauthorized heartbeat without extending access', async () => {
    let now = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { service } = setup();
    const request = createRequest();
    const created = await service.createPreview(request);
    const statusRequest = {
      ...request,
      type: 'session/preview-status' as const,
      renewEndpointId: created.connection?.endpointId,
    };
    now += 30 * 60_000;
    const denied = await service.getStatus({ ...statusRequest, requestedByUserId: 'another-user' });
    expect(denied.success).toBe(false);
    expect(denied.connection).toBeUndefined();
    now += 30 * 60_000;
    expect((await service.getStatus(statusRequest)).connection?.closedReason).toBe('idle_timeout');
    await expect(fetch(proxyOrigin)).rejects.toThrow();
  });

  it('reports a broken public route despite a live child, preserves local access, and permits explicit restore', async () => {
    const { service } = setup();
    const request = createRequest();
    const local = await service.acquireEndpoint(request);
    const created = await service.createPreview(request);
    vi.mocked(verifyPreviewTunnelRoundTrip).mockRejectedValueOnce(
      new Error('Public route disconnected')
    );
    const observed = await service.getStatus({
      ...request,
      type: 'session/preview-status',
      renewEndpointId: created.connection?.endpointId,
    });
    expect(observed.success).toBe(true);
    expect(observed.connection?.status).toBe('failed');
    expect(observed.connection?.error?.message).toContain('Public route disconnected');
    expect(observed.connection?.publicUrl).toBeUndefined();
    await expect(fetch(proxyOrigin)).rejects.toThrow();
    expect(await (await fetch(local.endpoint?.viewerUrl ?? '')).text()).toBe('development server');
    const restored = await service.createPreview({ ...request, restart: true });
    expect(restored.connection?.status).toBe('active');
    expect(restored.connection?.endpointId).not.toBe(created.connection?.endpointId);
    expect(restored.connection?.publicUrl).not.toBe(created.connection?.publicUrl);
  });

  it('does not report an old health result over an explicit replacement', async () => {
    const { service } = setup();
    const request = createRequest();
    const created = await service.createPreview(request);
    const entered = Promise.withResolvers<void>();
    const checked = Promise.withResolvers<void>();
    vi.mocked(verifyPreviewTunnelRoundTrip).mockImplementationOnce(async () => {
      entered.resolve();
      await checked.promise;
    });
    const observing = service.getStatus({ ...request, type: 'session/preview-status' });
    await entered.promise;
    const restored = await service.createPreview({ ...request, restart: true });
    checked.resolve();
    const observed = await observing;
    expect(observed.connection?.status).toBe('active');
    expect(observed.connection?.endpointId).toBe(restored.connection?.endpointId);
    expect(observed.connection?.endpointId).not.toBe(created.connection?.endpointId);
  });

  it.each(['127.0.0.1', '::1'])(
    'pins localhost HTTP and WS to the probed %s address without global transport',
    async (address) => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server = http.createServer((request, response) => {
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({ host: request.headers.host, address: request.socket.localAddress })
        );
      });
      server.listen(0, address);
      await once(server, 'listening');
      const bound = server.address();
      if (!bound || typeof bound === 'string') throw new Error('Missing fixture port');
      port = bound.port;
      const upstream = new WebSocketServer({ server });
      upstream.on('connection', (client, request) => {
        client.on('message', () =>
          client.send(
            JSON.stringify({ host: request.headers.host, address: request.socket.localAddress })
          )
        );
      });
      const previous = getGlobalDispatcher();
      const blocked = new MockAgent();
      blocked.disableNetConnect();
      const viewer = new Agent();
      let socket: WebSocket | undefined;
      const { service } = setup();
      try {
        // The CLI may have a global proxy/dispatcher. Local probes and forwarding
        // must work even when that dispatcher rejects every network request.
        setGlobalDispatcher(blocked);
        const target = { protocol: 'http' as const, host: 'localhost', port };
        const request = createRequest();
        const acquired = await service.acquireEndpoint({ ...request, target });
        expect(acquired.success).toBe(true);
        expect(acquired.endpoint?.target.host).toBe('localhost');
        const url = new URL(acquired.endpoint?.viewerUrl ?? '');
        const response = await directFetch(url, { dispatcher: viewer });
        expect(await response.json()).toEqual({ host: `localhost:${port}`, address });
        url.protocol = 'ws:';
        socket = new WebSocket(url);
        await once(socket, 'open');
        const received = once(socket, 'message');
        socket.send('observe peer');
        const [message] = await received;
        expect(JSON.parse(String(message))).toEqual({ host: `localhost:${port}`, address });
        const disconnected = once(socket, 'close');
        await service.closeAllActiveTunnelsForCleanup('test cleanup');
        await disconnected;
        await expect(
          directFetch(acquired.endpoint?.viewerUrl ?? '', { dispatcher: viewer })
        ).rejects.toThrow();
      } finally {
        setGlobalDispatcher(previous);
        socket?.terminate();
        for (const client of upstream.clients) client.terminate();
        upstream.close();
        await Promise.all([blocked.close(), viewer.destroy()]);
      }
    }
  );
});
