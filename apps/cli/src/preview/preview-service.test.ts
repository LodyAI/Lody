import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LocalSessionControlResponseSchema,
  type MachineId,
  type SessionId,
  type SessionMeta,
  type SessionMetaWithLegacyPreview,
  type WorkspaceId,
} from '@lody/shared';
import { PreviewService } from './preview-service';
import { startPreviewTunnel } from './preview-tunnel-client';

vi.mock('./preview-tunnel-client', () => ({
  startPreviewTunnel: vi.fn(),
}));

const machineId = 'machine-preview' as MachineId;
const workspaceId = 'workspace-preview' as WorkspaceId;
const userId = 'user-preview';

const createLogger = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  setDebug: vi.fn(),
  child: vi.fn(),
  close: vi.fn(),
});

const listenOnLoopback = async (): Promise<{ server: net.Server; port: number }> => {
  const server = net.createServer((socket) => {
    socket.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP server to listen on a port');
  }
  return { server, port: (address as AddressInfo).port };
};

const listenHttpOnLoopback = async (): Promise<{ server: http.Server; port: number }> => {
  const server = http.createServer((_request, response) => {
    response.end('ok');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected HTTP server to listen on a port');
  }
  return { server, port: (address as AddressInfo).port };
};

const listenHttpOnIpv6Loopback = async (): Promise<{ server: http.Server; port: number }> => {
  const server = http.createServer((_request, response) => {
    response.end('ok');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '::1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected HTTP server to listen on an IPv6 port');
  }
  return { server, port: (address as AddressInfo).port };
};

describe('PreviewService', () => {
  const servers: Array<net.Server | http.Server> = [];

  afterEach(async () => {
    vi.clearAllMocks();
    delete process.env.LODY_PREVIEW_GATEWAY_URL;
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          })
      )
    );
  });

  it('returns integer timestamps that pass local-control response validation', async () => {
    const { server, port } = await listenOnLoopback();
    servers.push(server);

    const meta: SessionMetaWithLegacyPreview = {
      id: 'session-preview',
      machineId,
      createdAt: '2026-04-30T00:00:00.000Z',
      userId,
      cliType: 'builtin',
      agentType: 'codex',
    };

    const logger = createLogger();
    const service = new PreviewService({
      logger,
      workspaceDocument: {
        getOrCreateSessionDoc: vi.fn(async () => {
          let previewState = {};
          return {
            getPreviewState: vi.fn(async () => previewState),
            setPreviewState: vi.fn(async (next) => {
              previewState = next;
            }),
          };
        }),
        repo: {
          getDocMeta: vi.fn(async () => ({ meta })),
          upsertDocMeta: vi.fn(async () => undefined),
        },
      },
      machineId,
      workspaceId,
      userId,
      now: () => 1_714_438_400_000.5,
      authToken: () => 'token',
      remoteGatewayUrl: null,
    } as unknown as ConstructorParameters<typeof PreviewService>[0]);

    const response = await service.reportCandidate({
      type: 'session/preview-candidate-report',
      machineId,
      workspaceId,
      sessionId: meta.id,
      target: {
        protocol: 'http',
        host: '127.0.0.1',
        port,
      },
      source: {
        toolName: 'lody_report_preview_candidate',
      },
    });

    expect(response.success).toBe(true);
    expect(response.candidate?.reportedAt).toBe(1_714_438_400_001);
    expect(response.candidate?.updatedAt).toBe(1_714_438_400_001);
    expect(response.candidate?.validation?.lastCheckedAt).toBe(1_714_438_400_001);
    expect(LocalSessionControlResponseSchema.safeParse(response).success).toBe(true);
  });

  it('acquires localhost endpoints for Vite servers listening only on IPv6 loopback', async () => {
    const { server, port } = await listenHttpOnIpv6Loopback();
    servers.push(server);
    const sessionId = 'session-preview-ipv6-localhost' as SessionId;
    const meta: SessionMeta = {
      id: sessionId,
      machineId,
      createdAt: '2026-04-30T00:00:00.000Z',
      userId,
      cliType: 'builtin',
      agentType: 'codex',
    };
    const logger = createLogger();
    const service = new PreviewService({
      logger,
      workspaceDocument: {
        getOrCreateSessionDoc: vi.fn(async () => ({
          getPreviewState: vi.fn(async () => ({})),
          setPreviewState: vi.fn(async () => undefined),
        })),
        repo: {
          getDocMeta: vi.fn(async () => ({ meta })),
          upsertDocMeta: vi.fn(async () => undefined),
        },
      },
      machineId,
      workspaceId,
      userId,
      authToken: () => 'token',
      remoteGatewayUrl: null,
    } as unknown as ConstructorParameters<typeof PreviewService>[0]);

    try {
      const response = await service.acquireEndpoint({
        machineId,
        workspaceId,
        sessionId,
        requestedByUserId: userId,
        target: { protocol: 'http', host: 'localhost', port },
      });

      expect(response.success).toBe(true);
      expect(response.endpoint?.target).toEqual({ protocol: 'http', host: 'localhost', port });
    } finally {
      await service.closeAllActiveTunnelsForCleanup('test cleanup');
    }
  });

  it('acquires localhost endpoints for IPv6 servers when the resolver answers IPv4 only', async () => {
    // A Linux host with no routable IPv6 address resolves `localhost` to
    // 127.0.0.1 only, while macOS answers `::1` first. Pin the resolver so the
    // IPv4-first case is exercised on every platform instead of only on CI.
    const { server, port } = await listenHttpOnIpv6Loopback();
    servers.push(server);
    const previousDispatcher = getGlobalDispatcher();
    setGlobalDispatcher(
      new Agent({
        connect: {
          lookup: (hostname, _options, callback) => {
            callback(
              null,
              hostname === 'localhost' ? '127.0.0.1' : hostname,
              hostname.includes(':') ? 6 : 4
            );
          },
        },
      })
    );

    const sessionId = 'session-preview-ipv6-ipv4-resolver' as SessionId;
    const meta: SessionMeta = {
      id: sessionId,
      machineId,
      createdAt: '2026-04-30T00:00:00.000Z',
      userId,
      cliType: 'builtin',
      agentType: 'codex',
    };
    const service = new PreviewService({
      logger: createLogger(),
      workspaceDocument: {
        getOrCreateSessionDoc: vi.fn(async () => ({
          getPreviewState: vi.fn(async () => ({})),
          setPreviewState: vi.fn(async () => undefined),
        })),
        repo: {
          getDocMeta: vi.fn(async () => ({ meta })),
          upsertDocMeta: vi.fn(async () => undefined),
        },
      },
      machineId,
      workspaceId,
      userId,
      authToken: () => 'token',
      remoteGatewayUrl: null,
    } as unknown as ConstructorParameters<typeof PreviewService>[0]);

    try {
      const response = await service.acquireEndpoint({
        machineId,
        workspaceId,
        sessionId,
        requestedByUserId: userId,
        target: { protocol: 'http', host: 'localhost', port },
      });

      expect(response.success).toBe(true);
      expect(response.endpoint?.target).toEqual({ protocol: 'http', host: 'localhost', port });
    } finally {
      setGlobalDispatcher(previousDispatcher);
      await service.closeAllActiveTunnelsForCleanup('test cleanup');
    }
  });

  it('closes active preview tunnels and marks the connection revoked during cleanup', async () => {
    const sessionId = 'session-preview-cleanup' as SessionId;
    const upsertDocMeta = vi.fn(async () => undefined);
    let previewState = {};
    const setPreviewState = vi.fn(async (next) => {
      previewState = next;
    });
    const meta: SessionMeta = {
      id: sessionId,
      machineId,
      createdAt: '2026-04-30T00:00:00.000Z',
      userId,
      cliType: 'builtin',
      agentType: 'codex',
      previewConnection: {
        status: 'active',
        grantId: 'grant-preview-cleanup',
        tunnelId: 'session-grant',
        publicUrl: 'https://session-grant.mylody.app',
        target: {
          protocol: 'http',
          host: '127.0.0.1',
          port: 5173,
        },
        createdAt: 1_714_438_300_000,
        updatedAt: 1_714_438_300_000,
      },
    };

    const service = new PreviewService({
      logger: createLogger(),
      workspaceDocument: {
        getOrCreateSessionDoc: vi.fn(async () => ({
          getPreviewState: vi.fn(async () => previewState),
          setPreviewState,
        })),
        repo: {
          getDocMeta: vi.fn(async () => ({ meta })),
          upsertDocMeta,
        },
      },
      machineId,
      workspaceId,
      userId,
      now: () => 1_714_438_400_000,
      authToken: () => 'token',
      remoteGatewayUrl: null,
    } as unknown as ConstructorParameters<typeof PreviewService>[0]);

    const close = vi.fn(async () => undefined);
    (
      service as unknown as {
        activeTunnels: Map<SessionId, { close: (reason?: string) => Promise<void> }>;
      }
    ).activeTunnels.set(sessionId, { close });

    await service.closeSessionPreviewForCleanup(sessionId, 'Session archived');

    expect(close).toHaveBeenCalledWith('Session archived');
    expect(setPreviewState).toHaveBeenCalledWith(
      expect.objectContaining({
        connection: expect.objectContaining({
          status: 'revoked',
          revokedAt: 1_714_438_400_000,
          revokeReason: 'Session archived',
        }),
      })
    );
    expect(upsertDocMeta).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        previewConnection: {
          status: 'revoked',
          updatedAt: 1_714_438_400_000,
        },
      })
    );
  });

  it('never tunnels to a LAN host, so the machine cannot become a pivot into its network', async () => {
    // A user-approved request is the strongest input the create path accepts, and
    // the approver sits on the OTHER side of the tunnel: they cannot know what a
    // LAN address means on this machine. So even a fresh, matching approval must
    // not open one. `startPreviewTunnel` staying uncalled is the observable
    // guarantee; the error code is what the client renders.
    const sessionId = 'session-preview-pivot' as SessionId;
    const meta: SessionMetaWithLegacyPreview = {
      id: sessionId,
      machineId,
      createdAt: '2026-04-30T00:00:00.000Z',
      userId,
      cliType: 'builtin',
      agentType: 'codex',
    };
    const service = new PreviewService({
      logger: createLogger(),
      workspaceDocument: {
        getOrCreateSessionDoc: vi.fn(async () => ({
          getPreviewState: vi.fn(async () => ({})),
          setPreviewState: vi.fn(async () => undefined),
        })),
        repo: { getDocMeta: vi.fn(async () => ({ meta })), upsertDocMeta: vi.fn() },
      },
      machineId,
      workspaceId,
      userId,
      now: () => 1_714_438_400_000,
      authToken: () => 'token',
      remoteGatewayUrl: 'https://preview.example.com',
    } as unknown as ConstructorParameters<typeof PreviewService>[0]);

    for (const host of ['192.168.1.20', '10.0.0.5', '172.16.4.4', 'fc00::1', 'printer.local']) {
      const target = { protocol: 'http' as const, host, port: 3000 };
      const response = await service.createPreview({
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
          confirmedAt: 1_714_438_400_000,
        },
      });
      expect(response.success, host).toBe(false);
      expect(response.error, host).toBe('host_not_loopback');
    }
    expect(startPreviewTunnel).not.toHaveBeenCalled();
  });

  it('requires a loopback literal or the exact name localhost, not any *.localhost spelling', async () => {
    // `classifyBrowserHostname` calls `foo.localhost` loopback by spelling, but nothing
    // guarantees a resolver answers it from 127.0.0.0/8, and the probe substitutes
    // literals only for the exact string `localhost`. Accepting the spelling would make
    // the no-pivot invariant true of the name and false of the address.
    const sessionId = 'session-preview-localhost-name' as SessionId;
    const meta: SessionMetaWithLegacyPreview = {
      id: sessionId,
      machineId,
      createdAt: '2026-04-30T00:00:00.000Z',
      userId,
      cliType: 'builtin',
      agentType: 'codex',
    };
    const service = new PreviewService({
      logger: createLogger(),
      workspaceDocument: {
        getOrCreateSessionDoc: vi.fn(async () => ({
          getPreviewState: vi.fn(async () => ({})),
          setPreviewState: vi.fn(async () => undefined),
        })),
        repo: { getDocMeta: vi.fn(async () => ({ meta })), upsertDocMeta: vi.fn() },
      },
      machineId,
      workspaceId,
      userId,
      now: () => 1_714_438_400_000,
      authToken: () => 'token',
      remoteGatewayUrl: 'https://preview.example.com',
    } as unknown as ConstructorParameters<typeof PreviewService>[0]);

    for (const host of ['app.localhost', 'evil.localhost']) {
      const target = { protocol: 'http' as const, host, port: 3000 };
      const response = await service.createPreview({
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
          confirmedAt: 1_714_438_400_000,
        },
      });
      expect(response.success, host).toBe(false);
      expect(response.error, host).toBe('host_not_loopback');
    }
    expect(startPreviewTunnel).not.toHaveBeenCalled();
  });

  it('creates a target-bound tunnel from explicit user input without a candidate', async () => {
    const { server, port } = await listenHttpOnLoopback();
    servers.push(server);
    vi.mocked(startPreviewTunnel).mockResolvedValue({
      tunnelId: 'mock-tunnel',
      publicUrl: 'https://preview.example.com/mock-tunnel',
      close: vi.fn(async () => undefined),
      closed: Promise.resolve(),
    });

    const sessionId = 'session-preview-create' as SessionId;
    let meta: SessionMetaWithLegacyPreview = {
      id: sessionId,
      machineId,
      createdAt: '2026-04-30T00:00:00.000Z',
      userId,
      cliType: 'builtin',
      agentType: 'codex',
    };
    let previewState = {};
    const setPreviewState = vi.fn(async (next) => {
      previewState = next;
    });
    const upsertDocMeta = vi.fn(async (_roomId: string, patch: Partial<SessionMeta>) => {
      meta = { ...meta, ...patch };
    });
    const logger = createLogger();
    const service = new PreviewService({
      logger,
      workspaceDocument: {
        getOrCreateSessionDoc: vi.fn(async () => ({
          getPreviewState: vi.fn(async () => previewState),
          setPreviewState,
        })),
        repo: {
          getDocMeta: vi.fn(async () => ({ meta })),
          upsertDocMeta,
        },
      },
      machineId,
      workspaceId,
      userId,
      now: () => 1_714_438_400_000,
      authToken: () => 'token',
      remoteGatewayUrl: 'https://preview.example.com',
    } as unknown as ConstructorParameters<typeof PreviewService>[0]);

    const staleApprovalResponse = await service.createPreview({
      type: 'session/preview-create',
      machineId,
      workspaceId,
      sessionId,
      requestedByUserId: userId,
      target: { protocol: 'http', host: '127.0.0.1', port },
      approval: {
        source: 'browser_address',
        targetClass: 'loopback',
        target: { protocol: 'http', host: '127.0.0.1', port },
        confirmedByUserId: userId,
        confirmedAt: 1_714_437_000_000,
      },
    });
    expect(staleApprovalResponse.success).toBe(false);
    expect(staleApprovalResponse.error).toBe('user_confirmation_required');

    const changedTargetResponse = await service.createPreview({
      type: 'session/preview-create',
      machineId,
      workspaceId,
      sessionId,
      requestedByUserId: userId,
      target: { protocol: 'http', host: '127.0.0.1', port },
      approval: {
        source: 'browser_address',
        targetClass: 'loopback',
        target: { protocol: 'http', host: '127.0.0.1', port: port + 1 },
        confirmedByUserId: userId,
        confirmedAt: 1_714_438_400_000,
      },
    });
    expect(changedTargetResponse.success).toBe(false);
    expect(changedTargetResponse.error).toBe('target_changed');

    const response = await service.createPreview({
      type: 'session/preview-create',
      machineId,
      workspaceId,
      sessionId,
      requestedByUserId: userId,
      target: {
        protocol: 'http',
        host: '127.0.0.1',
        port,
      },
      approval: {
        source: 'browser_address',
        targetClass: 'loopback',
        target: { protocol: 'http', host: '127.0.0.1', port },
        confirmedByUserId: userId,
        confirmedAt: 1_714_438_400_000,
      },
    });

    await service.closeSessionPreviewForCleanup(sessionId, 'test cleanup');

    expect(response.success).toBe(true);
    expect(response.connection?.status).toBe('active');
    expect(setPreviewState).toHaveBeenCalledWith(
      expect.objectContaining({
        connection: expect.objectContaining({
          status: 'active',
          publicUrl: 'https://preview.example.com/mock-tunnel',
        }),
      })
    );
    expect(startPreviewTunnel).toHaveBeenCalledWith(
      expect.objectContaining({
        target: {
          protocol: 'http',
          host: '127.0.0.1',
          port,
        },
      })
    );
  });
});
