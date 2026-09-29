import { describe, expect, it, vi } from 'vitest';
import { Effect } from 'effect';
import {
  type LocalSessionControlRequest,
  type LocalSessionControlResponse,
  type MachineId,
  type SessionId,
} from '@lody/shared';
import { LodyFleet } from '../src/lib/lody-fleet';
import {
  CatalogPermissionError,
  type LocalWorkspaceCatalogService,
  type LocalWorkspaceCatalogSnapshot,
} from '../src/lib/local-workspace-catalog';
import type { Logger } from '../src/utils/logger';
import { createLocalCloudPort, type CloudPort } from '@lody/platform';

const createTestCloudPort = (
  watchWorkspaceAccess?: CloudPort['access']['watchWorkspaceAccess']
): CloudPort => {
  const local = createLocalCloudPort({ identity: { userId: 'user-1' }, workspaces: [] });
  return {
    ...local,
    kind: 'cloud',
    access: {
      ...local.access,
      watchWorkspaceAccess: watchWorkspaceAccess ?? local.access.watchWorkspaceAccess,
    },
    streamsTokens: {
      createTokenProvider: () => {
        throw new Error('not used by this Fleet unit test');
      },
    },
  };
};

const createSilentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  trace: () => {},
  setLevel: () => {},
  setDebug: () => {},
  child: () => createSilentLogger(),
  close: async () => {},
});

const createRuntimeStateReporter = () => ({
  setActiveSessionCount: vi.fn(),
  setConnectedRoomCount: vi.fn(),
  setConnectivity: vi.fn(),
  setBackendAuthorization: vi.fn(),
  setBackendConnection: vi.fn(),
  setConnectedWorkspaces: vi.fn(),
  upsertIssue: vi.fn(),
  clearIssue: vi.fn(),
});

const catalogSnapshot = (overrides: {
  identity?: LocalWorkspaceCatalogSnapshot['identity'];
  workspaces?: LocalWorkspaceCatalogSnapshot['workspaces'];
}): LocalWorkspaceCatalogSnapshot => ({
  version: 1,
  identity: overrides.identity !== undefined ? overrides.identity : { userId: 'user-1' },
  machine: { machineId: 'machine-1' },
  workspaces: overrides.workspaces ?? [],
  sessions: [],
});

const createCatalogStub = (
  read: LocalWorkspaceCatalogService['read']
): LocalWorkspaceCatalogService => ({
  read,
  listActiveWorkspaces: () => Effect.die('not used'),
  cacheRemoteWorkspaces: () => Effect.die('not used'),
  recordWorkspaceAccessSnapshot: () => Effect.die('not used'),
  upsertSession: () => Effect.die('not used'),
});

const createFleetHarness = (catalog: LocalWorkspaceCatalogService) => {
  const started: string[] = [];
  const runtimeStateReporter = createRuntimeStateReporter();
  const fleet = new LodyFleet({
    logger: createSilentLogger(),
    builtinAgentConfigCliTypes: [],
    cliToken: 'token',
    userId: 'user-1',
    machineId: 'machine-1' as MachineId,
    machineName: 'host',
    runtimeStateReporter: runtimeStateReporter as never,
    cloudPort: createTestCloudPort(),
    localWorkspaceCatalog: catalog,
    localFirstBootstrap: true,
    machineLifecycleCapability: {
      launchMode: 'foreground',
      canRemoteRestart: false,
      canRemoteUpgrade: false,
      reason: 'not_daemon',
    },
  }) as unknown as {
    bootstrapFromLocalCatalog: () => Promise<void>;
    startWorkspace: (workspace: { id: string }) => Promise<void>;
  };
  fleet.startWorkspace = async (workspace) => {
    started.push(workspace.id);
  };
  return { fleet, started, runtimeStateReporter };
};

const activeWorkspace = (
  workspaceId: string,
  name: string,
  slug: string | null,
  role: string
): LocalWorkspaceCatalogSnapshot['workspaces'][number] => ({
  workspaceId,
  name,
  slug,
  role,
  state: 'active',
  cachedAt: 1,
});

describe('LodyFleet local catalog bootstrap', () => {
  it('starts cached local workspaces before remote reconcile', async () => {
    const catalog = createCatalogStub(() =>
      Effect.succeed(
        catalogSnapshot({
          workspaces: [
            activeWorkspace('workspace-1', 'Alpha', 'alpha', 'owner'),
            activeWorkspace('workspace-2', 'Beta', null, 'member'),
            { ...activeWorkspace('workspace-3', 'Gone', null, 'member'), state: 'remote_missing' },
          ],
        })
      )
    );
    const { fleet, started } = createFleetHarness(catalog);

    await fleet.bootstrapFromLocalCatalog();

    // Only `active` entries boot; remote_missing ones stay parked.
    expect(started).toEqual(['workspace-1', 'workspace-2']);
  });

  it('starts independent cached workspaces concurrently', async () => {
    const catalog = createCatalogStub(() =>
      Effect.succeed(
        catalogSnapshot({
          workspaces: [
            activeWorkspace('workspace-1', 'Alpha', 'alpha', 'owner'),
            activeWorkspace('workspace-2', 'Beta', 'beta', 'member'),
          ],
        })
      )
    );
    const { fleet, started } = createFleetHarness(catalog);
    let releaseFirst: () => void = () => {};
    const firstWorkspaceGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    fleet.startWorkspace = async (workspace) => {
      started.push(workspace.id);
      if (workspace.id === 'workspace-1') {
        await firstWorkspaceGate;
      }
    };

    const bootstrap = fleet.bootstrapFromLocalCatalog();
    await vi.waitFor(() => {
      expect(started).toEqual(['workspace-1', 'workspace-2']);
    });
    releaseFirst();
    await bootstrap;
  });

  it('skips bootstrap when the catalog identity does not match the current user (F4)', async () => {
    // Account switch: the catalog on disk belongs to another login. None of its
    // cached workspaces may be booted for the current user.
    const catalog = createCatalogStub(() =>
      Effect.succeed(
        catalogSnapshot({
          identity: { userId: 'user-previous' },
          workspaces: [activeWorkspace('workspace-1', 'Alpha', 'alpha', 'owner')],
        })
      )
    );
    const { fleet, started } = createFleetHarness(catalog);

    await fleet.bootstrapFromLocalCatalog();

    expect(started).toEqual([]);
  });

  it('skips bootstrap when the catalog identity is missing (never reconciled)', async () => {
    const catalog = createCatalogStub(() =>
      Effect.succeed(
        catalogSnapshot({
          identity: null,
          workspaces: [activeWorkspace('workspace-1', 'Alpha', 'alpha', 'owner')],
        })
      )
    );
    const { fleet, started } = createFleetHarness(catalog);

    await fleet.bootstrapFromLocalCatalog();

    expect(started).toEqual([]);
  });

  it('does not crash the daemon when the catalog is unreadable (F6)', async () => {
    // Missing/corrupt catalogs self-recover inside read(); a permission error
    // does not — bootstrap must degrade to "no local-first bootstrap" instead
    // of failing fleet startup.
    const catalog = createCatalogStub(() =>
      Effect.fail(new CatalogPermissionError({ path: '/home/user/.lody/workspace-catalog.json' }))
    );
    const { fleet, started } = createFleetHarness(catalog);

    await expect(fleet.bootstrapFromLocalCatalog()).resolves.toBeUndefined();
    expect(started).toEqual([]);
  });

  it('reports each running workspace and its backend bridge connection', () => {
    const { fleet: fleetHarness, runtimeStateReporter } = createFleetHarness(
      createCatalogStub(() => Effect.succeed(catalogSnapshot({})))
    );
    const fleet = fleetHarness as unknown as {
      desiredWorkspaces: Map<string, { id: string }>;
      runtimes: Map<
        string,
        {
          workspace: { id: string; name: string; slug: string | null; role: string };
          lody: {
            isControlPlaneReady: () => boolean;
            isControlPlaneRecovering: () => boolean;
            isRemoteBridgeAttached: () => boolean;
            getActiveSessionCount: () => number;
            getConnectedRoomCount: () => number;
          };
        }
      >;
      refreshRuntimeState: () => void;
    };
    fleet.desiredWorkspaces.set('workspace-1', { id: 'workspace-1' });
    fleet.runtimes.set('workspace-1', {
      workspace: {
        id: 'workspace-1',
        name: 'Alpha',
        slug: 'alpha',
        role: 'owner',
      },
      lody: {
        isControlPlaneReady: () => true,
        isControlPlaneRecovering: () => false,
        isRemoteBridgeAttached: () => true,
        getActiveSessionCount: () => 0,
        getConnectedRoomCount: () => 2,
      },
    });

    fleet.refreshRuntimeState();

    expect(runtimeStateReporter.setConnectedWorkspaces).toHaveBeenLastCalledWith([
      {
        id: 'workspace-1',
        name: 'Alpha',
        slug: 'alpha',
        role: 'owner',
        backendConnection: 'connected',
      },
    ]);
  });
});

describe('LodyFleet remote authentication boundary', () => {
  it('rejects a valid token whose authoritative user differs from the cached identity', async () => {
    const onFatalAuthFailure = vi.fn();
    const fleet = new LodyFleet({
      logger: createSilentLogger(),
      builtinAgentConfigCliTypes: [],
      cliToken: 'token',
      userId: 'user-1',
      machineId: 'machine-1' as MachineId,
      machineName: 'host',
      runtimeStateReporter: createRuntimeStateReporter() as never,
      cloudPort: createTestCloudPort((onValue) => {
        onValue({ status: 'authorized', userId: 'user-2', workspaces: [] });
        return () => {};
      }),
      localWorkspaceCatalog: createCatalogStub(() => Effect.succeed(catalogSnapshot({}))),
      localFirstBootstrap: true,
      onFatalAuthFailure,
      machineLifecycleCapability: {
        launchMode: 'foreground',
        canRemoteRestart: false,
        canRemoteUpgrade: false,
        reason: 'not_daemon',
      },
    }) as unknown as {
      startWorkspaceSubscription: (options: { waitForInitial: boolean }) => Promise<void>;
    };

    await fleet.startWorkspaceSubscription({ waitForInitial: false });

    expect(onFatalAuthFailure).toHaveBeenCalledTimes(1);
    expect(onFatalAuthFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Remote CLI identity user-2 does not match cached identity user-1.',
      })
    );
  });

  it('reports a rejected backend authorization for an invalid token', async () => {
    const runtimeStateReporter = createRuntimeStateReporter();
    const onFatalAuthFailure = vi.fn();
    const fleet = new LodyFleet({
      logger: createSilentLogger(),
      builtinAgentConfigCliTypes: [],
      cliToken: 'token',
      userId: 'user-1',
      machineId: 'machine-1' as MachineId,
      machineName: 'host',
      runtimeStateReporter: runtimeStateReporter as never,
      cloudPort: createTestCloudPort((onValue) => {
        onValue({ status: 'unauthorized', reason: 'CLI token is invalid or expired.' });
        return () => {};
      }),
      localWorkspaceCatalog: createCatalogStub(() => Effect.succeed(catalogSnapshot({}))),
      localFirstBootstrap: true,
      onFatalAuthFailure,
      machineLifecycleCapability: {
        launchMode: 'foreground',
        canRemoteRestart: false,
        canRemoteUpgrade: false,
        reason: 'not_daemon',
      },
    }) as unknown as {
      startWorkspaceSubscription: (options: { waitForInitial: boolean }) => Promise<void>;
    };

    await fleet.startWorkspaceSubscription({ waitForInitial: false });

    expect(runtimeStateReporter.setBackendAuthorization).toHaveBeenCalledWith('rejected');
    expect(runtimeStateReporter.setBackendConnection).toHaveBeenCalledWith('disconnected');
    expect(onFatalAuthFailure).toHaveBeenCalledOnce();
  });
});

describe('LodyFleet local session control streaming', () => {
  type FleetControlInternals = {
    runtimes: Map<
      string,
      {
        lody: {
          documentManager: {
            repo: { getDocMeta: (roomId: string) => Promise<{ meta: {} } | undefined> };
          };
        };
      }
    >;
    dispatchLocalSessionControl: (
      message: LocalSessionControlRequest,
      options: { onResponse?: (response: LocalSessionControlResponse) => void }
    ) => Promise<LocalSessionControlResponse[]>;
  };

  const imageUploadRequest = (): LocalSessionControlRequest => ({
    type: 'session/image-upload',
    machineId: 'machine-1' as MachineId,
    sessionId: 'session-1' as SessionId,
    paths: ['/tmp/screenshot.png'],
  });

  const createControlFleet = (): FleetControlInternals =>
    createFleetHarness(createCatalogStub(() => Effect.succeed(catalogSnapshot({}))))
      .fleet as unknown as FleetControlInternals;

  it('streams the response when an upload session cannot be found', async () => {
    const fleet = createControlFleet();
    const onResponse = vi.fn();

    const responses = await fleet.dispatchLocalSessionControl(imageUploadRequest(), {
      onResponse,
    });

    expect(responses).toEqual([
      expect.objectContaining({ success: false, error: 'session_not_found' }),
    ]);
    expect(onResponse).toHaveBeenCalledOnce();
    expect(onResponse).toHaveBeenCalledWith(responses[0]);
  });

  it('streams the response when an upload session matches multiple workspaces', async () => {
    const fleet = createControlFleet();
    const runtime = {
      lody: {
        documentManager: {
          repo: { getDocMeta: vi.fn(async () => ({ meta: {} })) },
        },
      },
    };
    fleet.runtimes.set('workspace-1', runtime);
    fleet.runtimes.set('workspace-2', runtime);
    const onResponse = vi.fn();

    const responses = await fleet.dispatchLocalSessionControl(imageUploadRequest(), {
      onResponse,
    });

    expect(responses).toEqual([
      expect.objectContaining({ success: false, error: 'session_ambiguous' }),
    ]);
    expect(onResponse).toHaveBeenCalledOnce();
    expect(onResponse).toHaveBeenCalledWith(responses[0]);
  });
});
