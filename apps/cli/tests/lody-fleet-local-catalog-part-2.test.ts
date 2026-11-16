import { createLocalCloudPort, type CloudPort } from '@lody/platform';
import {
  machineFlockKeys,
  type AgentConfigId,
  type LocalSessionControlRequest,
  type LocalSessionControlResponse,
  type MachineId,
  type SessionId,
} from '@lody/shared';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import { Effect } from 'effect';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as automationWorkspace from '../src/automations/workspace-legacy';
import { createCloudPrAssociationPort } from '../src/lib/cloud-pr-association';
import * as projectMeta from '../src/lib/local-project-meta';
import { makeLocalWorkspaceCatalog } from '../src/lib/local-workspace-catalog';
import { Lody } from '../src/lib/lody';
import type { PrPollerWorkspaceHandle } from '../src/lib/pr-poller/pr-poller-workspace';
import { RemoteBridge, type RemoteBridgeRuntime } from '../src/lib/remote-bridge';
import * as scheduleWorkspace from '../src/lib/schedules/schedule-workspace';
import { fileLocksLegacy } from '../src/utils/file-lock';

import {
  catalogSnapshot,
  createCatalogStub,
  createFleetHarness,
  createSilentLogger,
  createTestCloudPort,
} from './lody-fleet-local-catalog-helpers';

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
    const handed: unknown[] = [];
    const create = vi.spyOn(Lody, 'create').mockImplementation(async (options) => {
      accessLost ??= (options as unknown as { onEncryptedAccessLost?: AccessLost })
        .onEncryptedAccessLost;
      handed.push(options.encryptedWorkspace);
      const next = runtimes.shift();
      if (!next) throw new Error('unexpected extra runtime');
      return next as never;
    });
    const validate = vi
      .spyOn(legacy, 'validateCliE2eePairingIntentLegacy')
      .mockResolvedValue(undefined as never);
    const closed: unknown[] = [];
    const promoted = { close: async () => void closed.push(promoted) };
    const activate = vi
      .spyOn(legacy, 'activateAndPromoteCliE2eeWorkspaceLegacy')
      .mockResolvedValue(promoted as never);
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
    return {
      fleet,
      first,
      second,
      activate,
      promoted,
      handed,
      closed,
      accessLost: () => accessLost!,
      restore,
    };
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

  const activation = {
    type: 'activate',
    machineId: 'machine-1',
    accountId: 'user-1',
    workspaceId: encrypted.id,
    genesisHash,
    pairingSessionId: 'ef'.repeat(16),
    frontendSigningPublicKey: '12'.repeat(32),
    signingPublicKey: 'de'.repeat(32),
  };

  it('starts the re-enrolled runtime on the activated owner instead of reopening it', async () => {
    const t = await startedEncryptedWorkspace();
    try {
      await t.accessLost()(t.first, 'device-revoked');
      await t.fleet.dispatchLocalE2eePairing(activation);
      expect(t.fleet.runtimes.get(encrypted.id)?.lody).toBe(t.second);
      expect(t.handed.at(-1)).toBe(t.promoted);
      expect(t.closed).toEqual([]);
    } finally {
      t.restore();
    }
  });

  it('closes the activated owner when Fleet stops before a runtime can take it', async () => {
    const t = await startedEncryptedWorkspace();
    try {
      await t.accessLost()(t.first, 'device-revoked');
      t.activate.mockImplementationOnce(async () => {
        t.fleet.stopped = true;
        return t.promoted as never;
      });
      await t.fleet.dispatchLocalE2eePairing(activation);
      // Closed inside the activation flight that shutdown drains, never handed on.
      expect(t.closed).toEqual([t.promoted]);
      expect(t.handed).toEqual([undefined]);
      expect(t.fleet.runtimes.has(encrypted.id)).toBe(false);
    } finally {
      t.restore();
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
