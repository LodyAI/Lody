import { createLocalCloudPort, type CloudPort } from '@lody/platform';
import {
  type LocalSessionControlRequest,
  type LocalSessionControlResponse,
  type MachineId,
  type SessionId,
} from '@lody/shared';
import { Effect } from 'effect';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import { describe, expect, it, vi } from 'vitest';
import {
  CatalogPermissionError,
  makeLocalWorkspaceCatalog,
  type LocalWorkspaceCatalogService,
  type LocalWorkspaceCatalogSnapshot,
} from '../src/lib/local-workspace-catalog';
import { Lody } from '../src/lib/lody';
import { LodyFleet } from '../src/lib/lody-fleet';
import { RemoteBridge, type RemoteBridgeRuntime } from '../src/lib/remote-bridge';
import { fileLocksLegacy } from '../src/utils/file-lock';
import * as projectMeta from '../src/lib/local-project-meta';
import * as scheduleWorkspace from '../src/lib/schedules/schedule-workspace';
import { createCloudPrAssociationPort } from '../src/lib/cloud-pr-association';
import type { PrPollerWorkspaceHandle } from '../src/lib/pr-poller/pr-poller-workspace';
import type { Logger } from '../src/utils/logger';

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
      createTokenProviderLegacy: () => {
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

const createFleetHarness = (
  catalog: LocalWorkspaceCatalogService,
  cloudPort = createTestCloudPort()
) => {
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
    cloudPort,
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
  it('reconciles ordinary starts and revocations through a failed encrypted sidecar, then repairs with unchanged remote input', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fleet-e2ee-cache-reconcile-'));
    const filePath = join(directory, 'workspace-catalog.json');
    const sidecar = `${filePath}.e2ee`;
    const catalog = makeLocalWorkspaceCatalog({
      filePath,
      lockName: `cache-${basename(directory)}`,
      cacheTtlMs: 0,
    });
    const ordinary = { id: 'ordinary', name: 'Ordinary', slug: null, role: 'owner' };
    const removed = { id: 'removed', name: 'Removed', slug: null, role: 'owner' };
    const encrypted = {
      id: 'encrypted',
      name: 'Encrypted',
      slug: null,
      role: 'owner',
      contentMode: 'e2ee',
      genesisHash: 'ab'.repeat(32),
    };
    const identity = { userId: 'user-1' };
    const machine = { machineId: 'machine-1', machineName: 'host' };
    await fileLocksLegacy.runPromise(
      catalog.cacheRemoteWorkspaces({ identity, machine, workspaces: [removed, encrypted] })
    );
    const healthy = await readFile(sidecar, 'utf8');
    const damaged = '{preserve damaged encrypted discovery';
    await writeFile(sidecar, damaged);
    const harness = createFleetHarness(catalog);
    const events: string[] = [];
    const issues = new Set<string>();
    harness.runtimeStateReporter.upsertIssue.mockImplementation((issue) => {
      issues.add(issue.code);
    });
    harness.runtimeStateReporter.clearIssue.mockImplementation((code) => {
      issues.delete(code);
    });
    const state = (workspace: typeof ordinary) => {
      let attached = false;
      return {
        workspace,
        lody: {
          isControlPlaneReady: () => true,
          isControlPlaneRecovering: () => false,
          isRemoteBridgeAttached: () => attached,
          getActiveSessionCount: () => 0,
          getConnectedRoomCount: () => 0,
          attachRemoteBridge: async () => {
            attached = true;
            events.push(`${workspace.id}:attach`);
          },
          detachRemoteBridge: async () => {
            attached = false;
          },
          handleRemoteAccessRevoked: async () => {
            attached = false;
            events.push(`${workspace.id}:revoked`);
          },
        },
      };
    };
    const fleet = harness.fleet as unknown as {
      runtimes: Map<string, ReturnType<typeof state>>;
      waitingForPairing: Set<string>;
      remoteBridge: RemoteBridge;
      startWorkspace(workspace: typeof ordinary & { contentMode?: string }): Promise<void>;
      applyRemoteWorkspaceList(input: unknown): Promise<void>;
      lastCachedWorkspaceSignature: string | null;
      lastValidWorkspaceListResult: unknown;
      reconcileRetryTimer: ReturnType<typeof setTimeout> | null;
      clearReconcileRetry(): void;
    };
    fleet.runtimes.set(removed.id, state(removed));
    fleet.startWorkspace = async (workspace) => {
      if (workspace.contentMode === 'e2ee') {
        fleet.waitingForPairing.add(workspace.id);
        return;
      }
      events.push(`${workspace.id}:start`);
      fleet.runtimes.set(workspace.id, state(workspace));
    };
    fleet.remoteBridge = new RemoteBridge({
      logger: createSilentLogger(),
      catalog,
      userId: 'user-1',
      machineId: 'machine-1' as MachineId,
      machineName: 'host',
      getRuntime: (id) => fleet.runtimes.get(id)?.lody as RemoteBridgeRuntime | undefined,
    });
    const remote = { status: 'authorized', userId: 'user-1', workspaces: [ordinary, encrypted] };
    fleet.lastValidWorkspaceListResult = remote;
    try {
      await fleet.applyRemoteWorkspaceList(remote);
      expect(events).toEqual(['removed:revoked', 'ordinary:start', 'ordinary:attach']);
      expect(issues.has('encrypted_workspace_catalog_unavailable')).toBe(true);
      expect(fleet.lastCachedWorkspaceSignature).toBeNull();
      expect(fleet.reconcileRetryTimer).not.toBeNull();
      // Cancel the real scheduled retry synchronously; drive its same entry
      // explicitly after repair, without faking the native Effect scheduler.
      fleet.clearReconcileRetry();
      expect(await readFile(sidecar, 'utf8')).toBe(damaged);
      expect(
        (
          await fileLocksLegacy.runPromise(makeLocalWorkspaceCatalog({ filePath }).read())
        ).workspaces.map((workspace) => workspace.workspaceId)
      ).toEqual(['ordinary', 'removed']);
      await writeFile(sidecar, healthy);
      await fleet.applyRemoteWorkspaceList(remote);
      expect(issues.has('encrypted_workspace_catalog_unavailable')).toBe(false);
      expect(fleet.lastCachedWorkspaceSignature).not.toBeNull();
      expect(fleet.reconcileRetryTimer).toBeNull();
      expect(
        (
          await fileLocksLegacy.runPromise(makeLocalWorkspaceCatalog({ filePath }).read())
        ).workspaces.map((workspace) => workspace.workspaceId)
      ).toEqual(['ordinary', 'removed', 'encrypted']);
    } finally {
      fleet.clearReconcileRetry();
      fleet.remoteBridge.shutdown();
      vi.useRealTimers();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('starts ordinary offline rows and clears its scoped issue after the encrypted index recovers', async () => {
    let broken = true;
    const original = new CatalogPermissionError({
      path: '/synthetic/workspace-catalog.json.e2ee',
      cause: new Error('synthetic EACCES'),
    });
    const { fleet, started, runtimeStateReporter } = createFleetHarness(
      createCatalogStub(() =>
        Effect.succeed({
          ...catalogSnapshot({
            workspaces: [activeWorkspace('ordinary', 'Ordinary', null, 'owner')],
          }),
          ...(broken ? { encryptedCatalogError: original } : {}),
        })
      )
    );
    const issues = new Set<string>();
    runtimeStateReporter.upsertIssue.mockImplementation((issue) => {
      issues.add(issue.code);
    });
    runtimeStateReporter.clearIssue.mockImplementation((code) => {
      issues.delete(code);
    });
    await fleet.bootstrapFromLocalCatalog();
    expect(started).toEqual(['ordinary']);
    expect(issues.has('encrypted_workspace_catalog_unavailable')).toBe(true);
    broken = false;
    await fleet.bootstrapFromLocalCatalog();
    expect(issues.has('encrypted_workspace_catalog_unavailable')).toBe(false);
  });

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

  it('gives daemon commands the bootstrap cache, then the live subscription, as their access verdict', async () => {
    vi.useFakeTimers();
    let push: (
      snapshot: Parameters<Parameters<CloudPort['access']['watchWorkspaceAccess']>[0]>[0]
    ) => void = () => {};
    let fail: (error: Error) => void = () => {};
    const { fleet: harness } = createFleetHarness(
      createCatalogStub(() =>
        Effect.succeed(
          catalogSnapshot({ workspaces: [activeWorkspace('ws-1', 'One', 'one', 'member')] })
        )
      ),
      createTestCloudPort((onValue, onError) => {
        push = onValue;
        fail = onError;
        return () => {};
      })
    );
    const fleet = harness as unknown as typeof harness & {
      startWorkspaceSubscription: (options: { waitForInitial: boolean }) => Promise<void>;
      applyRemoteWorkspaceList: () => Promise<void>;
      readWorkspaceAccess: (workspaceId: string) => unknown;
    };
    fleet.applyRemoteWorkspaceList = async () => {};
    const remote = {
      id: 'ws-1',
      name: 'One',
      slug: 'one',
      role: 'admin',
      contentMode: 'e2ee',
      genesisHash: 'ab'.repeat(32),
    };
    try {
      expect(fleet.readWorkspaceAccess('ws-1')).toEqual({ status: 'unknown' });
      await fleet.bootstrapFromLocalCatalog();
      expect(fleet.readWorkspaceAccess('ws-1')).toEqual({
        status: 'authorized',
        workspace: { id: 'ws-1', name: 'One', slug: 'one', role: 'member' },
      });
      expect(fleet.readWorkspaceAccess('ws-2')).toEqual({ status: 'unknown' });

      await fleet.startWorkspaceSubscription({ waitForInitial: false });
      push({ status: 'authorized', userId: 'user-1', workspaces: [remote] });
      expect(fleet.readWorkspaceAccess('ws-1')).toEqual({
        status: 'authorized',
        workspace: remote,
      });
      // An unreachable control plane is not a revocation.
      fail(new Error('Synthetic subscription outage'));
      expect(fleet.readWorkspaceAccess('ws-1')).toEqual({
        status: 'authorized',
        workspace: remote,
      });
      push({ status: 'authorized', userId: 'user-1', workspaces: [] });
      expect(fleet.readWorkspaceAccess('ws-1')).toEqual({ status: 'revoked' });
      push({ status: 'authorized', userId: 'user-1', workspaces: [remote] });
      expect(fleet.readWorkspaceAccess('ws-1')).toEqual({
        status: 'authorized',
        workspace: remote,
      });
      push({ status: 'unauthorized', reason: 'CLI token is invalid or expired.' });
      expect(fleet.readWorkspaceAccess('ws-1')).toEqual({ status: 'unauthorized' });
    } finally {
      vi.useRealTimers();
    }
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

it('retains the failed workspace owner and retries only its unresolved cleanup phase', async () => {
  const catalog = createCatalogStub(() => Effect.succeed(catalogSnapshot({})));
  const fleet = createFleetHarness(catalog).fleet as unknown as {
    runtimes: Map<string, unknown>;
    cleanupOwners: Map<string, unknown>;
    stopWorkspace(id: string): Promise<void>;
    retryWorkspaceCleanup(id: string): Promise<void>;
  };
  const steps: string[] = [];
  let failed = true;
  let released = false;
  const state = {
    workspace: { id: 'retained' },
    schedules: {
      dispose: async () => {
        steps.push('schedules released');
      },
    },
    lody: {
      cleanup: async () => {
        if (failed) {
          steps.push('resource release failed');
          throw new Error('retained raw request');
        }
        released = true;
        steps.push('resource released');
      },
    },
    unsubscribeTerminalCleanup: () => {},
    prPollerWorkspace: {
      dispose: async () => {
        steps.push('poller released');
      },
    },
  };
  fleet.runtimes.set('retained', state);
  await expect(fleet.stopWorkspace('retained')).rejects.toThrow('retained raw request');
  expect(fleet.runtimes.get('retained')).toBe(state);
  expect(fleet.cleanupOwners.get('retained')).toBe(state);
  expect(released).toBe(false);
  await expect(fleet.stopWorkspace('retained')).rejects.toThrow('retained raw request');
  expect(steps).toEqual(['schedules released', 'resource release failed']);
  failed = false;
  await fleet.retryWorkspaceCleanup('retained');
  expect(released).toBe(true);
  expect(fleet.runtimes.has('retained')).toBe(false);
  expect(fleet.cleanupOwners.has('retained')).toBe(false);
  expect(steps).toEqual([
    'schedules released',
    'resource release failed',
    'resource released',
    'poller released',
  ]);
});

it('production startup retry recovers the retained owner before attempting another workspace', async () => {
  vi.useFakeTimers();
  const trace: string[] = [];
  let releaseFails = true;
  const create = vi.spyOn(Lody, 'create').mockImplementation(async () => {
    trace.push('create');
    if (trace.filter((step) => step === 'create').length > 1)
      throw new Error('next startup reached');
    return {
      start: async () => {
        trace.push('start failed');
        throw new Error('startup failed');
      },
      cleanup: async () => {
        trace.push(releaseFails ? 'release failed' : 'released');
        if (releaseFails) throw new Error('temporary release failure');
      },
    } as never;
  });
  const fleet = createFleetHarness(createCatalogStub(() => Effect.succeed(catalogSnapshot({}))))
    .fleet as unknown as {
    desiredWorkspaces: Map<string, unknown>;
    startupCleanupOwners: Map<string, unknown>;
    retryTimers: Map<string, ReturnType<typeof setTimeout>>;
    startWorkspace(workspace: never): Promise<void>;
    stopped: boolean;
  };
  // This harness normally replaces startup; restore the production entry.
  delete (fleet as unknown as { startWorkspace?: unknown }).startWorkspace;
  const workspace = { id: 'recovery', name: 'Recovery', slug: 'recovery', role: 'owner' };
  fleet.desiredWorkspaces.set(workspace.id, workspace);
  try {
    await fleet.startWorkspace(workspace as never);
    expect(fleet.startupCleanupOwners.has(workspace.id)).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(trace).toEqual(['create', 'start failed', 'release failed', 'release failed']);
    releaseFails = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(trace).toEqual([
      'create',
      'start failed',
      'release failed',
      'release failed',
      'released',
      'create',
    ]);
    expect(fleet.startupCleanupOwners.has(workspace.id)).toBe(false);
  } finally {
    fleet.stopped = true;
    for (const timer of fleet.retryTimers.values()) clearTimeout(timer);
    create.mockRestore();
    vi.useRealTimers();
  }
});

it.each(['e2ee_pairing_required', 'e2ee_storage_failed'])(
  'treats %s as waiting only for the exact pairing condition',
  async (reason) => {
    vi.useFakeTimers();
    const create = vi.spyOn(Lody, 'create').mockRejectedValue(new Error(reason));
    const harness = createFleetHarness(
      createCatalogStub(() => Effect.succeed(catalogSnapshot({})))
    );
    const fleet = harness.fleet as unknown as {
      desiredWorkspaces: Map<string, unknown>;
      retryTimers: Map<string, ReturnType<typeof setTimeout>>;
      startWorkspace(workspace: never): Promise<void>;
      stopped: boolean;
    };
    delete (fleet as unknown as { startWorkspace?: unknown }).startWorkspace;
    const workspace = {
      id: 'waiting',
      name: 'Waiting',
      slug: null,
      role: 'owner',
      contentMode: 'e2ee',
    };
    fleet.desiredWorkspaces.set(workspace.id, workspace);
    try {
      await fleet.startWorkspace(workspace as never);
      const waiting = reason === 'e2ee_pairing_required';
      expect(fleet.retryTimers.has(workspace.id)).toBe(!waiting);
      expect(
        harness.runtimeStateReporter.upsertIssue.mock.calls.some(
          ([issue]) => issue.code === `workspace_start_failed:${workspace.id}`
        )
      ).toBe(!waiting);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fleet.retryTimers.has(workspace.id)).toBe(!waiting);
      // Explicit activation can call the same start entry again; waiting isn't a fence.
      if (waiting) {
        create.mockRejectedValue(new Error('e2ee_storage_failed'));
        await fleet.startWorkspace(workspace as never);
        expect(fleet.retryTimers.has(workspace.id)).toBe(true);
      }
    } finally {
      fleet.stopped = true;
      for (const timer of fleet.retryTimers.values()) clearTimeout(timer);
      create.mockRestore();
      vi.useRealTimers();
    }
  }
);

it('waits silently for pairing when an activated machine has lost its custody', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fleet-e2ee-custody-loss-'));
  vi.stubEnv('LODY_DATA_DIR', directory);
  const { openCliE2eeWorkspaceLegacy } = await import('../src/lib/e2ee/workspace-legacy');
  const workspace = {
    id: 'lost-custody',
    name: 'Lost custody',
    slug: null,
    role: 'owner',
    contentMode: 'e2ee',
    genesisHash: 'ab'.repeat(32),
  };
  const root = join(
    getLodyDataDir(),
    'e2ee',
    createHash('sha256').update('user-1').digest('hex'),
    workspace.id
  );
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, 'binding.json'),
    JSON.stringify({
      workspaceId: workspace.id,
      genesisHash: workspace.genesisHash,
      genesisRecordHex: 'aa',
    })
  );
  await writeFile(
    join(root, 'activation.json'),
    JSON.stringify({ genesisHash: workspace.genesisHash, signingPublicKey: 'cd'.repeat(32) })
  );
  const create = vi.spyOn(Lody, 'create').mockImplementation(async () => {
    await openCliE2eeWorkspaceLegacy({
      accountId: 'user-1',
      workspaceId: workspace.id,
      genesisHash: workspace.genesisHash,
      cloud: {} as never,
      onUnavailable: () => {},
      keyring: async () => {
        throw new Error('missing custody must not probe the keyring');
      },
    });
    throw new Error('missing original must not open a runtime');
  });
  const harness = createFleetHarness(createCatalogStub(() => Effect.succeed(catalogSnapshot({}))));
  const issues = new Set<string>();
  harness.runtimeStateReporter.upsertIssue.mockImplementation((issue) => {
    issues.add(issue.code);
  });
  harness.runtimeStateReporter.clearIssue.mockImplementation((code) => {
    issues.delete(code);
  });
  const fleet = harness.fleet as unknown as {
    desiredWorkspaces: Map<string, unknown>;
    retryTimers: Map<string, ReturnType<typeof setTimeout>>;
    waitingForPairing: Set<string>;
    startWorkspace(workspace: never): Promise<void>;
    stopped: boolean;
  };
  delete (fleet as unknown as { startWorkspace?: unknown }).startWorkspace;
  fleet.desiredWorkspaces.set(workspace.id, workspace);
  vi.useFakeTimers();
  try {
    await fleet.startWorkspace(workspace as never);
    expect(fleet.waitingForPairing.has(workspace.id)).toBe(true);
    expect(fleet.retryTimers.size).toBe(0);
    expect(issues.has(`workspace_start_failed:${workspace.id}`)).toBe(false);
    expect(issues.has('workspace_runtime_retrying')).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fleet.retryTimers.size).toBe(0);
    await expect(stat(join(root, 'custody'))).rejects.toHaveProperty('code', 'ENOENT');
  } finally {
    fleet.stopped = true;
    create.mockRestore();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(['EMFILE', 'EACCES'])(
  'retries an encrypted workspace after %s clears without requiring activation',
  async (code) => {
    vi.useFakeTimers();
    const failure = Object.assign(new Error('synthetic file open failure'), { code });
    let unavailable = true;
    const lody = {
      start: async () => {},
      cleanup: async () => {},
      documentManager: { repo: {} },
      onSessionTerminated: () => () => {},
      isControlPlaneReady: () => true,
      isControlPlaneRecovering: () => false,
      isRemoteBridgeAttached: () => false,
      getActiveSessionCount: () => 0,
      getConnectedRoomCount: () => 0,
    };
    const create = vi.spyOn(Lody, 'create').mockImplementation(async () => {
      if (unavailable) throw failure;
      return lody as never;
    });
    const reconcile = vi
      .spyOn(projectMeta, 'reconcileMachineLocalProjectRootPaths')
      .mockResolvedValue(undefined);
    const harness = createFleetHarness(
      createCatalogStub(() => Effect.succeed(catalogSnapshot({})))
    );
    const fleet = harness.fleet as unknown as {
      desiredWorkspaces: Map<string, unknown>;
      runtimes: Map<string, { lody: unknown }>;
      waitingForPairing: Set<string>;
      retryTimers: Map<string, ReturnType<typeof setTimeout>>;
      startWorkspace(workspace: never): Promise<void>;
      stopWorkspace(id: string): Promise<void>;
      stopped: boolean;
    };
    delete (fleet as unknown as { startWorkspace?: unknown }).startWorkspace;
    const workspace = {
      id: 'file-recovery',
      name: 'File recovery',
      slug: null,
      role: 'owner',
      contentMode: 'e2ee',
    };
    fleet.desiredWorkspaces.set(workspace.id, workspace);
    try {
      await fleet.startWorkspace(workspace as never);
      expect(fleet.runtimes.has(workspace.id)).toBe(false);
      expect(fleet.waitingForPairing.has(workspace.id)).toBe(false);
      expect(fleet.retryTimers.has(workspace.id)).toBe(true);
      unavailable = false;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fleet.runtimes.get(workspace.id)?.lody).toBe(lody);
      expect(fleet.waitingForPairing.has(workspace.id)).toBe(false);
      expect(fleet.retryTimers.has(workspace.id)).toBe(false);
      await fleet.stopWorkspace(workspace.id);
      expect(fleet.runtimes.has(workspace.id)).toBe(false);
    } finally {
      fleet.stopped = true;
      for (const timer of fleet.retryTimers.values()) clearTimeout(timer);
      create.mockRestore();
      reconcile.mockRestore();
      vi.useRealTimers();
    }
  }
);

describe('Fleet PR observation composition', () => {
  it.each([undefined, 'plaintext', 'e2ee'] as const)(
    'keeps hosted PR metadata out of %s encrypted composition while ordinary PR linkage still works',
    async (contentMode) => {
      const encrypted = contentMode === 'e2ee';
      const requests: unknown[] = [];
      const cloud = createTestCloudPort();
      const association = createCloudPrAssociationPort({
        token: 'synthetic-token',
        authSiteUrl: 'https://synthetic.invalid',
        logger: createSilentLogger(),
        fetch: async (_url, init) => {
          requests.push(JSON.parse(String(init?.body)));
          return new Response('{}', { status: 200 });
        },
      });
      Object.defineProperties(cloud, {
        githubTokens: {
          get: () => {
            if (encrypted)
              throw new Error('encrypted metadata must not acquire hosted credentials');
            return null;
          },
        },
        prAssociation: {
          get: () => {
            if (encrypted) throw new Error('encrypted metadata must not acquire hosted linkage');
            return association;
          },
        },
      });
      const create = vi.spyOn(Lody, 'create').mockResolvedValue({
        start: async () => {},
        cleanup: async () => {},
        documentManager: { repo: {} },
        onSessionTerminated: () => () => {},
        isControlPlaneReady: () => true,
        isControlPlaneRecovering: () => false,
        isRemoteBridgeAttached: () => false,
        getActiveSessionCount: () => 0,
        getConnectedRoomCount: () => 0,
      } as never);
      const reconcile = vi
        .spyOn(projectMeta, 'reconcileMachineLocalProjectRootPaths')
        .mockResolvedValue(undefined);
      const schedules = vi.spyOn(scheduleWorkspace, 'createScheduleWorkspace').mockResolvedValue({
        evaluate: async () => {},
        dispose: async () => {},
      });
      const fleet = createFleetHarness(
        createCatalogStub(() => Effect.succeed(catalogSnapshot({}))),
        cloud
      ).fleet as unknown as {
        desiredWorkspaces: Map<string, unknown>;
        runtimes: Map<string, { prPollerWorkspace: PrPollerWorkspaceHandle | null }>;
        retryTimers: Map<string, ReturnType<typeof setTimeout>>;
        startWorkspace(workspace: never): Promise<void>;
        stopWorkspace(id: string): Promise<void>;
        remoteBridge: null;
        stopped: boolean;
      };
      // Exercise the production Fleet startup/cleanup, rather than only a
      // helper's policy or the sanitized cloud port inside Lody.create.
      delete (fleet as unknown as { startWorkspace?: unknown }).startWorkspace;
      fleet.remoteBridge = null;
      const workspace = {
        id: 'metadata-boundary',
        name: 'Synthetic',
        slug: null,
        role: 'owner',
        ...(contentMode ? { contentMode } : {}),
      };
      fleet.desiredWorkspaces.set(workspace.id, workspace);
      try {
        await fleet.startWorkspace(workspace as never);
        const runtime = fleet.runtimes.get(workspace.id);
        expect(runtime).toBeDefined();
        if (encrypted) {
          expect(runtime?.prPollerWorkspace).toBeNull();
          expect(requests).toEqual([]);
        } else {
          expect(
            await runtime?.prPollerWorkspace?.associatePullRequest?.({
              repoFullName: 'synthetic/repo',
              branch: 'synthetic-branch',
              prNumber: 1,
              prUrl: 'https://github.com/synthetic/repo/pull/1',
              status: 'open',
              ownerSessionId: 'synthetic-session' as SessionId,
            })
          ).toBe(true);
          expect(requests).toEqual([
            expect.objectContaining({
              path: 'github:associatePullRequestForCli',
              args: expect.objectContaining({
                repoFullName: 'synthetic/repo',
                branch: 'synthetic-branch',
              }),
            }),
          ]);
        }
        await fleet.stopWorkspace(workspace.id);
        expect(fleet.runtimes.has(workspace.id)).toBe(false);
      } finally {
        fleet.stopped = true;
        for (const timer of fleet.retryTimers.values()) clearTimeout(timer);
        create.mockRestore();
        reconcile.mockRestore();
        schedules.mockRestore();
      }
    }
  );
});

it('joins background project observation before closing its workspace document', async () => {
  const fleet = createFleetHarness(createCatalogStub(() => Effect.succeed(catalogSnapshot({}))))
    .fleet as unknown as {
    runtimes: Map<string, unknown>;
    stopWorkspace(id: string): Promise<void>;
  };
  const stop = new AbortController();
  const interrupted = Promise.withResolvers<void>();
  const observed = Promise.withResolvers<void>();
  stop.signal.addEventListener('abort', () => interrupted.resolve(), { once: true });
  const steps: string[] = [];
  fleet.runtimes.set('observing', {
    workspace: { id: 'observing' },
    localProjectReconciliation: { stop, done: observed.promise },
    schedules: {
      dispose: async () => {
        steps.push('schedules');
      },
    },
    lody: {
      cleanup: async () => {
        steps.push('document');
      },
    },
    unsubscribeTerminalCleanup: () => {},
    prPollerWorkspace: {
      dispose: async () => {
        steps.push('poller');
      },
    },
  });
  const closing = fleet.stopWorkspace('observing');
  await interrupted.promise;
  expect(steps).toEqual([]);
  observed.resolve();
  await closing;
  expect(steps).toEqual(['schedules', 'document', 'poller']);
  expect(fleet.runtimes.has('observing')).toBe(false);
});

it('starts only the scoped encrypted workspace without a legacy Streams bridge or account catalog rewrite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fleet-paired-service-'));
  const filePath = join(directory, 'catalog.json');
  const catalog = makeLocalWorkspaceCatalog({
    filePath,
    lockName: `paired-${basename(directory)}`,
    cacheTtlMs: 0,
  });
  try {
    await fileLocksLegacy.runPromise(
      catalog.cacheRemoteWorkspaces({
        identity: { userId: 'user-1' },
        machine: { machineId: 'machine-1', machineName: 'host' },
        workspaces: [{ id: 'ordinary', name: 'Ordinary', slug: null, role: 'owner' }],
      })
    );
    const original = await readFile(filePath, 'utf8');
    const workspace = {
      id: 'paired',
      name: 'Encrypted',
      slug: null,
      role: 'member',
      contentMode: 'e2ee',
      genesisHash: 'ab'.repeat(32),
    };
    const base = createLocalCloudPort({ identity: { userId: 'user-1' }, workspaces: [] });
    const cloud: CloudPort = {
      ...base,
      kind: 'cloud',
      e2eeMachineScope: { workspaceId: workspace.id, genesisHash: workspace.genesisHash },
      e2ee: {
        getHistory: async () => {
          throw new Error('unused');
        },
        getContentToken: async () => {
          throw new Error('unused');
        },
        mailboxCall: async () => {
          throw new Error('unused');
        },
      },
    };
    const { fleet, started } = createFleetHarness(catalog, cloud);
    const native = fleet as unknown as {
      applyRemoteWorkspaceList(input: {
        status: 'authorized';
        userId: string;
        workspaces: (typeof workspace)[];
      }): Promise<void>;
      desiredWorkspaces: Map<string, unknown>;
      startWorkspace(item: typeof workspace): Promise<void>;
      runtimes: Map<string, unknown>;
      remoteBridge: RemoteBridge;
    };
    let attached = false;
    native.startWorkspace = async (item) => {
      started.push(item.id);
      native.runtimes.set(item.id, {
        workspace: item,
        lody: {
          attachRemoteBridge: async () => {
            attached = true;
          },
          detachRemoteBridge: async () => {
            attached = false;
          },
          handleRemoteAccessRevoked: async () => {
            attached = false;
          },
          isRemoteBridgeAttached: () => attached,
          isControlPlaneReady: () => attached,
          isControlPlaneRecovering: () => false,
          getActiveSessionCount: () => 0,
          getConnectedRoomCount: () => (attached ? 1 : 0),
        },
      });
    };
    await native.applyRemoteWorkspaceList({
      status: 'authorized',
      userId: 'user-1',
      workspaces: [workspace],
    });
    expect([...native.desiredWorkspaces.keys()]).toEqual(['paired']);
    expect(started).toEqual(['paired']);
    expect(attached).toBe(true);
    expect(await readFile(filePath, 'utf8')).toBe(original);
    for (const changed of [
      { ...workspace, id: 'other' },
      { ...workspace, contentMode: 'plaintext' },
      { ...workspace, genesisHash: 'cd'.repeat(32) },
    ]) {
      await expect(
        native.applyRemoteWorkspaceList({
          status: 'authorized',
          userId: 'user-1',
          workspaces: [changed],
        })
      ).rejects.toThrow('scope mismatch');
      expect([...native.desiredWorkspaces.keys()]).toEqual(['paired']);
    }
    await native.remoteBridge.markOffline(
      [...native.runtimes.values()].map((value) => (value as { lody: RemoteBridgeRuntime }).lody)
    );
    expect(attached).toBe(false);
    native.remoteBridge.shutdown();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
