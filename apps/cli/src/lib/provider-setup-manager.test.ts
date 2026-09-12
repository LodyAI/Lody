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
  buildLodyCodexCustomProviderEnv,
  getLodyCodexCustomProvider,
  LODY_CODEX_API_KEY_ENV,
  machineFlockKeys,
  readMachineFlockRowsFromFlock,
  withLodyCodexCredentialRevision,
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
  listCodexProviderCredentialConfigIds,
  reconcileCodexProviderCredential,
  stageCodexProviderCredential,
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

function expectCredentialRevision(
  config: ProviderSetupTask['config'] | undefined,
  revision: string
): asserts config is ProviderSetupTask['config'] {
  expect(config).toBeDefined();
  expect(getLodyCodexCustomProvider(config?.env)).toMatchObject({
    credentialRevision: revision,
  });
}

function createHarnessForFlock<TFlock extends MachineFlockWritableFlock>(
  flock: TFlock,
  overrides: Partial<ProviderSetupManagerOptions['execution']> = {},
  managerOverrides: Partial<
    Pick<
      ProviderSetupManagerOptions,
      'listCredentialConfigIds' | 'stageCredential' | 'reconcileCredential'
    >
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
    probeMachineAcpCapabilitiesForProviderSetup: vi.fn(async () =>
      deferredProbe({
        type: 'machine/acp-capabilities-refresh_response' as const,
        machineId,
        configId: setupId,
        cliType: 'builtin' as const,
        agentType: 'codex',
        success: true,
        modes: [],
        models: [],
      })
    ),
    ...overrides,
  } as ProviderSetupManagerOptions['execution'];
  const markMachineFlockDocDirty = vi.fn();
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
    listCredentialConfigIds: vi.fn(async () => []),
    stageCredential,
    reconcileCredential,
    ...managerOverrides,
  });
  return {
    flock,
    flush,
    execution,
    markMachineFlockDocDirty,
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
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function deferredProbe<T>(response: T) {
  return { response, publishCapabilities: vi.fn(async () => undefined) };
}

async function seedCredential(config: ProviderSetupTask['config'], apiKey: string): Promise<void> {
  const staged = await stageCodexProviderCredential(workspaceId, config, apiKey);
  await staged.finalize();
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
    expect(harness.execution.probeMachineAcpCapabilitiesForProviderSetup).toHaveBeenCalledTimes(1);
    harness.manager.stop();
  });

  it('waits for UI authentication and resumes from the durable row', async () => {
    const refresh = vi
      .fn()
      .mockResolvedValueOnce(
        deferredProbe({
          type: 'machine/acp-capabilities-refresh_response',
          machineId,
          configId: setupId,
          cliType: 'builtin',
          agentType: 'codex',
          success: false,
          authRequired: true,
        })
      )
      .mockResolvedValueOnce(
        deferredProbe({
          type: 'machine/acp-capabilities-refresh_response',
          machineId,
          configId: setupId,
          cliType: 'builtin',
          agentType: 'codex',
          success: true,
          modes: [],
          models: [],
        })
      );
    const harness = createHarness({ probeMachineAcpCapabilitiesForProviderSetup: refresh });
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
    const refresh = vi.fn(async () =>
      deferredProbe({
        type: 'machine/acp-capabilities-refresh_response' as const,
        machineId,
        configId: setupId,
        cliType: 'builtin' as const,
        agentType: 'codex',
        success: false,
      })
    );
    const harness = createHarness({ probeMachineAcpCapabilitiesForProviderSetup: refresh });
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
    expect(harness.execution.probeMachineAcpCapabilitiesForProviderSetup).not.toHaveBeenCalled();
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
    });
    expect(harness.execution.probeMachineAcpCapabilitiesForProviderSetup).not.toHaveBeenCalled();
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
      probeMachineAcpCapabilitiesForProviderSetup: vi.fn(async () => {
        refreshStarted.resolve();
        return deferredProbe(await refreshFinished.promise);
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
      });
    }
    harness.manager.stop();
  });

  it('upgrades an exact marker to wildcard before a stale replica can publish R2', async () => {
    const rendererFlock = new Flock('wildcard-upgrade-renderer');
    const machineFlock = new Flock('wildcard-upgrade-machine');
    const replacement: ProviderSetupTask = {
      ...createSetup('awaiting-auth'),
      setupRevision: 'revision-2',
      config: {
        ...createSetup().config,
        env: buildLodyCodexCustomProviderEnv({}, { baseUrl: 'https://replacement.example.com/v1' }),
      },
    };
    seedSetup(machineFlock, replacement);
    rendererFlock.importJson(machineFlock.exportJson());

    const stageStarted = createDeferred<void>();
    const releaseStage = createDeferred<void>();
    const rollback = vi.fn(async () => undefined);
    const stageCredential = vi.fn(async () => {
      stageStarted.resolve();
      await releaseStage.promise;
      return { finalize: vi.fn(async () => undefined), rollback };
    });
    const harness = createHarnessForFlock(machineFlock, {}, { stageCredential });
    const stalePublication = harness.manager.commitCredentialSetup(
      setupId,
      'revision-2',
      'stale-r2-key'
    );
    await stageStarted.promise;

    rendererFlock.txn(() => {
      rendererFlock.set(machineFlockKeys.providerSetupCancellation(setupId), {
        v: 1,
        id: setupId,
        machineId,
        setupRevision: 'revision-1',
        preservePublishedConfig: true,
        cancelledAt: 20,
      });
    });
    expect(
      applyProviderSetupCancellationToFlock(rendererFlock, {
        v: 1,
        id: setupId,
        machineId,
        cancelledAt: 30,
      })
    ).toBe(true);
    expect(readState(rendererFlock)).toEqual({
      setup: undefined,
      config: undefined,
      cancellation: {
        v: 1,
        id: setupId,
        machineId,
        cancelledAt: 30,
      },
    });

    machineFlock.importJson(rendererFlock.exportJson());
    releaseStage.resolve();
    await expect(stalePublication).rejects.toThrow(/cancelled or replaced/);
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(readState(machineFlock).cancellation).not.toHaveProperty('setupRevision');
    expect(readState(machineFlock).config).toBeUndefined();
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

    const publishCapabilities = vi.fn(async () => undefined);
    await harness.manager.commitCredentialSetup(
      setupId,
      'revision-new',
      'new-key',
      undefined,
      undefined,
      publishCapabilities
    );

    const published = readState(harness.flock).config;
    expectCredentialRevision(published, 'revision-new');
    expect(published.env).toMatchObject({
      CODEX_CONFIG: replacement.config.env.CODEX_CONFIG,
    });
    expect(readState(harness.flock).setup).toBeUndefined();
    expect(harness.execution.probeMachineAcpCapabilitiesForProviderSetup).not.toHaveBeenCalled();
    const [stagedWorkspaceId, stagedConfig, stagedKey, stagedPublishedConfig] =
      harness.stageCredential.mock.calls[0]!;
    expect(stagedWorkspaceId).toBe(workspaceId);
    expect(stagedConfig.env).toEqual(published.env);
    expect(stagedKey).toBe('new-key');
    expect(stagedPublishedConfig).toMatchObject({ id: oldConfig.id, env: oldConfig.env });
    expect(harness.finalizeCredential).toHaveBeenCalledTimes(1);
    expect(harness.rollbackCredential).not.toHaveBeenCalled();
    expect(publishCapabilities).toHaveBeenCalledTimes(1);
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

    const publishCapabilities = vi.fn(async () => undefined);
    await expect(
      harness.manager.commitCredentialSetup(
        setupId,
        'revision-old',
        'old-candidate-key',
        undefined,
        undefined,
        publishCapabilities
      )
    ).rejects.toThrow(/cancelled or replaced/);

    expect(readState(harness.flock).config).toEqual(oldConfig);
    expect(readState(harness.flock).setup).toEqual(replacement);
    expect(harness.stageCredential).not.toHaveBeenCalled();
    expect(publishCapabilities).not.toHaveBeenCalled();
    harness.manager.stop();
  });

  it('rejects a staged stale RPC after an atomic cancellation-to-setup replacement arrives', async () => {
    const rendererFlock = new Flock('provider-readd-renderer');
    const machineFlock = new Flock('provider-readd-machine');
    const staleStageStarted = createDeferred<void>();
    const releaseStaleStage = createDeferred<void>();
    const rollback = vi.fn(async () => undefined);
    const finalize = vi.fn(async () => undefined);
    let stageCount = 0;
    const stageCredential = vi.fn(async () => {
      stageCount += 1;
      if (stageCount === 1) {
        staleStageStarted.resolve();
        await releaseStaleStage.promise;
      }
      return { rollback, finalize };
    });
    const publishedChatGptConfig = createSetup().config;
    const staleSetup: ProviderSetupTask = {
      ...createSetup('awaiting-auth'),
      setupRevision: 'revision-1',
      replacesPublishedConfig: true,
      config: {
        ...publishedChatGptConfig,
        env: buildLodyCodexCustomProviderEnv({}, { baseUrl: 'https://stale.example.com/v1' }),
      },
    };
    const nextSetup: ProviderSetupTask = {
      ...staleSetup,
      setupRevision: 'revision-2',
      config: {
        ...publishedChatGptConfig,
        env: buildLodyCodexCustomProviderEnv({}, { baseUrl: 'https://next.example.com/v1' }),
      },
    };
    writeMachineFlockRowToFlock(machineFlock, {
      key: machineFlockKeys.agentConfig(setupId),
      value: publishedChatGptConfig,
    });
    seedSetup(machineFlock, staleSetup);
    rendererFlock.importJson(machineFlock.exportJson());
    const harness = createHarnessForFlock(machineFlock, {}, { stageCredential });

    const stalePublication = harness.manager.commitCredentialSetup(
      setupId,
      'revision-1',
      'stale-key'
    );
    await staleStageStarted.promise;

    rendererFlock.txn(() => {
      rendererFlock.set(machineFlockKeys.providerSetupCancellation(setupId), {
        v: 1,
        id: setupId,
        machineId,
        cancelledAt: 20,
        preservePublishedConfig: true,
      });
      rendererFlock.delete(machineFlockKeys.providerSetup(setupId));
    });
    expect(readState(rendererFlock)).toEqual({
      setup: undefined,
      config: publishedChatGptConfig,
      cancellation: expect.objectContaining({ id: setupId }),
    });

    rendererFlock.txn(() => {
      rendererFlock.set(machineFlockKeys.providerSetup(setupId), nextSetup);
      rendererFlock.delete(machineFlockKeys.providerSetupCancellation(setupId));
    });
    expect(readState(rendererFlock)).toEqual({
      setup: nextSetup,
      config: publishedChatGptConfig,
      cancellation: undefined,
    });
    expect(readState(machineFlock).config).toEqual(publishedChatGptConfig);

    machineFlock.importJson(rendererFlock.exportJson());
    releaseStaleStage.resolve();
    await expect(stalePublication).rejects.toThrow(/cancelled or replaced/);
    expect(readState(machineFlock)).toEqual({
      setup: nextSetup,
      config: publishedChatGptConfig,
      cancellation: undefined,
    });
    expect(rollback).toHaveBeenCalledTimes(1);

    await expect(
      harness.manager.commitCredentialSetup(setupId, 'revision-2', 'next-key')
    ).resolves.toBe('durable');
    const nextState = readState(machineFlock);
    expect(nextState.setup).toBeUndefined();
    expect(nextState.cancellation).toBeUndefined();
    expect(nextState.config).toMatchObject({
      id: nextSetup.config.id,
      env: expect.objectContaining({ CODEX_CONFIG: nextSetup.config.env.CODEX_CONFIG }),
    });
    expectCredentialRevision(nextState.config, 'revision-2');
    expect(finalize).toHaveBeenCalledTimes(1);
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

    const publishCapabilities = vi.fn(async () => undefined);
    await expect(
      harness.manager.commitCredentialSetup(
        setupId,
        'revision-new',
        'new-key',
        undefined,
        undefined,
        publishCapabilities
      )
    ).resolves.toBe('uncertain');

    const [stagedWorkspaceId, stagedConfig, stagedKey, stagedPublishedConfig] =
      harness.stageCredential.mock.calls[0]!;
    expect(stagedWorkspaceId).toBe(workspaceId);
    expect(stagedConfig.env.CODEX_CONFIG).toBe(replacement.config.env.CODEX_CONFIG);
    expect(stagedKey).toBe('new-key');
    expect(stagedPublishedConfig).toMatchObject({ id: oldConfig.id, env: oldConfig.env });
    expectCredentialRevision(stagedConfig, 'revision-new');
    expect(harness.finalizeCredential).not.toHaveBeenCalled();
    expect(harness.rollbackCredential).not.toHaveBeenCalled();
    expect(publishCapabilities).not.toHaveBeenCalled();
    harness.manager.stop();
  });

  it('rolls back credential staging when the Flock publication commit throws', async () => {
    const harness = createHarness();
    seedSetup(harness.flock, {
      ...createSetup('awaiting-auth'),
      setupRevision: 'revision-commit-failure',
      config: {
        ...createSetup().config,
        env: buildLodyCodexCustomProviderEnv(
          {},
          { baseUrl: 'https://commit-failure.example.com/v1' }
        ),
      },
    });
    const committedSnapshotCount = harness.flock.commitSnapshots.length;
    vi.spyOn(harness.flock, 'commit').mockImplementationOnce(() => {
      throw new Error('Flock commit failed');
    });
    const markCommitted = vi.fn();

    await expect(
      harness.manager.commitCredentialSetup(
        setupId,
        'revision-commit-failure',
        'new-key',
        undefined,
        markCommitted
      )
    ).rejects.toThrow('Flock commit failed');

    expect(markCommitted).not.toHaveBeenCalled();
    expect(harness.rollbackCredential).toHaveBeenCalledTimes(1);
    expect(harness.finalizeCredential).not.toHaveBeenCalled();
    expect(harness.flock.commitSnapshots).toHaveLength(committedSnapshotCount);
    harness.manager.stop();
  });

  it('does not prune either real credential binding on a later event drain after flush throws', async () => {
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
      await harness.manager.kick({ recoverCredentials: true });
      await seedCredential(oldConfig, 'old-key');
      writeMachineFlockRowToFlock(flock, {
        key: machineFlockKeys.agentConfig(setupId),
        value: oldConfig,
      });
      seedSetup(flock, replacement);
      harness.flush.mockRejectedValueOnce(new Error('publish flush failed'));

      await expect(
        harness.manager.commitCredentialSetup(setupId, 'revision-new', 'new-key')
      ).resolves.toBe('uncertain');

      writeMachineFlockRowToFlock(flock, {
        key: machineFlockKeys.providerSetupCancellation(setupId),
        value: {
          v: 1,
          id: setupId,
          machineId,
          cancelledAt: 20,
          preservePublishedConfig: true,
          setupRevision: 'revision-new',
        },
      });
      await harness.manager.kick({ recoverCredentials: true });

      expect((await hydrateCodexProviderCredential(workspaceId, oldConfig)).env).toMatchObject({
        [LODY_CODEX_API_KEY_ENV]: 'old-key',
      });
      const uncertainConfig = readState(flock).config;
      expectCredentialRevision(uncertainConfig, 'revision-new');
      expect(
        (await hydrateCodexProviderCredential(workspaceId, uncertainConfig)).env
      ).toMatchObject({
        [LODY_CODEX_API_KEY_ENV]: 'new-key',
      });

      const recoveredFlock = new FakeMachineFlock();
      writeMachineFlockRowToFlock(recoveredFlock, {
        key: machineFlockKeys.agentConfig(setupId),
        value: oldConfig,
      });
      const recoveredHarness = createHarnessForFlock(
        recoveredFlock,
        {},
        {
          reconcileCredential: reconcileCodexProviderCredential,
        }
      );
      try {
        await recoveredHarness.manager.kick({ recoverCredentials: true });
        expect((await hydrateCodexProviderCredential(workspaceId, oldConfig)).env).toMatchObject({
          [LODY_CODEX_API_KEY_ENV]: 'old-key',
        });
      } finally {
        recoveredHarness.manager.stop();
      }
    } finally {
      harness.manager.stop();
      if (previousDataDir === undefined) delete process.env.LODY_DATA_DIR;
      else process.env.LODY_DATA_DIR = previousDataDir;
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('removes a locally enumerated credential after a legacy direct config delete', async () => {
    const previousDataDir = process.env.LODY_DATA_DIR;
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'lody-provider-orphan-recovery-'));
    process.env.LODY_DATA_DIR = dataDir;
    const orphanConfig = {
      ...createSetup().config,
      id: 'deleted-config' as AgentConfigId,
      env: buildLodyCodexCustomProviderEnv({}, { baseUrl: 'https://orphan.example.com/v1' }),
    };
    const harness = createHarnessForFlock(
      new FakeMachineFlock(),
      {},
      {
        listCredentialConfigIds: listCodexProviderCredentialConfigIds,
        reconcileCredential: reconcileCodexProviderCredential,
      }
    );

    try {
      await seedCredential(orphanConfig, 'orphan-key');
      expect((await hydrateCodexProviderCredential(workspaceId, orphanConfig)).env).toMatchObject({
        [LODY_CODEX_API_KEY_ENV]: 'orphan-key',
      });

      await harness.manager.kick({ recoverCredentials: true });

      expect(await hydrateCodexProviderCredential(workspaceId, orphanConfig)).toEqual(orphanConfig);
    } finally {
      harness.manager.stop();
      if (previousDataDir === undefined) delete process.env.LODY_DATA_DIR;
      else process.env.LODY_DATA_DIR = previousDataDir;
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('re-reads each config under its mutation lock during startup credential recovery', async () => {
    const previousDataDir = process.env.LODY_DATA_DIR;
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'lody-provider-recovery-race-'));
    process.env.LODY_DATA_DIR = dataDir;
    const configAId = 'setup-a' as AgentConfigId;
    const configBId = 'setup-b' as AgentConfigId;
    const recoveryReachedA = createDeferred<void>();
    const releaseA = createDeferred<void>();
    const flock = new FakeMachineFlock();
    const reconcileCredential: typeof reconcileCodexProviderCredential = async (
      currentWorkspaceId,
      configId,
      referencedConfigs
    ) => {
      if (configId === configAId) {
        recoveryReachedA.resolve();
        await releaseA.promise;
      }
      await reconcileCodexProviderCredential(currentWorkspaceId, configId, referencedConfigs);
    };
    const harness = createHarnessForFlock(
      flock,
      {},
      {
        stageCredential: stageCodexProviderCredential,
        reconcileCredential,
      }
    );
    const configA = {
      ...createSetup().config,
      id: configAId,
      env: buildLodyCodexCustomProviderEnv({}, { baseUrl: 'https://a.example.com/v1' }),
    };
    const oldConfigB = {
      ...createSetup().config,
      id: configBId,
      env: buildLodyCodexCustomProviderEnv({}, { baseUrl: 'https://b-old.example.com/v1' }),
    };
    const newConfigB = {
      ...oldConfigB,
      env: buildLodyCodexCustomProviderEnv({}, { baseUrl: 'https://b-new.example.com/v1' }),
    };
    const replacementB: ProviderSetupTask = {
      ...createSetup('awaiting-auth'),
      id: configBId,
      setupRevision: 'revision-b-new',
      replacesPublishedConfig: true,
      config: newConfigB,
    };
    let recovery: Promise<void> | undefined;

    try {
      await seedCredential(configA, 'a-old-key');
      await seedCredential(oldConfigB, 'b-old-key');
      writeMachineFlockRowToFlock(flock, {
        key: machineFlockKeys.agentConfig(configAId),
        value: configA,
      });
      writeMachineFlockRowToFlock(flock, {
        key: machineFlockKeys.agentConfig(configBId),
        value: oldConfigB,
      });

      recovery = harness.manager.kick({ recoverCredentials: true });
      await recoveryReachedA.promise;

      seedSetup(flock, replacementB);
      await expect(
        harness.manager.commitCredentialSetup(configBId, 'revision-b-new', 'b-new-key')
      ).resolves.toBe('durable');

      releaseA.resolve();
      await recovery;

      const publishedConfigB = getMachineFlockAgentConfigs(readMachineFlockRowsFromFlock(flock))[
        configBId
      ];
      expectCredentialRevision(publishedConfigB, 'revision-b-new');
      expect(
        (await hydrateCodexProviderCredential(workspaceId, publishedConfigB)).env
      ).toMatchObject({
        [LODY_CODEX_API_KEY_ENV]: 'b-new-key',
      });
    } finally {
      releaseA.resolve();
      await recovery?.catch(() => undefined);
      harness.manager.stop();
      if (previousDataDir === undefined) delete process.env.LODY_DATA_DIR;
      else process.env.LODY_DATA_DIR = previousDataDir;
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('retains both same-endpoint credential generations when durability is uncertain', async () => {
    const previousDataDir = process.env.LODY_DATA_DIR;
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'lody-provider-rotation-'));
    process.env.LODY_DATA_DIR = dataDir;
    const flock = new FakeMachineFlock();
    const harness = createHarnessForFlock(
      flock,
      {},
      { stageCredential: stageCodexProviderCredential }
    );
    const publishedConfig = {
      ...createSetup().config,
      env: buildLodyCodexCustomProviderEnv({}, { baseUrl: 'https://relay.example.com/v1' }),
    };
    const replacement: ProviderSetupTask = {
      ...createSetup('awaiting-auth'),
      setupRevision: 'revision-rotation',
      replacesPublishedConfig: true,
      config: publishedConfig,
    };

    try {
      await seedCredential(publishedConfig, 'old-key');
      writeMachineFlockRowToFlock(flock, {
        key: machineFlockKeys.agentConfig(setupId),
        value: publishedConfig,
      });
      seedSetup(flock, replacement);
      harness.flush.mockRejectedValueOnce(new Error('publish flush failed'));

      await expect(
        harness.manager.commitCredentialSetup(setupId, 'revision-rotation', 'new-key')
      ).resolves.toBe('uncertain');

      const uncertainConfig = readState(flock).config;
      expectCredentialRevision(uncertainConfig, 'revision-rotation');
      expect(readState(flock).setup).toBeUndefined();
      expect(
        (await hydrateCodexProviderCredential(workspaceId, uncertainConfig)).env
      ).toMatchObject({ [LODY_CODEX_API_KEY_ENV]: 'new-key' });
      expect(
        (await hydrateCodexProviderCredential(workspaceId, publishedConfig)).env
      ).toMatchObject({ [LODY_CODEX_API_KEY_ENV]: 'old-key' });
    } finally {
      harness.manager.stop();
      if (previousDataDir === undefined) delete process.env.LODY_DATA_DIR;
      else process.env.LODY_DATA_DIR = previousDataDir;
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('restores the published key when same-endpoint staging crashes before Flock commit', async () => {
    const previousDataDir = process.env.LODY_DATA_DIR;
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'lody-provider-precommit-crash-'));
    process.env.LODY_DATA_DIR = dataDir;
    const flock = new FakeMachineFlock();
    const publishedConfig = {
      ...createSetup().config,
      env: withLodyCodexCredentialRevision(
        buildLodyCodexCustomProviderEnv({}, { baseUrl: 'https://relay.example.com/v1' }),
        'revision-published'
      ),
    };
    const desiredConfig = {
      ...publishedConfig,
      env: withLodyCodexCredentialRevision(publishedConfig.env, 'revision-rotation'),
    };
    const pendingSetup: ProviderSetupTask = {
      ...createSetup('awaiting-auth'),
      setupRevision: 'revision-rotation',
      replacesPublishedConfig: true,
      config: publishedConfig,
    };
    const harness = createHarnessForFlock(
      flock,
      {},
      { reconcileCredential: reconcileCodexProviderCredential }
    );

    try {
      await seedCredential(publishedConfig, 'old-key');
      writeMachineFlockRowToFlock(flock, {
        key: machineFlockKeys.agentConfig(setupId),
        value: publishedConfig,
      });
      seedSetup(flock, pendingSetup);
      await stageCodexProviderCredential(workspaceId, desiredConfig, 'new-key', publishedConfig);

      await harness.manager.kick({ recoverCredentials: true });
      writeMachineFlockRowToFlock(flock, {
        key: machineFlockKeys.providerSetupCancellation(setupId),
        value: {
          v: 1,
          id: setupId,
          machineId,
          cancelledAt: 20,
          preservePublishedConfig: true,
          setupRevision: 'revision-rotation',
        },
      });
      await harness.manager.kick();

      expect(readState(flock).config).toEqual(publishedConfig);
      expect(readState(flock).setup).toBeUndefined();
      expect(
        (await hydrateCodexProviderCredential(workspaceId, publishedConfig)).env
      ).toMatchObject({ [LODY_CODEX_API_KEY_ENV]: 'old-key' });
      expect(
        (await hydrateCodexProviderCredential(workspaceId, desiredConfig)).env[
          LODY_CODEX_API_KEY_ENV
        ]
      ).toBeUndefined();
    } finally {
      harness.manager.stop();
      if (previousDataDir === undefined) delete process.env.LODY_DATA_DIR;
      else process.env.LODY_DATA_DIR = previousDataDir;
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('recovers the rotated key after Flock commit when credential finalize did not run', async () => {
    const previousDataDir = process.env.LODY_DATA_DIR;
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'lody-provider-finalize-crash-'));
    process.env.LODY_DATA_DIR = dataDir;
    const flock = new FakeMachineFlock();
    const stageWithoutFinalize: typeof stageCodexProviderCredential = async (...args) => {
      const staged = await stageCodexProviderCredential(...args);
      return {
        rollback: staged.rollback,
        finalize: async () => {
          throw new Error('simulated daemon crash before finalize');
        },
      };
    };
    const harness = createHarnessForFlock(flock, {}, { stageCredential: stageWithoutFinalize });
    const publishedConfig = {
      ...createSetup().config,
      env: buildLodyCodexCustomProviderEnv({}, { baseUrl: 'https://relay.example.com/v1' }),
    };
    const replacement: ProviderSetupTask = {
      ...createSetup('awaiting-auth'),
      setupRevision: 'revision-rotation',
      replacesPublishedConfig: true,
      config: publishedConfig,
    };

    try {
      await seedCredential(publishedConfig, 'old-key');
      writeMachineFlockRowToFlock(flock, {
        key: machineFlockKeys.agentConfig(setupId),
        value: publishedConfig,
      });
      seedSetup(flock, replacement);

      await expect(
        harness.manager.commitCredentialSetup(setupId, 'revision-rotation', 'new-key')
      ).resolves.toBe('durable');
      const committedConfig = readState(flock).config;
      expectCredentialRevision(committedConfig, 'revision-rotation');
      harness.manager.stop();

      const recoveredHarness = createHarnessForFlock(
        flock,
        {},
        { reconcileCredential: reconcileCodexProviderCredential }
      );
      try {
        await recoveredHarness.manager.kick({ recoverCredentials: true });
        expect(
          (await hydrateCodexProviderCredential(workspaceId, committedConfig)).env
        ).toMatchObject({ [LODY_CODEX_API_KEY_ENV]: 'new-key' });
        expect(
          (await hydrateCodexProviderCredential(workspaceId, publishedConfig)).env[
            LODY_CODEX_API_KEY_ENV
          ]
        ).toBeUndefined();
      } finally {
        recoveredHarness.manager.stop();
      }
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

    const published = readState(harness.flock).config;
    expectCredentialRevision(published, 'revision-new');
    expect(published).toMatchObject({
      name: 'New Name',
      prompt: 'new prompt',
      env: expect.objectContaining({ CODEX_CONFIG: replacement.config.env.CODEX_CONFIG }),
    });
    harness.manager.stop();
  });

  it('clears an offline-deleted provider credential from its wildcard cancellation', async () => {
    const previousDataDir = process.env.LODY_DATA_DIR;
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'lody-provider-delete-'));
    process.env.LODY_DATA_DIR = dataDir;
    const customConfig = {
      ...createSetup().config,
      env: buildLodyCodexCustomProviderEnv({}, { baseUrl: 'https://relay.example.com/v1' }),
    };
    const harness = createHarnessForFlock(
      new FakeMachineFlock(),
      {},
      {
        reconcileCredential: reconcileCodexProviderCredential,
      }
    );

    try {
      await seedCredential(customConfig, 'old-key');
      writeMachineFlockRowToFlock(harness.flock, {
        key: machineFlockKeys.providerSetupCancellation(setupId),
        value: { v: 1, id: setupId, machineId, cancelledAt: 20 },
      });

      await harness.manager.kick();

      expect(
        (await hydrateCodexProviderCredential(workspaceId, customConfig)).env[
          LODY_CODEX_API_KEY_ENV
        ]
      ).toBeUndefined();
    } finally {
      harness.manager.stop();
      if (previousDataDir === undefined) delete process.env.LODY_DATA_DIR;
      else process.env.LODY_DATA_DIR = previousDataDir;
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('clears a custom credential after an offline switch back to ChatGPT', async () => {
    const previousDataDir = process.env.LODY_DATA_DIR;
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'lody-provider-chatgpt-'));
    process.env.LODY_DATA_DIR = dataDir;
    const customConfig = {
      ...createSetup().config,
      env: buildLodyCodexCustomProviderEnv({}, { baseUrl: 'https://relay.example.com/v1' }),
    };
    const harness = createHarnessForFlock(
      new FakeMachineFlock(),
      {},
      {
        reconcileCredential: reconcileCodexProviderCredential,
      }
    );

    try {
      await seedCredential(customConfig, 'old-key');
      writeMachineFlockRowToFlock(harness.flock, {
        key: machineFlockKeys.agentConfig(setupId),
        value: { ...customConfig, env: {} },
      });
      writeMachineFlockRowToFlock(harness.flock, {
        key: machineFlockKeys.providerSetupCancellation(setupId),
        value: { v: 1, id: setupId, machineId, cancelledAt: 20 },
      });

      await harness.manager.kick();

      expect(
        (await hydrateCodexProviderCredential(workspaceId, customConfig)).env[
          LODY_CODEX_API_KEY_ENV
        ]
      ).toBeUndefined();
    } finally {
      harness.manager.stop();
      if (previousDataDir === undefined) delete process.env.LODY_DATA_DIR;
      else process.env.LODY_DATA_DIR = previousDataDir;
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('keeps a new credential after a re-added setup retracts wildcard cancellation', async () => {
    const previousDataDir = process.env.LODY_DATA_DIR;
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'lody-provider-readd-'));
    process.env.LODY_DATA_DIR = dataDir;
    const nextSetup = {
      ...createSetup('awaiting-auth'),
      setupRevision: 'revision-readded',
      config: {
        ...createSetup().config,
        env: buildLodyCodexCustomProviderEnv({}, { baseUrl: 'https://new.example.com/v1' }),
      },
    };
    const harness = createHarnessForFlock(
      new FakeMachineFlock(),
      {},
      {
        reconcileCredential: reconcileCodexProviderCredential,
      }
    );

    try {
      writeMachineFlockRowToFlock(harness.flock, {
        key: machineFlockKeys.providerSetupCancellation(setupId),
        value: { v: 1, id: setupId, machineId, cancelledAt: 20 },
      });
      deleteMachineFlockRowFromFlock(
        harness.flock,
        machineFlockKeys.providerSetupCancellation(setupId)
      );
      seedSetup(harness.flock, nextSetup);
      await seedCredential(nextSetup.config, 'new-key');

      await harness.manager.kick({ recoverCredentials: true });

      expect(
        (await hydrateCodexProviderCredential(workspaceId, nextSetup.config)).env
      ).toMatchObject({ [LODY_CODEX_API_KEY_ENV]: 'new-key' });
    } finally {
      harness.manager.stop();
      if (previousDataDir === undefined) delete process.env.LODY_DATA_DIR;
      else process.env.LODY_DATA_DIR = previousDataDir;
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
