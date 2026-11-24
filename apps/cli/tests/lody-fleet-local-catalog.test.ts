import { type CloudPort } from '@lody/platform';
import { type MachineId } from '@lody/shared';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import { Effect } from 'effect';
import { createHash } from 'node:crypto';
import fs, { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AuthorityStamp } from '../src/lib/e2ee/authority-clock';
import { assertRetainedE2eeModeAllowsOpen } from '../src/lib/e2ee/retained-binding';
import {
  CatalogPermissionError,
  makeLocalWorkspaceCatalog,
} from '../src/lib/local-workspace-catalog';
import { Lody } from '../src/lib/lody';
import { LodyFleet } from '../src/lib/lody-fleet';
import { RemoteBridge, type RemoteBridgeRuntime } from '../src/lib/remote-bridge';
import { fileLocksLegacy } from '../src/utils/file-lock';
import {
  activeWorkspace,
  catalogSnapshot,
  createCatalogStub,
  createFleetHarness,
  createRuntimeStateReporter,
  createSilentLogger,
  createTestCloudPort,
} from './lody-fleet-local-catalog-helpers';

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
        enforceEncryptedAuthorityLimit: () => Promise<void>;
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
        check: () => fleet.enforceEncryptedAuthorityLimit(),
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

    it('keeps the bridge after suspend and NTP rollback until the 24-hour wall limit', async () => {
      try {
        const { detached, fail, clocks, check } = await offlineHarness();
        fail(new Error('[Server Error] e2ee_projection_corrupt'));
        await vi.advanceTimersByTimeAsync(20_000);
        clocks.wallOffset += 30 * MINUTE - 5_000;
        await vi.advanceTimersByTimeAsync(5_000);
        await check();
        expect(detached).toEqual(['plain']);
        clocks.wallOffset -= 3 * MINUTE;
        await check();
        expect(detached).toEqual(['plain']);
        await vi.advanceTimersByTimeAsync(LIMIT - 20_000 - 30 * MINUTE + 3 * MINUTE - 1);
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
