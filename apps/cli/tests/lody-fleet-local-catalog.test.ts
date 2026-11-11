import type { AuthorityStamp } from '../src/lib/e2ee/authority-clock';
import { createLocalCloudPort, type CloudPort } from '@lody/platform';
import {
  machineFlockKeys,
  type AgentConfigId,
  type LocalSessionControlRequest,
  type LocalSessionControlResponse,
  type MachineId,
  type SessionId,
} from '@lody/shared';
import { Effect } from 'effect';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs, { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
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
import { assertRetainedE2eeModeAllowsOpen } from '../src/lib/e2ee/retained-binding';
import { RemoteBridge, type RemoteBridgeRuntime } from '../src/lib/remote-bridge';
import { fileLocksLegacy } from '../src/utils/file-lock';
import * as projectMeta from '../src/lib/local-project-meta';
import * as scheduleWorkspace from '../src/lib/schedules/schedule-workspace';
import * as automationWorkspace from '../src/automations/workspace-legacy';
import { createCloudPrAssociationPort } from '../src/lib/cloud-pr-association';
import type { PrPollerWorkspaceHandle } from '../src/lib/pr-poller/pr-poller-workspace';
import type { Logger } from '../src/utils/logger';

// Injects transient I/O failures into retained pairing binding reads only.
const bindingReadFault = vi.hoisted(() => ({ code: null as string | null }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const openSync = ((path: Parameters<typeof actual.openSync>[0], ...rest: unknown[]) => {
    if (bindingReadFault.code && String(path).endsWith('binding.json'))
      throw Object.assign(new Error(`synthetic ${bindingReadFault.code}`), {
        code: bindingReadFault.code,
      });
    return (actual.openSync as (...args: unknown[]) => number)(path, ...rest);
  }) as typeof actual.openSync;
  return { ...actual, default: { ...actual, openSync }, openSync };
});

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
  setE2eeAccessWindow: vi.fn(),
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
  it.each([false, true])(
    'rebuilds corrupt discovery while ordinary starts and revocations survive a publication failure (%s)',
    async (failPublication) => {
      const directory = await mkdtemp(join(tmpdir(), 'fleet-e2ee-cache-reconcile-'));
      const originalLocksDir = process.env.LODY_LOCKS_DIR;
      process.env.LODY_LOCKS_DIR = join(directory, 'locks');
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
      const damaged = '{preserve damaged encrypted discovery';
      await writeFile(sidecar, damaged);
      let publicationBlocked = failPublication;
      const rename = fs.rename;
      const fault = Object.assign(new Error('synthetic encrypted publication EACCES'), {
        code: 'EACCES',
      });
      const renameSpy = vi
        .spyOn(fs, 'rename')
        .mockImplementation((source, target) =>
          publicationBlocked && target === sidecar ? Promise.reject(fault) : rename(source, target)
        );
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
        if (failPublication) {
          expect(issues.has('encrypted_workspace_catalog_unavailable')).toBe(true);
          expect(fleet.lastCachedWorkspaceSignature).toBeNull();
          expect(fleet.reconcileRetryTimer).not.toBeNull();
          fleet.clearReconcileRetry();
          await expect(stat(sidecar)).rejects.toMatchObject({ code: 'ENOENT' });
          const cold = await fileLocksLegacy.runPromise(
            makeLocalWorkspaceCatalog({ filePath }).read()
          );
          expect(cold.encryptedCatalogUnavailable).toBe(true);
          expect(cold.workspaces.map((workspace) => workspace.workspaceId)).toEqual([
            'ordinary',
            'removed',
          ]);
          publicationBlocked = false;
          await fleet.applyRemoteWorkspaceList(remote);
        }
        const archives = (await readdir(directory)).filter((entry) =>
          entry.startsWith('workspace-catalog.json.e2ee.corrupt-')
        );
        expect(archives).toHaveLength(1);
        expect(await readFile(join(directory, archives[0] ?? ''), 'utf8')).toBe(damaged);
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
        renameSpy.mockRestore();
        if (originalLocksDir === undefined) delete process.env.LODY_LOCKS_DIR;
        else process.env.LODY_LOCKS_DIR = originalLocksDir;
        vi.useRealTimers();
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

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

  describe('workspace subscription errors', () => {
    const offlineHarness = async () => {
      vi.useFakeTimers();
      let fail: (error: Error) => void = () => {};
      let push: (
        snapshot: Parameters<Parameters<CloudPort['access']['watchWorkspaceAccess']>[0]>[0]
      ) => void = () => {};
      const { fleet: harness } = createFleetHarness(
        createCatalogStub(() => Effect.succeed(catalogSnapshot({}))),
        createTestCloudPort((onValue, onError) => {
          push = onValue;
          fail = onError;
          return () => {};
        })
      );
      const fleet = harness as unknown as {
        startWorkspaceSubscription: (options: { waitForInitial: boolean }) => Promise<void>;
        applyRemoteWorkspaceList: () => Promise<void>;
        runtimes: Map<string, unknown>;
        refreshRuntimeState: () => void;
        remoteBridge: unknown;
        confirmEncryptedAuthority: (workspaceId: string, startedAt: AuthorityStamp) => void;
        authorityClock: () => AuthorityStamp;
      };
      // Tests move the wall clock alone through this source; fake timers drive both.
      const clocks = { wallOffset: 0 };
      fleet.authorityClock = () => ({
        wall: Date.now() + clocks.wallOffset,
        monotonic: BigInt(Date.now()) * 1_000_000n,
      });
      fleet.applyRemoteWorkspaceList = async () => {};
      const detached: string[] = [];
      const attached: string[] = [];
      const revoked: string[] = [];
      const runtime = (id: string, contentMode: string) => ({
        workspace: { id, contentMode },
        lody: {
          detachRemoteBridge: async () => {
            detached.push(id);
          },
          attachRemoteBridge: async () => {
            attached.push(id);
          },
          handleRemoteAccessRevoked: async () => {
            revoked.push(id);
          },
        },
      });
      fleet.refreshRuntimeState = () => {};
      fleet.runtimes.set('encrypted', runtime('encrypted', 'e2ee'));
      fleet.runtimes.set('plain', runtime('plain', 'plaintext'));
      fleet.remoteBridge = new RemoteBridge({
        logger: createSilentLogger(),
        catalog: {} as never,
        userId: 'user-1',
        machineId: 'machine-1' as MachineId,
        machineName: 'host',
        getRuntime: (id) => (fleet.runtimes.get(id) as { lody: never } | undefined)?.lody,
      });
      await fleet.startWorkspaceSubscription({ waitForInitial: false });
      push({ status: 'authorized', userId: 'user-1', workspaces: [] });
      return {
        detached,
        attached,
        revoked,
        fail,
        clocks,
        confirm: () => fleet.confirmEncryptedAuthority('encrypted', fleet.authorityClock()),
        listRecovered: () => push({ status: 'authorized', userId: 'user-1', workspaces: [] }),
      };
    };
    const MINUTE = 60_000;
    const LIMIT = 24 * 60 * MINUTE;

    it('keeps an encrypted workspace attached through a transient error', async () => {
      try {
        const { detached, fail } = await offlineHarness();
        fail(new Error('[Server Error] e2ee_projection_corrupt'));
        await vi.advanceTimersByTimeAsync(20_000);
        expect(detached).toEqual(['plain']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps an encrypted workspace attached until its authority confirmation is too old', async () => {
      try {
        const { detached, attached, revoked, fail } = await offlineHarness();
        fail(new Error('[Server Error] e2ee_projection_corrupt'));
        await vi.advanceTimersByTimeAsync(LIMIT - 1);
        expect(detached).toEqual(['plain']);
        await vi.advanceTimersByTimeAsync(1);
        expect(detached).toEqual(['plain', 'encrypted']);
        // A suspension is not a revocation: nothing is cleaned up.
        expect(revoked).toEqual([]);
        await vi.advanceTimersByTimeAsync(LIMIT);
        expect(detached).toEqual(['plain', 'encrypted']);
        expect(attached).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('counts the limit from the last confirmation, not the first list error', async () => {
      try {
        const { detached, fail, confirm } = await offlineHarness();
        fail(new Error('[Server Error] e2ee_projection_corrupt'));
        await vi.advanceTimersByTimeAsync(10 * MINUTE);
        confirm();
        await vi.advanceTimersByTimeAsync(LIMIT - 1);
        expect(detached).toEqual(['plain']);
        await vi.advanceTimersByTimeAsync(1);
        expect(detached).toEqual(['plain', 'encrypted']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps the limit when the wall clock is set back repeatedly', async () => {
      try {
        const { detached, fail, clocks } = await offlineHarness();
        fail(new Error('[Server Error] e2ee_projection_corrupt'));
        for (let round = 0; round < 288; round += 1) {
          await vi.advanceTimersByTimeAsync(5 * MINUTE);
          clocks.wallOffset -= 5 * MINUTE;
        }
        expect(detached).toEqual(['plain', 'encrypted']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('resumes a suspended workspace once its authority is confirmed', async () => {
      try {
        const { detached, attached, revoked, fail, confirm } = await offlineHarness();
        fail(new Error('[Server Error] e2ee_projection_corrupt'));
        await vi.advanceTimersByTimeAsync(LIMIT + MINUTE);
        confirm();
        await vi.advanceTimersByTimeAsync(0);
        expect(attached).toEqual(['encrypted']);
        expect(revoked).toEqual([]);
        // The limit keeps applying while the list stays down.
        await vi.advanceTimersByTimeAsync(LIMIT);
        expect(detached).toEqual(['plain', 'encrypted', 'encrypted']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('stops the limit when the workspace list recovers', async () => {
      try {
        const { detached, fail, listRecovered } = await offlineHarness();
        fail(new Error('[Server Error] e2ee_projection_corrupt'));
        await vi.advanceTimersByTimeAsync(5 * MINUTE);
        listRecovered();
        await vi.advanceTimersByTimeAsync(2 * LIMIT);
        expect(detached).toEqual(['plain']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('detaches an encrypted workspace on an explicit refusal', async () => {
      try {
        const { detached, fail } = await offlineHarness();
        fail(new Error('subscription failed', { cause: new Error('Unauthorized') }));
        await vi.advanceTimersByTimeAsync(20_000);
        expect(detached.sort()).toEqual(['encrypted', 'plain']);
      } finally {
        vi.useRealTimers();
      }
    });
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

describe('LodyFleet local E2EE pairing during startup', () => {
  type Snapshot = Parameters<Parameters<CloudPort['access']['watchWorkspaceAccess']>[0]>[0];
  const genesisHash = 'ab'.repeat(32);
  const encrypted = {
    id: 'ws-e2ee',
    name: 'Private',
    slug: 'private',
    role: 'owner',
    contentMode: 'e2ee',
    genesisHash,
  };
  const prepare = {
    type: 'prepare',
    machineId: 'machine-1',
    accountId: 'user-1',
    workspaceId: encrypted.id,
    genesisHash,
    genesisRecordHex: '00',
    membershipId: 'cd'.repeat(16),
    pairingSessionId: 'ef'.repeat(16),
    frontendSigningPublicKey: '12'.repeat(32),
  } as const;
  const material = {
    pairingSessionId: prepare.pairingSessionId,
    signingPublicKey: '34'.repeat(32),
    encryptionPublicKey: '56'.repeat(32),
    possessionSignature: '78'.repeat(64),
    credentialHash: '9a'.repeat(32),
    bindingSignature: 'bc'.repeat(64),
    protection: 'os-keystore',
  } as const;

  // A daemon started after the workspace was created: its local catalog has
  // never seen the workspace, and the live list has not been delivered yet.
  const coldFleet = async (e2ee = {} as NonNullable<CloudPort['e2ee']>) => {
    let push: (snapshot: Snapshot) => void = () => {};
    const cloudPort: CloudPort = {
      ...createTestCloudPort((onValue) => {
        push = onValue;
        return () => {};
      }),
      e2ee,
    };
    const { fleet: harness } = createFleetHarness(
      createCatalogStub(() => Effect.succeed(catalogSnapshot({}))),
      cloudPort
    );
    const fleet = harness as unknown as typeof harness & {
      startWorkspaceSubscription: (options: { waitForInitial: boolean }) => Promise<void>;
      applyRemoteWorkspaceList: (result: { workspaces: (typeof encrypted)[] }) => Promise<void>;
      applyWorkspaceList: (next: (typeof encrypted)[]) => Promise<void>;
      dispatchLocalE2eePairing: (message: typeof prepare) => Promise<unknown>;
    };
    // The Streams bridge reconcile is outside this boundary; keep the real list application.
    fleet.applyRemoteWorkspaceList = (result) => fleet.applyWorkspaceList([...result.workspaces]);
    await fleet.bootstrapFromLocalCatalog();
    await fleet.startWorkspaceSubscription({ waitForInitial: false });
    return { fleet, push: (snapshot: Snapshot) => push(snapshot) };
  };
  const stateAfterQueuedWork = (reply: Promise<unknown>) =>
    Promise.race([
      reply.then(
        () => 'settled',
        () => 'settled'
      ),
      new Promise((resolve) => setImmediate(() => resolve('pending'))),
    ]);

  it('prepares a workspace the cold cache never saw once the first authoritative list arrives', async () => {
    const legacy = await import('../src/lib/e2ee/workspace-legacy');
    const native = vi
      .spyOn(legacy, 'prepareCliE2eeMachineLegacy')
      .mockResolvedValue(material as never);
    try {
      const { fleet, push } = await coldFleet();
      const reply = fleet.dispatchLocalE2eePairing(prepare);
      expect(await stateAfterQueuedWork(reply)).toBe('pending');

      push({ status: 'authorized', userId: 'user-1', workspaces: [encrypted] });

      await expect(reply).resolves.toEqual({
        ok: true,
        type: 'prepare',
        machineId: 'machine-1',
        ...material,
      });
    } finally {
      native.mockRestore();
    }
  });

  it('re-enabling a local agent revoked while stopped offers a fresh machine identity, not the revoked key', async () => {
    const legacy = await import('../src/lib/e2ee/workspace-legacy');
    const { CloudE2eeDeviceRevoked } = await import('../src/lib/cloud-e2ee-errors');
    const revoked = material;
    const fresh = { ...material, signingPublicKey: 'de'.repeat(32) };
    // The real preparation retains its machine key unless this device's exact
    // credential check reports revocation (no receipt exists: the agent was stopped).
    const native = vi
      .spyOn(legacy, 'prepareCliE2eeMachineLegacy')
      .mockImplementation(async (options) => {
        if (!options.cloud) return revoked as never;
        try {
          await options.cloud.getContentToken({
            workspaceId: options.workspaceId,
            credential: 'synthetic-credential',
          } as never);
          return revoked as never;
        } catch (error) {
          if (error instanceof CloudE2eeDeviceRevoked) return fresh as never;
          throw error;
        }
      });
    try {
      const { fleet, push } = await coldFleet({
        getContentToken: async () => {
          throw new CloudE2eeDeviceRevoked();
        },
      } as unknown as NonNullable<CloudPort['e2ee']>);
      const reply = fleet.dispatchLocalE2eePairing(prepare);
      push({ status: 'authorized', userId: 'user-1', workspaces: [encrypted] });
      await expect(reply).resolves.toMatchObject({
        type: 'prepare',
        signingPublicKey: fresh.signingPublicKey,
      });
    } finally {
      native.mockRestore();
    }
  });

  it.each([
    ['omits the workspace', { status: 'authorized', userId: 'user-1', workspaces: [] }],
    [
      'carries another genesis',
      {
        status: 'authorized',
        userId: 'user-1',
        workspaces: [{ ...encrypted, genesisHash: 'cd'.repeat(32) }],
      },
    ],
    ['rejects the token', { status: 'unauthorized', reason: 'CLI token is invalid or expired.' }],
  ] as const)('still refuses pairing when the first authoritative list %s', async (_, snapshot) => {
    const { fleet, push } = await coldFleet();
    const reply = fleet.dispatchLocalE2eePairing(prepare);
    expect(await stateAfterQueuedWork(reply)).toBe('pending');

    push(snapshot as Snapshot);

    await expect(reply).rejects.toThrow('e2ee_binding_conflict');
  });
});

// The server's mode field is not authority over a workspace this machine has paired
// into: a listing that downgrades it must never start a plaintext runtime. Neither a
// contradicting listing nor an unreadable binding may revoke, relabel or forget a
// workspace; an unreadable binding is retried, never turned into a verdict.
describe('LodyFleet encrypted mode downgrade', () => {
  const genesisHash = 'ab'.repeat(32);
  const paired = {
    id: 'ws-paired',
    name: 'Private',
    slug: 'private',
    role: 'owner',
    contentMode: 'e2ee',
    genesisHash,
  };
  const ordinary = { id: 'ws-ordinary', name: 'Ordinary', slug: null, role: 'owner' };
  const fresh = { id: 'ws-fresh', name: 'Fresh', slug: null, role: 'owner' };
  const pairHere = async (directory: string) => {
    vi.stubEnv('LODY_DATA_DIR', directory);
    const root = join(
      getLodyDataDir(),
      'e2ee',
      createHash('sha256').update('user-1').digest('hex'),
      paired.id
    );
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, 'binding.json'),
      JSON.stringify({ workspaceId: paired.id, genesisHash, genesisRecordHex: 'aa' })
    );
  };
  type Row = { id: string; contentMode?: string; genesisHash?: string };

  /** Real catalog and Streams bridge; runtimes record attach/revocation. */
  const bridgedFleet = async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fleet-e2ee-downgrade-'));
    await pairHere(join(directory, 'data'));
    const originalLocksDir = process.env.LODY_LOCKS_DIR;
    process.env.LODY_LOCKS_DIR = join(directory, 'locks');
    const filePath = join(directory, 'workspace-catalog.json');
    const catalog = makeLocalWorkspaceCatalog({
      filePath,
      lockName: `downgrade-${basename(directory)}`,
      cacheTtlMs: 0,
    });
    const harness = createFleetHarness(catalog);
    const events: string[] = [];
    const issues = new Map<string, string>();
    harness.runtimeStateReporter.upsertIssue.mockImplementation((issue) => {
      issues.set(issue.code, issue.message);
    });
    harness.runtimeStateReporter.clearIssue.mockImplementation((code) => {
      issues.delete(code);
    });
    const state = (workspace: Row) => ({
      workspace,
      lody: {
        isControlPlaneReady: () => true,
        isControlPlaneRecovering: () => false,
        isRemoteBridgeAttached: () => true,
        getActiveSessionCount: () => 0,
        getConnectedRoomCount: () => 0,
        attachRemoteBridge: async () => {},
        detachRemoteBridge: async () => {},
        handleRemoteAccessRevoked: async () => {
          events.push(`${workspace.id}:revoked`);
        },
      },
    });
    const fleet = harness.fleet as unknown as {
      runtimes: Map<string, ReturnType<typeof state>>;
      remoteBridge: RemoteBridge;
      startWorkspace(workspace: Row): Promise<void>;
      applyRemoteWorkspaceList(input: unknown): Promise<void>;
      lastValidWorkspaceListResult: unknown;
      readWorkspaceAccess(workspaceId: string): { status: string; workspace?: Row };
      clearReconcileRetry(): void;
    };
    fleet.startWorkspace = async (workspace) => {
      events.push(`${workspace.id}:start:${workspace.contentMode ?? 'plaintext'}`);
    };
    fleet.remoteBridge = new RemoteBridge({
      logger: createSilentLogger(),
      catalog,
      userId: 'user-1',
      machineId: 'machine-1' as MachineId,
      machineName: 'host',
      getRuntime: (id) => fleet.runtimes.get(id)?.lody as RemoteBridgeRuntime | undefined,
    });
    const apply = async (workspaces: Row[]) => {
      const remote = { status: 'authorized', userId: 'user-1', workspaces };
      fleet.lastValidWorkspaceListResult = remote;
      await fleet.applyRemoteWorkspaceList(remote);
    };
    const cachedRows = async () =>
      Object.fromEntries(
        (
          await fileLocksLegacy.runPromise(makeLocalWorkspaceCatalog({ filePath }).read())
        ).workspaces.map((row) => [
          row.workspaceId,
          `${row.state}:${row.contentMode ?? 'plaintext'}`,
        ])
      );
    const dispose = async () => {
      fleet.clearReconcileRetry();
      fleet.remoteBridge.shutdown();
      vi.unstubAllEnvs();
      if (originalLocksDir === undefined) delete process.env.LODY_LOCKS_DIR;
      else process.env.LODY_LOCKS_DIR = originalLocksDir;
      await rm(directory, { recursive: true, force: true });
    };
    return { fleet, state, events, issues, apply, cachedRows, dispose };
  };

  it.each([
    ['plaintext', { ...paired, contentMode: 'plaintext', genesisHash: undefined }],
    ['without a mode', { ...paired, contentMode: undefined, genesisHash: undefined }],
    ['with another genesis', { ...paired, genesisHash: 'cd'.repeat(32) }],
  ] as const)(
    'keeps a running paired workspace encrypted and unrevoked when the server lists it %s',
    async (_, downgraded) => {
      const t = await bridgedFleet();
      try {
        await t.apply([paired, ordinary]);
        t.fleet.runtimes.set(paired.id, t.state(paired));
        t.events.length = 0;

        await t.apply([downgraded, ordinary]);
        expect(t.events).toEqual([`${ordinary.id}:start:plaintext`]);
        expect(t.fleet.runtimes.get(paired.id)?.workspace).toMatchObject({
          contentMode: 'e2ee',
          genesisHash,
        });
        expect(t.fleet.readWorkspaceAccess(paired.id)).toMatchObject({
          status: 'authorized',
          workspace: { contentMode: 'e2ee', genesisHash },
        });
        expect(t.issues.has(`e2ee_mode_conflict:${paired.id}`)).toBe(true);
        // Neither forgotten nor rewritten from the contradicting listing.
        expect(await t.cachedRows()).toMatchObject({ [paired.id]: 'active:e2ee' });

        await t.apply([paired, ordinary]);
        expect(t.issues.has(`e2ee_mode_conflict:${paired.id}`)).toBe(false);
      } finally {
        await t.dispose();
      }
    }
  );

  it('never starts a stopped paired workspace from a downgraded listing', async () => {
    const t = await bridgedFleet();
    try {
      await t.apply([{ ...paired, contentMode: 'plaintext', genesisHash: undefined }]);
      expect(t.events).toEqual([]);
      expect(t.fleet.readWorkspaceAccess(paired.id).status).toBe('unknown');
      await t.apply([paired]);
      expect(t.events).toEqual([`${paired.id}:start:e2ee`]);
    } finally {
      await t.dispose();
    }
  });

  it('treats an unreadable binding as unknown, never as revocation, and recovers', async () => {
    const t = await bridgedFleet();
    try {
      await t.apply([ordinary]);
      t.fleet.runtimes.set(ordinary.id, t.state(ordinary));
      t.events.length = 0;
      bindingReadFault.code = 'EMFILE';
      await t.apply([ordinary, fresh]);
      // The running workspace keeps its turns and cache; the new one reaches its
      // opener, which refuses it until the binding is readable again.
      expect(t.events).toEqual([`${fresh.id}:start:plaintext`]);
      expect(t.fleet.readWorkspaceAccess(ordinary.id).status).toBe('authorized');
      expect(await t.cachedRows()).toMatchObject({
        [ordinary.id]: 'active:plaintext',
        [fresh.id]: 'active:plaintext',
      });
      expect(() => assertRetainedE2eeModeAllowsOpen('user-1', fresh)).toThrow(
        expect.objectContaining({ name: 'E2eeBindingUnreadableError', code: 'EMFILE' })
      );
      bindingReadFault.code = null;
      expect(() => assertRetainedE2eeModeAllowsOpen('user-1', fresh)).not.toThrow();
    } finally {
      bindingReadFault.code = null;
      await t.dispose();
    }
  });

  /** Real startWorkspace; the opener runs the real binding check, then a runtime
   * stub whose start fails, so each attempt is observable without a full runtime. */
  const startingFleet = async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fleet-e2ee-downgrade-start-'));
    await pairHere(directory);
    const opened: string[] = [];
    const create = vi.spyOn(Lody, 'create').mockImplementation(async (options) => {
      const open = options as unknown as {
        userId: string;
        workspaceId: string;
        contentMode?: string;
      };
      assertRetainedE2eeModeAllowsOpen(open.userId, {
        id: open.workspaceId,
        contentMode: open.contentMode,
      });
      opened.push(open.workspaceId);
      return {
        start: async () => Promise.reject(new Error('synthetic runtime stop after the mode check')),
        cleanup: async () => {},
        documentManager: { repo: {} },
      } as never;
    });
    const { fleet: harness, runtimeStateReporter } = createFleetHarness(
      createCatalogStub(() => Effect.succeed(catalogSnapshot({})))
    );
    const issues = new Map<string, string>();
    runtimeStateReporter.upsertIssue.mockImplementation((issue) => {
      issues.set(issue.code, issue.message);
    });
    runtimeStateReporter.clearIssue.mockImplementation((code) => {
      issues.delete(code);
    });
    const fleet = harness as unknown as {
      desiredWorkspaces: Map<string, Row>;
      retryTimers: Map<string, ReturnType<typeof setTimeout>>;
      startWorkspace(workspace: Row): Promise<void>;
      stopped: boolean;
    };
    delete (fleet as unknown as { startWorkspace?: unknown }).startWorkspace;
    const dispose = async () => {
      bindingReadFault.code = null;
      fleet.stopped = true;
      for (const timer of fleet.retryTimers.values()) clearTimeout(timer);
      create.mockRestore();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    };
    return { fleet, opened, issues, dispose };
  };

  it('backs off unreadable bindings, merges them into one issue, and opens after recovery', async () => {
    vi.useFakeTimers();
    const t = await startingFleet();
    try {
      for (const workspace of [ordinary, fresh])
        t.fleet.desiredWorkspaces.set(workspace.id, workspace);
      bindingReadFault.code = 'EMFILE';
      await t.fleet.startWorkspace(ordinary);
      await t.fleet.startWorkspace(fresh);
      const attempts = () => vi.mocked(Lody.create).mock.calls.length;
      expect(attempts()).toBe(2);
      // One Fleet-level issue for the errno, no per-workspace start failures.
      expect(
        [...t.issues.keys()].filter(
          (code) =>
            code.startsWith('e2ee_binding_unreadable:') ||
            code.startsWith('workspace_start_failed:')
        )
      ).toEqual(['e2ee_binding_unreadable:EMFILE']);
      expect(t.issues.get('e2ee_binding_unreadable:EMFILE')).toContain('2 workspace(s)');
      // 10 s, then 20 s, then 40 s per workspace.
      await vi.advanceTimersByTimeAsync(9_999);
      expect(attempts()).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts()).toBe(4);
      await vi.advanceTimersByTimeAsync(19_999);
      expect(attempts()).toBe(4);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts()).toBe(6);
      expect(t.opened).toEqual([]);
      bindingReadFault.code = null;
      await vi.advanceTimersByTimeAsync(40_000);
      expect(t.opened).toEqual([ordinary.id, fresh.id]);
      expect(t.issues.has('e2ee_binding_unreadable:EMFILE')).toBe(false);
    } finally {
      await t.dispose();
      vi.useRealTimers();
    }
  });

  it('does not retry a readable contradicting binding at startup', async () => {
    vi.useFakeTimers();
    const t = await startingFleet();
    const downgraded = { ...paired, contentMode: 'plaintext', genesisHash: undefined };
    try {
      t.fleet.desiredWorkspaces.set(paired.id, downgraded);
      await t.fleet.startWorkspace(downgraded);
      expect(t.fleet.retryTimers.has(paired.id)).toBe(false);
      expect(t.issues.get(`e2ee_mode_conflict:${paired.id}`)).toContain(
        'refused to open it without encryption'
      );
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(t.opened).toEqual([]);
    } finally {
      await t.dispose();
      vi.useRealTimers();
    }
  });

  it('lets an explicit identity reset release a contradicted workspace into pairing, reporting the conflict once', async () => {
    const t = await bridgedFleet();
    const fleet = t.fleet as typeof t.fleet & {
      resetLocalE2eeIdentity(message: unknown): Promise<{ ok: true; archive: string | null }>;
      waitingForPairing: Set<string>;
    };
    const reported = vi.fn();
    const downgraded = { ...paired, contentMode: 'plaintext', genesisHash: undefined };
    try {
      await t.apply([downgraded]);
      await t.apply([{ ...downgraded, name: 'Renamed' }]);
      for (const [code] of t.issues) if (code.startsWith('e2ee_mode_conflict')) reported(code);
      expect(reported).toHaveBeenCalledTimes(1);
      const result = await fleet.resetLocalE2eeIdentity({
        machineId: 'machine-1',
        accountId: 'user-1',
        workspaceId: paired.id,
        resetId: crypto.randomUUID(),
      });
      expect(result.ok).toBe(true);
      expect(result.archive).not.toBeNull();
      expect(t.issues.has(`e2ee_mode_conflict:${paired.id}`)).toBe(false);
      expect(fleet.waitingForPairing.has(paired.id)).toBe(true);
      expect(t.events).toEqual([]);
    } finally {
      await t.dispose();
    }
  });

  it('refuses a stale ordinary cache row offline and at runtime start', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fleet-e2ee-downgrade-cache-'));
    await pairHere(directory);
    try {
      const { fleet, started, runtimeStateReporter } = createFleetHarness(
        createCatalogStub(() =>
          Effect.succeed(
            catalogSnapshot({
              workspaces: [
                activeWorkspace(ordinary.id, ordinary.name, null, 'owner'),
                activeWorkspace(paired.id, paired.name, paired.slug, 'owner'),
              ],
            })
          )
        )
      );
      const issues = new Set<string>();
      runtimeStateReporter.upsertIssue.mockImplementation((issue) => {
        issues.add(issue.code);
      });
      await fleet.bootstrapFromLocalCatalog();
      expect(started).toEqual([ordinary.id]);
      expect(issues.has(`e2ee_mode_conflict:${paired.id}`)).toBe(true);
      // Every other opener reaches the same check before choosing a data plane.
      await expect(
        Lody.create({
          userId: 'user-1',
          workspaceId: paired.id,
          contentMode: 'plaintext',
        } as Parameters<typeof Lody.create>[0])
      ).rejects.toMatchObject({ name: 'E2eeModeConflictError' });
    } finally {
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

// A revoked machine identity is not a removed member: the account keeps the
// workspace and re-enrols this machine, while a real removal still drops it.
describe('LodyFleet encrypted access loss', () => {
  const genesisHash = 'ab'.repeat(32);
  const encrypted = {
    id: 'ws-revoked',
    name: 'Private',
    slug: 'private',
    role: 'owner',
    contentMode: 'e2ee',
    genesisHash,
  };
  const runtimeStub = () => {
    const stub = {
      cleanups: 0,
      start: async () => {},
      cleanup: async () => {
        stub.cleanups += 1;
      },
      documentManager: { repo: {} },
      isControlPlaneReady: () => true,
      isControlPlaneRecovering: () => false,
      isRemoteBridgeAttached: () => false,
      getActiveSessionCount: () => 0,
      getConnectedRoomCount: () => 0,
      confirmEncryptedWorkspacePairing: async () => false,
    };
    return stub;
  };
  type AccessLost = (owner: unknown, reason: 'member-removed' | 'device-revoked') => Promise<void>;

  const startedEncryptedWorkspace = async () => {
    const legacy = await import('../src/lib/e2ee/workspace-legacy');
    const first = runtimeStub();
    const second = runtimeStub();
    const runtimes = [first, second];
    let accessLost: AccessLost | undefined;
    const create = vi.spyOn(Lody, 'create').mockImplementation(async (options) => {
      accessLost ??= (options as unknown as { onEncryptedAccessLost?: AccessLost })
        .onEncryptedAccessLost;
      const next = runtimes.shift();
      if (!next) throw new Error('unexpected extra runtime');
      return next as never;
    });
    const validate = vi
      .spyOn(legacy, 'validateCliE2eePairingIntentLegacy')
      .mockResolvedValue(undefined as never);
    const activate = vi
      .spyOn(legacy, 'activateCliE2eeWorkspaceLegacy')
      .mockResolvedValue(undefined as never);
    const reconcile = vi
      .spyOn(projectMeta, 'reconcileMachineLocalProjectRootPaths')
      .mockResolvedValue(undefined);
    const schedules = vi.spyOn(scheduleWorkspace, 'createScheduleWorkspace').mockResolvedValue({
      evaluate: async () => {},
      dispose: async () => {},
    });
    const harness = createFleetHarness(
      createCatalogStub(() => Effect.succeed(catalogSnapshot({}))),
      { ...createTestCloudPort(), e2ee: {} as NonNullable<CloudPort['e2ee']> }
    );
    const fleet = harness.fleet as unknown as {
      desiredWorkspaces: Map<string, unknown>;
      runtimes: Map<string, { lody: unknown }>;
      waitingForPairing: Set<string>;
      retryTimers: Map<string, ReturnType<typeof setTimeout>>;
      startWorkspace(workspace: never): Promise<void>;
      dispatchLocalE2eePairing(message: unknown): Promise<unknown>;
      stopped: boolean;
    };
    delete (fleet as unknown as { startWorkspace?: unknown }).startWorkspace;
    fleet.desiredWorkspaces.set(encrypted.id, encrypted);
    await fleet.startWorkspace(encrypted as never);
    expect(fleet.runtimes.get(encrypted.id)?.lody).toBe(first);
    const restore = () => {
      fleet.stopped = true;
      for (const timer of fleet.retryTimers.values()) clearTimeout(timer);
      for (const spy of [create, validate, activate, reconcile, schedules]) spy.mockRestore();
    };
    return { fleet, first, second, activate, accessLost: () => accessLost!, restore };
  };

  it('keeps the workspace binding when only this machine identity is revoked, so the re-enrolled identity activates', async () => {
    const { fleet, first, second, activate, accessLost, restore } =
      await startedEncryptedWorkspace();
    try {
      await accessLost()(first, 'device-revoked');

      // The revoked identity's runtime is retired, not kept executing.
      expect(fleet.runtimes.has(encrypted.id)).toBe(false);
      expect(first.cleanups).toBe(1);
      // The account is still a member: the binding stays and waits for pairing,
      // so no runtime restarts with the revoked identity.
      expect(fleet.desiredWorkspaces.has(encrypted.id)).toBe(true);
      expect(fleet.waitingForPairing.has(encrypted.id)).toBe(true);

      await expect(
        fleet.dispatchLocalE2eePairing({
          type: 'activate',
          machineId: 'machine-1',
          accountId: 'user-1',
          workspaceId: encrypted.id,
          genesisHash,
          pairingSessionId: 'ef'.repeat(16),
          frontendSigningPublicKey: '12'.repeat(32),
          signingPublicKey: 'de'.repeat(32),
        })
      ).resolves.toEqual({ ok: true, type: 'activate' });
      expect(activate).toHaveBeenCalledOnce();
      expect(fleet.runtimes.get(encrypted.id)?.lody).toBe(second);
      expect(fleet.waitingForPairing.has(encrypted.id)).toBe(false);
    } finally {
      restore();
    }
  });

  // Waiting for pairing must also hold off startup retries and starts already in
  // flight: the open path would reread the retained revoked device credential.
  const revocableFleet = async (createRuntime: (options: unknown) => Promise<unknown>) => {
    let accessLost: AccessLost | undefined;
    let creates = 0;
    const create = vi.spyOn(Lody, 'create').mockImplementation(async (options) => {
      creates += 1;
      accessLost ??= (options as unknown as { onEncryptedAccessLost?: AccessLost })
        .onEncryptedAccessLost;
      return (await createRuntime(options)) as never;
    });
    const reconcile = vi
      .spyOn(projectMeta, 'reconcileMachineLocalProjectRootPaths')
      .mockResolvedValue(undefined);
    const schedules = vi.spyOn(scheduleWorkspace, 'createScheduleWorkspace').mockResolvedValue({
      evaluate: async () => {},
      dispose: async () => {},
    });
    const harness = createFleetHarness(
      createCatalogStub(() => Effect.succeed(catalogSnapshot({}))),
      { ...createTestCloudPort(), e2ee: {} as NonNullable<CloudPort['e2ee']> }
    );
    const fleet = harness.fleet as unknown as {
      desiredWorkspaces: Map<string, unknown>;
      runtimes: Map<string, { lody: unknown }>;
      waitingForPairing: Set<string>;
      retryTimers: Map<string, ReturnType<typeof setTimeout>>;
      startWorkspace(workspace: never): Promise<void>;
      stopped: boolean;
    };
    delete (fleet as unknown as { startWorkspace?: unknown }).startWorkspace;
    fleet.desiredWorkspaces.set(encrypted.id, encrypted);
    const restore = () => {
      fleet.stopped = true;
      for (const timer of fleet.retryTimers.values()) clearTimeout(timer);
      for (const spy of [create, reconcile, schedules]) spy.mockRestore();
    };
    return { fleet, creates: () => creates, accessLost: () => accessLost!, restore };
  };

  it('does not retry a failed startup with the revoked identity while waiting for pairing', async () => {
    vi.useFakeTimers();
    const failed = {
      ...runtimeStub(),
      start: async () => Promise.reject(new Error('startup failed')),
    };
    const { fleet, creates, accessLost, restore } = await revocableFleet(async () => failed);
    try {
      await fleet.startWorkspace(encrypted as never);
      expect(fleet.retryTimers.has(encrypted.id)).toBe(true);

      await accessLost()(failed, 'device-revoked');
      expect(fleet.waitingForPairing.has(encrypted.id)).toBe(true);
      expect(fleet.retryTimers.has(encrypted.id)).toBe(false);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(creates()).toBe(1);
      expect(fleet.runtimes.has(encrypted.id)).toBe(false);
    } finally {
      restore();
      vi.useRealTimers();
    }
  });

  it('aborts a start in flight when its machine identity is revoked, never starting the old identity', async () => {
    vi.useFakeTimers();
    let release: () => void = () => {};
    const opened = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stub = runtimeStub();
    let started = false;
    const inFlight = {
      ...stub,
      start: async () => {
        started = true;
      },
    };
    const { fleet, creates, accessLost, restore } = await revocableFleet(async () => {
      await opened;
      return inFlight;
    });
    try {
      const start = fleet.startWorkspace(encrypted as never);
      await vi.advanceTimersByTimeAsync(0);
      await accessLost()(inFlight, 'device-revoked');
      release();
      await start;

      expect(started).toBe(false);
      expect(fleet.runtimes.has(encrypted.id)).toBe(false);
      expect(fleet.waitingForPairing.has(encrypted.id)).toBe(true);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(creates()).toBe(1);
      expect(fleet.retryTimers.has(encrypted.id)).toBe(false);
    } finally {
      restore();
      vi.useRealTimers();
    }
  });

  it('still drops the workspace binding when the member is actually removed', async () => {
    const { fleet, first, accessLost, restore } = await startedEncryptedWorkspace();
    try {
      await accessLost()(first, 'member-removed');

      expect(fleet.runtimes.has(encrypted.id)).toBe(false);
      expect(first.cleanups).toBe(1);
      expect(fleet.desiredWorkspaces.has(encrypted.id)).toBe(false);
      expect(fleet.waitingForPairing.has(encrypted.id)).toBe(false);
    } finally {
      restore();
    }
  });
});

describe('LodyFleet shutdown ordering', () => {
  it('keeps the process Local Loro writer until workspace runtimes have released their writer owners', async () => {
    const { getProcessLocalLoroWriterLegacy } =
      await import('@lody/shared/local-loro-writer/legacy');
    const { makeLocalLoroWriterOwner } = await import('@lody/shared/local-loro-writer');
    const writer = getProcessLocalLoroWriterLegacy();
    const owner = makeLocalLoroWriterOwner();
    let releaseSessions: () => void = () => {};
    const sessionsReleased = new Promise<void>((resolve) => {
      releaseSessions = resolve;
    });
    const { fleet: harness } = createFleetHarness(
      createCatalogStub(() => Effect.succeed(catalogSnapshot({})))
    );
    const fleet = harness as unknown as typeof harness & {
      runtimes: Map<string, unknown>;
      shutdown: () => Promise<void>;
    };
    fleet.runtimes.set('ws-1', {
      workspace: { id: 'ws-1', name: 'One', slug: 'one', role: 'member' },
      lody: {
        // SessionManager.cleanUp: sessions settle first, then the workspace
        // data-plane server releases its owner through the shared writer.
        cleanup: async () => {
          await sessionsReleased;
          await writer.executeEffect(writer.writer.closeOwner(owner));
        },
      },
      schedules: { dispose: async () => {} },
      prPollerWorkspace: null,
    });

    const shutdown = fleet.shutdown();
    // Local endpoints stop concurrently; let that teardown run as far as it can.
    for (let turn = 0; turn < 50 && !writer.isReleased(); turn += 1)
      await new Promise((resolve) => setImmediate(resolve));
    expect(writer.isReleased()).toBe(false);

    releaseSessions();

    await expect(shutdown).resolves.toBeUndefined();
    expect(writer.isReleased()).toBe(true);
  });

  it('retains the writer for a failed workspace release and releases it after recovery', async () => {
    const { getProcessLocalLoroWriterLegacy } =
      await import('@lody/shared/local-loro-writer/legacy');
    const { makeLocalLoroWriterOwner } = await import('@lody/shared/local-loro-writer');
    const writer = getProcessLocalLoroWriterLegacy();
    const owner = makeLocalLoroWriterOwner();
    let attempts = 0;
    const { fleet: harness } = createFleetHarness(
      createCatalogStub(() => Effect.succeed(catalogSnapshot({})))
    );
    const fleet = harness as unknown as typeof harness & {
      runtimes: Map<string, unknown>;
      shutdown: () => Promise<void>;
      recoverShutdown: () => Promise<void>;
    };
    fleet.runtimes.set('ws-1', {
      workspace: { id: 'ws-1', name: 'One', slug: 'one', role: 'member' },
      lody: {
        cleanup: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('Synthetic session release failure');
          await writer.executeEffect(writer.writer.closeOwner(owner));
        },
      },
      schedules: { dispose: async () => {} },
      prPollerWorkspace: null,
    });

    await expect(fleet.shutdown()).rejects.toThrow(
      'Fleet shutdown retains unresolved workspace resources'
    );
    expect(writer.isReleased()).toBe(false);

    await expect(fleet.recoverShutdown()).resolves.toBeUndefined();
    expect(attempts).toBe(2);
    expect(writer.isReleased()).toBe(true);
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
      waitingForPairing: Set<string>;
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
      // Waiting holds the workspace until explicit activation, which clears the wait
      // and then calls the same start entry again (as dispatchLocalE2eePairing does).
      if (waiting) {
        create.mockRejectedValue(new Error('e2ee_storage_failed'));
        await fleet.startWorkspace(workspace as never);
        expect(fleet.retryTimers.has(workspace.id)).toBe(false);
        fleet.waitingForPairing.delete(workspace.id);
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
    const schedules = vi.spyOn(scheduleWorkspace, 'createScheduleWorkspace').mockResolvedValue({
      evaluate: async () => {},
      dispose: async () => {},
    });
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
      schedules.mockRestore();
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
        remoteAutomation: {
          value: {
            verifyControl: async () => ({ requesterUserId: 'owner', expiresAt: 0 }),
          },
        },
      });
      const create = vi.spyOn(Lody, 'create').mockResolvedValue({
        start: async () => {},
        cleanup: async () => {},
        documentManager: { repo: {} },
        isControlPlaneReady: () => true,
        isControlPlaneRecovering: () => false,
        isRemoteBridgeAttached: () => false,
        getActiveSessionCount: () => 0,
        getConnectedRoomCount: () => 0,
      } as never);
      const reconcile = vi
        .spyOn(projectMeta, 'reconcileMachineLocalProjectRootPaths')
        .mockResolvedValue(undefined);
      let disposedSchedule = false;
      const scheduleHandle = {
        evaluate: async () => {},
        dispose: async () => {
          disposedSchedule = true;
        },
      };
      const schedules = vi
        .spyOn(scheduleWorkspace, 'createScheduleWorkspace')
        .mockResolvedValue(scheduleHandle);
      const automationHandle = { dispose: async () => {} };
      const automations = vi
        .spyOn(automationWorkspace, 'createAutomationWorkspaceLegacy')
        .mockResolvedValue(automationHandle as never);
      const fleet = createFleetHarness(
        createCatalogStub(() => Effect.succeed(catalogSnapshot({}))),
        cloud
      ).fleet as unknown as {
        desiredWorkspaces: Map<string, unknown>;
        runtimes: Map<
          string,
          {
            prPollerWorkspace: PrPollerWorkspaceHandle | null;
            automations?: unknown;
            automationsRetryAt?: number;
            schedules: scheduleWorkspace.ScheduleWorkspaceHandle;
          }
        >;
        ensureAutomations(state: unknown): Promise<unknown>;
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
        expect(runtime?.schedules).toBe(scheduleHandle);
        // Local automations run in both modes; remote control rides workspace Machine RPC,
        // which encrypted workspaces withhold, so its cloud-proof verifier stays plaintext-only.
        expect(runtime?.automations).toBe(automationHandle);
        await expect(fleet.ensureAutomations(runtime)).resolves.toBe(automationHandle);
        expect(automations.mock.calls[0]?.[0].verifyRemoteControl).toBe(
          encrypted ? undefined : cloud.remoteAutomation?.verifyControl
        );
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
        expect(disposedSchedule).toBe(true);
      } finally {
        fleet.stopped = true;
        for (const timer of fleet.retryTimers.values()) clearTimeout(timer);
        create.mockRestore();
        reconcile.mockRestore();
        schedules.mockRestore();
        automations.mockRestore();
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

describe('local DSH Provider discovery', () => {
  it('returns only local builtin DSH ids/names across workspaces, without credentials', async () => {
    const { fleet: raw } = createFleetHarness(
      createCatalogStub(() => Effect.succeed(catalogSnapshot({})))
    );
    const fleet = raw as unknown as {
      runtimes: Map<string, unknown>;
      dispatchLocalSessionControl: (
        request: LocalSessionControlRequest
      ) => Promise<LocalSessionControlResponse[]>;
    };
    const configs = [
      {
        id: 'local-dsh',
        name: 'DSH',
        cliType: 'builtin',
        agentType: 'deepseek',
        machineId: 'machine-1',
        env: { DEEPSEEK_API_KEY: 'synthetic-secret' },
      },
      {
        id: 'remote',
        name: 'Remote',
        cliType: 'builtin',
        agentType: 'deepseek',
        machineId: 'machine-2',
        env: {},
      },
      {
        id: 'codex',
        name: 'Codex',
        cliType: 'builtin',
        agentType: 'codex',
        machineId: 'machine-1',
        env: {},
      },
      {
        id: 'registry',
        name: 'Registry',
        cliType: 'registry',
        agentType: 'deepseek',
        machineId: 'machine-1',
        env: {},
      },
    ];
    const repo = {
      getMeta: () => ({ scan: async () => [] }),
      openFlockDoc: async () => ({
        flock: {
          scan: () =>
            configs.map((config) => ({
              key: machineFlockKeys.agentConfig(config.id as AgentConfigId),
              value: config,
            })),
        },
      }),
    };
    for (const id of ['workspace-1', 'workspace-2'])
      fleet.runtimes.set(id, { workspace: { id }, lody: { documentManager: { repo } } });
    expect(
      await fleet.dispatchLocalSessionControl({
        type: 'machine/dsh-providers',
        machineId: 'machine-1' as MachineId,
      })
    ).toEqual([
      {
        type: 'machine/dsh-providers_response',
        providers: [{ id: 'local-dsh', name: 'DSH' }],
      },
    ]);
  });
});

it('keeps manual terminals through agent termination and workspace cleanup until archive or shutdown', async () => {
  const events = new EventEmitter();
  const sessionId = 'terminal-session' as SessionId;
  const otherSessionId = 'other-terminal-session' as SessionId;
  const terminals = new Set([sessionId, otherSessionId]);
  let archiveTerminals: ((id: SessionId) => void) | undefined;
  const create = vi.spyOn(Lody, 'create').mockImplementation(async (options) => {
    archiveTerminals = options.closeSessionTerminals;
    return {
      start: async () => {},
      cleanup: async () => {
        events.emit('terminated', sessionId);
      },
      // Model the agent lifecycle boundary that used to own manual terminals.
      onSessionTerminated: (handler: (id: SessionId) => void) => {
        events.on('terminated', handler);
        return () => {
          events.off('terminated', handler);
        };
      },
      documentManager: { repo: {} },
      isControlPlaneReady: () => true,
      isControlPlaneRecovering: () => false,
      isRemoteBridgeAttached: () => false,
      getActiveSessionCount: () => 0,
      getConnectedRoomCount: () => 0,
    } as never;
  });
  const reconcile = vi
    .spyOn(projectMeta, 'reconcileMachineLocalProjectRootPaths')
    .mockResolvedValue(undefined);
  const schedules = vi.spyOn(scheduleWorkspace, 'createScheduleWorkspace').mockResolvedValue({
    evaluate: async () => {},
    dispose: async () => {},
  });
  const fleet = createFleetHarness(createCatalogStub(() => Effect.succeed(catalogSnapshot({}))))
    .fleet as unknown as {
    desiredWorkspaces: Map<string, unknown>;
    runtimes: Map<string, unknown>;
    retryTimers: Map<string, ReturnType<typeof setTimeout>>;
    terminalPtyService: {
      closeSession(id: SessionId): void;
      closeAll(): void;
    };
    startWorkspace(workspace: never): Promise<void>;
    stopWorkspace(id: string): Promise<void>;
    finishGlobalShutdown(): Promise<void>;
    stopped: boolean;
  };
  fleet.terminalPtyService = {
    closeSession: (id) => {
      terminals.delete(id);
    },
    closeAll: () => {
      terminals.clear();
    },
  };
  delete (fleet as unknown as { startWorkspace?: unknown }).startWorkspace;
  const workspace = {
    id: 'manual-terminals',
    name: 'Synthetic',
    slug: null,
    role: 'owner',
    contentMode: 'e2ee',
  };
  fleet.desiredWorkspaces.set(workspace.id, workspace);
  try {
    await fleet.startWorkspace(workspace as never);
    expect(fleet.runtimes.has(workspace.id)).toBe(true);
    // Stop and GC both publish the same agent termination event.
    events.emit('terminated', sessionId);
    expect([...terminals]).toEqual([sessionId, otherSessionId]);

    await fleet.stopWorkspace(workspace.id);
    expect(fleet.runtimes.has(workspace.id)).toBe(false);
    expect([...terminals]).toEqual([sessionId, otherSessionId]);

    expect(archiveTerminals).toBeDefined();
    if (!archiveTerminals) throw new Error('Archive cleanup was not wired');
    archiveTerminals(sessionId);
    expect([...terminals]).toEqual([otherSessionId]);

    await fleet.finishGlobalShutdown();
    expect(terminals.size).toBe(0);
  } finally {
    fleet.stopped = true;
    for (const timer of fleet.retryTimers.values()) clearTimeout(timer);
    create.mockRestore();
    reconcile.mockRestore();
    schedules.mockRestore();
  }
});
