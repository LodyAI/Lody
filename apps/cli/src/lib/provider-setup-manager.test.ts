import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Flock } from '@loro-dev/flock-wasm';
import {
  applyProviderSetupCancellationToFlock,
  deleteMachineFlockRowFromFlock,
  getMachineFlockAgentConfigs,
  getMachineFlockProviderSetups,
  getMachineFlockProviderSetupCancellations,
  getMachineFlockProviderCredentialCleanups,
  buildLodyCodexCustomProviderEnv,
  LODY_CODEX_API_KEY_ENV,
  machineFlockKeys,
  readMachineFlockRowsFromFlock,
  writeMachineFlockRowToFlock,
  type AgentConfigId,
  type MachineFlockKey,
  type MachineFlockWritableFlock,
  type MachineId,
  type ProviderSetupStatus,
  type ProviderSetupTask,
  type WorkspaceId,
} from '@lody/shared';
import type { LoroRepo } from 'loro-repo';

import type { Logger } from '@/utils/logger';
import {
  hydrateCodexProviderCredential,
  stageCodexProviderCredential,
  storeCodexProviderCredential,
} from '@/agent/provider-credential-store';
import { ProviderSetupManager, type ProviderSetupManagerOptions } from './provider-setup-manager';

class FakeMachineFlock implements MachineFlockWritableFlock {
  readonly rows = new Map<string, { key: MachineFlockKey; value: unknown }>();
  readonly commitSnapshots: string[][] = [];

  scan(options?: { prefix?: readonly unknown[] }) {
    return [...this.rows.values()].filter((row) =>
      options?.prefix ? options.prefix.every((part, index) => row.key[index] === part) : true
    );
  }

  set(key: MachineFlockKey, value: unknown): void {
    this.rows.set(JSON.stringify(key), { key: [...key] as MachineFlockKey, value });
  }

  delete(key: MachineFlockKey): void {
    this.rows.delete(JSON.stringify(key));
  }

  commit(): void {
    this.commitSnapshots.push([...this.rows.keys()].sort());
  }
}

const createSilentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  setLevel: () => {},
  child: () => createSilentLogger(),
  close: async () => {},
});

const setupId = 'setup-1' as AgentConfigId;
const machineId = 'machine-1' as MachineId;
const workspaceId = 'workspace-1' as WorkspaceId;

function createSetup(status: ProviderSetupStatus = 'queued'): ProviderSetupTask {
  return {
    v: 1,
    id: setupId,
    machineId,
    config: {
      id: setupId,
      machineId,
      name: 'Codex',
      description: undefined,
      cliType: 'builtin',
      agentType: 'codex',
      env: {},
      prompt: '',
    },
    status,
    attempt: 1,
    createdAt: 10,
    updatedAt: 10,
  };
}

function createHarnessForFlock<TFlock extends MachineFlockWritableFlock>(
  flock: TFlock,
  overrides: Partial<ProviderSetupManagerOptions['execution']> = {},
  managerOverrides: Partial<
    Pick<ProviderSetupManagerOptions, 'stageCredential' | 'reconcileCredential'>
  > = {}
) {
  const flush = vi.fn(async () => undefined);
  const repo = {
    openFlockDoc: vi.fn(async () => ({ flock })),
    flush,
  } as unknown as LoroRepo;
  const execution = {
    getMachineAcpBinaryStatus: vi.fn(async () => ({
      type: 'machine/acp-binary-status_response' as const,
      machineId,
      agentType: 'codex',
      success: true,
      status: 'installed' as const,
    })),
    installMachineAcpBinary: vi.fn(async () => ({
      type: 'machine/acp-binary-install_response' as const,
      machineId,
      agentType: 'codex',
      success: true,
    })),
    refreshMachineAcpCapabilities: vi.fn(async () => ({
      type: 'machine/acp-capabilities-refresh_response' as const,
      machineId,
      configId: setupId,
      cliType: 'builtin' as const,
      agentType: 'codex',
      success: true,
      modes: [],
      models: [],
    })),
    ...overrides,
  } as ProviderSetupManagerOptions['execution'];
  const markMachineFlockDocDirty = vi.fn();
  const clearCredential = vi.fn(async () => undefined);
  const finalizeCredential = vi.fn(async () => undefined);
  const rollbackCredential = vi.fn(async () => undefined);
  const stageCredential = vi.fn(async () => ({
    finalize: finalizeCredential,
    rollback: rollbackCredential,
  }));
  const reconcileCredential = vi.fn(async () => undefined);
  const manager = new ProviderSetupManager({
    repo,
    workspaceId,
    machineId,
    execution,
    sync: { markMachineFlockDocDirty },
    logger: createSilentLogger(),
    clearCredential,
    stageCredential,
    reconcileCredential,
    ...managerOverrides,
  });
  return {
    flock,
    flush,
    execution,
    markMachineFlockDocDirty,
    clearCredential,
    stageCredential,
    reconcileCredential,
    finalizeCredential,
    rollbackCredential,
    manager,
  };
}

function createHarness(overrides: Partial<ProviderSetupManagerOptions['execution']> = {}) {
  return createHarnessForFlock(new FakeMachineFlock(), overrides);
}

function seedSetup(flock: MachineFlockWritableFlock, setup = createSetup()): void {
  writeMachineFlockRowToFlock(flock, {
    key: machineFlockKeys.providerSetup(setup.id),
    value: setup,
  });
}

function readState(flock: MachineFlockWritableFlock) {
  const rows = readMachineFlockRowsFromFlock(flock);
  return {
    setup: getMachineFlockProviderSetups(rows)[setupId],
    config: getMachineFlockAgentConfigs(rows)[setupId],
    cancellation: getMachineFlockProviderSetupCancellations(rows)[setupId],
    cleanups: getMachineFlockProviderCredentialCleanups(rows),
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('ProviderSetupManager', () => {
  it('publishes the config and removes the setup in one commit after a live probe', async () => {
    const harness = createHarness();
    seedSetup(harness.flock);

    await harness.manager.kick();

    expect(readState(harness.flock).config).toBeDefined();
    expect(readState(harness.flock).setup).toBeUndefined();
    const finalSnapshot = harness.flock.commitSnapshots.at(-1) ?? [];
    expect(finalSnapshot).toContain(JSON.stringify(machineFlockKeys.agentConfig(setupId)));
    expect(finalSnapshot).not.toContain(JSON.stringify(machineFlockKeys.providerSetup(setupId)));
    expect(harness.execution.refreshMachineAcpCapabilities).toHaveBeenCalledTimes(1);
    harness.manager.stop();
  });

  it('waits for UI authentication and resumes from the durable row', async () => {
    const refresh = vi
      .fn()
      .mockResolvedValueOnce({
        type: 'machine/acp-capabilities-refresh_response',
        machineId,
        configId: setupId,
        cliType: 'builtin',
        agentType: 'codex',
        success: false,
        authRequired: true,
      })
      .mockResolvedValueOnce({
        type: 'machine/acp-capabilities-refresh_response',
        machineId,
        configId: setupId,
        cliType: 'builtin',
        agentType: 'codex',
        success: true,
        modes: [],
        models: [],
      });
    const harness = createHarness({ refreshMachineAcpCapabilities: refresh });
    seedSetup(harness.flock);

    await harness.manager.kick();
    expect(readState(harness.flock).setup?.status).toBe('awaiting-auth');
    expect(readState(harness.flock).config).toBeUndefined();

    await harness.manager.resumeAfterAuthentication(setupId);
    await harness.manager.kick();
    expect(readState(harness.flock).config).toBeDefined();
    expect(refresh).toHaveBeenCalledTimes(2);
    harness.manager.stop();
  });

  it('recovers a task left in a non-interactive state after restart', async () => {
    const harness = createHarness();
    seedSetup(harness.flock, createSetup('preparing-runtime'));

    await harness.manager.kick();

    expect(readState(harness.flock).config).toBeDefined();
    expect(readState(harness.flock).setup).toBeUndefined();
    harness.manager.stop();
  });

  it('does not retry a failed task until the UI changes its state', async () => {
    const refresh = vi.fn(async () => ({
      type: 'machine/acp-capabilities-refresh_response' as const,
      machineId,
      configId: setupId,
      cliType: 'builtin' as const,
      agentType: 'codex',
      success: false,
    }));
    const harness = createHarness({ refreshMachineAcpCapabilities: refresh });
    seedSetup(harness.flock);

    await harness.manager.kick();
    expect(readState(harness.flock).setup?.status).toBe('failed');
    await harness.manager.kick();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(readState(harness.flock).config).toBeUndefined();
    harness.manager.stop();
  });

  it('reports an unexpected installer error as a runtime download failure', async () => {
    const harness = createHarness({
      getMachineAcpBinaryStatus: vi.fn(async () => ({
        type: 'machine/acp-binary-status_response',
        machineId,
        agentType: 'codex',
        success: true,
        status: 'not-installed',
      })),
      installMachineAcpBinary: vi.fn(async () => {
        throw new Error('download disconnected');
      }),
    });
    seedSetup(harness.flock);

    await harness.manager.kick();

    expect(readState(harness.flock).setup?.status).toBe('failed');
    expect(readState(harness.flock).setup?.failureCode).toBe('runtime-install-failed');
    expect(harness.execution.refreshMachineAcpCapabilities).not.toHaveBeenCalled();
    harness.manager.stop();
  });

  it('does not publish when the UI cancels an in-flight download', async () => {
    const installStarted = createDeferred<void>();
    const installFinished = createDeferred<{
      type: 'machine/acp-binary-install_response';
      machineId: MachineId;
      agentType: string;
      success: true;
    }>();
    const install = vi.fn(async () => {
      installStarted.resolve();
      return installFinished.promise;
    });
    const harness = createHarness({
      getMachineAcpBinaryStatus: vi.fn(async () => ({
        type: 'machine/acp-binary-status_response',
        machineId,
        agentType: 'codex',
        success: true,
        status: 'not-installed',
      })),
      installMachineAcpBinary: install,
    });
    seedSetup(harness.flock);

    const drain = harness.manager.kick();
    await installStarted.promise;
    expect(install).toHaveBeenCalledTimes(1);
    deleteMachineFlockRowFromFlock(harness.flock, machineFlockKeys.providerSetup(setupId));
    installFinished.resolve({
      type: 'machine/acp-binary-install_response',
      machineId,
      agentType: 'codex',
      success: true,
    });
    await drain;

    expect(readState(harness.flock)).toEqual({
      setup: undefined,
      config: undefined,
      cancellation: undefined,
      cleanups: [],
    });
    expect(harness.execution.refreshMachineAcpCapabilities).not.toHaveBeenCalled();
    harness.manager.stop();
  });

  it('converges cancellation over a config published concurrently on another replica', async () => {
    const rendererFlock = new Flock('renderer');
    const machineFlock = new Flock('machine');
    seedSetup(machineFlock, createSetup('verifying'));
    rendererFlock.importJson(machineFlock.exportJson());

    const refreshStarted = createDeferred<void>();
    const refreshFinished = createDeferred<{
      type: 'machine/acp-capabilities-refresh_response';
      machineId: MachineId;
      configId: AgentConfigId;
      cliType: 'builtin';
      agentType: string;
      success: true;
      modes: never[];
      models: never[];
    }>();
    const harness = createHarnessForFlock(machineFlock, {
      refreshMachineAcpCapabilities: vi.fn(async () => {
        refreshStarted.resolve();
        return refreshFinished.promise;
      }),
    });

    const publish = harness.manager.kick();
    await refreshStarted.promise;
    expect(readState(machineFlock).setup?.status).toBe('verifying');

    applyProviderSetupCancellationToFlock(rendererFlock, {
      v: 1,
      id: setupId,
      machineId,
      cancelledAt: 20,
    });
    refreshFinished.resolve({
      type: 'machine/acp-capabilities-refresh_response',
      machineId,
      configId: setupId,
      cliType: 'builtin',
      agentType: 'codex',
      success: true,
      modes: [],
      models: [],
    });
    await publish;
    expect(readState(machineFlock).config).toBeDefined();

    machineFlock.importJson(rendererFlock.exportJson());
    rendererFlock.importJson(machineFlock.exportJson());
    expect(readState(machineFlock).config).toBeDefined();
    expect(readState(rendererFlock).config).toBeDefined();

    await harness.manager.kick();
    rendererFlock.importJson(machineFlock.exportJson());
    machineFlock.importJson(rendererFlock.exportJson());

    for (const replica of [rendererFlock, machineFlock]) {
      expect(readState(replica)).toEqual({
        setup: undefined,
        config: undefined,
        cancellation: expect.objectContaining({ id: setupId, machineId }),
        cleanups: [],
      });
    }
    expect(harness.clearCredential).not.toHaveBeenCalled();
    harness.manager.stop();
  });

  it('stores the verified key and publishes only for the exact setup revision', async () => {
    const harness = createHarness();
    const oldConfig = createSetup().config;
    writeMachineFlockRowToFlock(harness.flock, {
      key: machineFlockKeys.agentConfig(setupId),
      value: oldConfig,
    });
    const replacement: ProviderSetupTask = {
      ...createSetup('awaiting-auth'),
      setupRevision: 'revision-new',
      replacesPublishedConfig: true,
      config: {
        ...oldConfig,
        env: buildLodyCodexCustomProviderEnv({}, { baseUrl: 'https://relay.example.com/v1' }),
      },
    };
    seedSetup(harness.flock, replacement);

    await harness.manager.commitCredentialSetup(setupId, 'revision-new', 'new-key');

    expect(readState(harness.flock).config?.env).toEqual(replacement.config.env);
    expect(readState(harness.flock).setup).toBeUndefined();
    expect(harness.execution.refreshMachineAcpCapabilities).not.toHaveBeenCalled();
    expect(harness.stageCredential).toHaveBeenCalledWith(
      workspaceId,
      replacement.config,
      'new-key',
      oldConfig
    );
    expect(harness.finalizeCredential).toHaveBeenCalledTimes(1);
    expect(harness.rollbackCredential).not.toHaveBeenCalled();
    harness.manager.stop();
  });

  it('rejects a superseded credential RPC without storing an orphan key', async () => {
    const harness = createHarness();
    const oldConfig = createSetup().config;
    writeMachineFlockRowToFlock(harness.flock, {
      key: machineFlockKeys.agentConfig(setupId),
      value: oldConfig,
    });
    const replacement: ProviderSetupTask = {
      ...createSetup('awaiting-auth'),
      setupRevision: 'revision-new',
      replacesPublishedConfig: true,
      config: {
        ...oldConfig,
        env: buildLodyCodexCustomProviderEnv({}, { baseUrl: 'https://relay.example.com/v1' }),
      },
    };
    seedSetup(harness.flock, replacement);

    await expect(
      harness.manager.commitCredentialSetup(setupId, 'revision-old', 'old-candidate-key')
    ).rejects.toThrow(/cancelled or replaced/);

    expect(readState(harness.flock).config).toEqual(oldConfig);
    expect(readState(harness.flock).setup).toEqual(replacement);
    expect(harness.stageCredential).not.toHaveBeenCalled();
    harness.manager.stop();
  });

  it('keeps both credential bindings when publication durability is uncertain', async () => {
    const harness = createHarness();
    const oldConfig = {
      ...createSetup().config,
      env: buildLodyCodexCustomProviderEnv({}, { baseUrl: 'https://old.example.com/v1' }),
    };
    writeMachineFlockRowToFlock(harness.flock, {
      key: machineFlockKeys.agentConfig(setupId),
      value: oldConfig,
    });
    const replacement: ProviderSetupTask = {
      ...createSetup('awaiting-auth'),
      setupRevision: 'revision-new',
      replacesPublishedConfig: true,
      config: {
        ...oldConfig,
        env: buildLodyCodexCustomProviderEnv({}, { baseUrl: 'https://new.example.com/v1' }),
      },
    };
    seedSetup(harness.flock, replacement);
    harness.flush.mockRejectedValueOnce(new Error('publish flush failed'));

    await expect(
      harness.manager.commitCredentialSetup(setupId, 'revision-new', 'new-key')
    ).rejects.toThrow('publish flush failed');

    expect(harness.stageCredential).toHaveBeenCalledWith(
      workspaceId,
      replacement.config,
      'new-key',
      oldConfig
    );
    expect(harness.finalizeCredential).not.toHaveBeenCalled();
    expect(harness.rollbackCredential).not.toHaveBeenCalled();
    harness.manager.stop();
  });

  it('keeps both real credential bindings launchable when publish flush throws', async () => {
    const previousDataDir = process.env.LODY_DATA_DIR;
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'lody-provider-commit-'));
    process.env.LODY_DATA_DIR = dataDir;
    const flock = new FakeMachineFlock();
    const harness = createHarnessForFlock(
      flock,
      {},
      { stageCredential: stageCodexProviderCredential }
    );
    const oldConfig = {
      ...createSetup().config,
      env: buildLodyCodexCustomProviderEnv({}, { baseUrl: 'https://old.example.com/v1' }),
    };
    const replacement: ProviderSetupTask = {
      ...createSetup('awaiting-auth'),
      setupRevision: 'revision-new',
      replacesPublishedConfig: true,
      config: {
        ...oldConfig,
        env: buildLodyCodexCustomProviderEnv({}, { baseUrl: 'https://new.example.com/v1' }),
      },
    };

    try {
      await storeCodexProviderCredential(workspaceId, oldConfig, 'old-key');
      writeMachineFlockRowToFlock(flock, {
        key: machineFlockKeys.agentConfig(setupId),
        value: oldConfig,
      });
      seedSetup(flock, replacement);
      harness.flush.mockRejectedValueOnce(new Error('publish flush failed'));

      await expect(
        harness.manager.commitCredentialSetup(setupId, 'revision-new', 'new-key')
      ).rejects.toThrow('publish flush failed');

      expect((await hydrateCodexProviderCredential(workspaceId, oldConfig)).env).toMatchObject({
        [LODY_CODEX_API_KEY_ENV]: 'old-key',
      });
      expect(
        (await hydrateCodexProviderCredential(workspaceId, replacement.config)).env
      ).toMatchObject({
        [LODY_CODEX_API_KEY_ENV]: 'new-key',
      });
    } finally {
      harness.manager.stop();
      if (previousDataDir === undefined) delete process.env.LODY_DATA_DIR;
      else process.env.LODY_DATA_DIR = previousDataDir;
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('preserves metadata published while a credential replacement is being verified', async () => {
    const harness = createHarness();
    const currentConfig = {
      ...createSetup().config,
      name: 'New Name',
      prompt: 'new prompt',
      env: buildLodyCodexCustomProviderEnv({}, { baseUrl: 'https://old.example.com/v1' }),
    };
    writeMachineFlockRowToFlock(harness.flock, {
      key: machineFlockKeys.agentConfig(setupId),
      value: currentConfig,
    });
    const replacement: ProviderSetupTask = {
      ...createSetup('awaiting-auth'),
      setupRevision: 'revision-new',
      replacesPublishedConfig: true,
      config: {
        ...currentConfig,
        name: 'Old Name',
        prompt: 'old prompt',
        env: buildLodyCodexCustomProviderEnv({}, { baseUrl: 'https://new.example.com/v1' }),
      },
    };
    seedSetup(harness.flock, replacement);

    await harness.manager.commitCredentialSetup(setupId, 'revision-new', 'new-key');

    expect(readState(harness.flock).config).toEqual({
      ...replacement.config,
      name: 'New Name',
      prompt: 'new prompt',
    });
    harness.manager.stop();
  });

  it('replays credential cleanup after the referenced config disappears', async () => {
    const harness = createHarness();
    const config = {
      ...createSetup().config,
      env: buildLodyCodexCustomProviderEnv({}, { baseUrl: 'https://relay.example.com/v1' }),
    };
    writeMachineFlockRowToFlock(harness.flock, {
      key: machineFlockKeys.agentConfig(setupId),
      value: config,
    });
    writeMachineFlockRowToFlock(harness.flock, {
      key: machineFlockKeys.providerCredentialCleanup(setupId),
      value: {
        v: 1,
        id: setupId,
        machineId,
        requestedAt: 20,
      },
    });

    await harness.manager.kick();
    expect(harness.clearCredential).not.toHaveBeenCalled();
    expect(readState(harness.flock).cleanups).toHaveLength(1);

    deleteMachineFlockRowFromFlock(harness.flock, machineFlockKeys.agentConfig(setupId));
    await harness.manager.kick();
    expect(harness.clearCredential).toHaveBeenCalledWith(workspaceId, setupId);
    expect(readState(harness.flock).cleanups).toEqual([]);
    harness.manager.stop();
  });
});
