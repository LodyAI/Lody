import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACP_CAPABILITY_CACHE_VERSION } from '@lody/shared';
import { getAcpCapabilitySourceVersion } from '../src/agent/setting';
import type { LoroDocumentManager } from '../src/lib/loro/doc';
import type { Logger } from '../src/utils/logger';

const mocks = vi.hoisted(() => ({
  initializeRuntime: vi.fn(async () => {}),
  cleanupRuntime: vi.fn(async () => {}),
  attachRemoteBridge: vi.fn(async () => {}),
  fetchAcpCapabilities: vi.fn(async () => ({
    modes: [],
    models: [],
    configOptions: [],
    availableCommands: [],
  })),
}));

vi.mock('@/pkg', () => ({
  // Both named (instrument.ts) and default (analytics poster / lody-fleet) importers
  // resolve to this file, so the mock must expose both shapes.
  name: 'lody',
  version: '0.0.0-test',
  default: {
    name: 'lody',
    version: '0.0.0-test',
  },
}));

vi.mock('@/lib/machine-runtime', () => ({
  MachineRuntime: class MockMachineRuntime {
    initialize = mocks.initializeRuntime;
    cleanup = mocks.cleanupRuntime;
    attachRemoteBridge = mocks.attachRemoteBridge;
    dispatchLocalMessageForResponse = vi.fn(async () => []);
    getActiveSessionCount = vi.fn(() => 0);
  },
}));

vi.mock('@/agent/acp-capabilities', () => ({
  fetchAcpCapabilities: mocks.fetchAcpCapabilities,
}));

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

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const builtinCodexSourceVersion = getAcpCapabilitySourceVersion({
  cliType: 'builtin',
  agentType: 'codex',
});

describe('Lody.registerAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchAcpCapabilities.mockResolvedValue({
      modes: [],
      models: [],
      configOptions: [],
      availableCommands: [],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts builtin registration only after the remote bridge is authorized', async () => {
    const { Lody } = await import('../src/lib/lody');
    const lody = new Lody(
      {
        logger: createSilentLogger(),
        builtinAgentConfigCliTypes: ['codex'],
        workspaceId: 'workspace-1',
        token: 'token',
        userId: 'user-1',
        machineId: 'machine-1',
        machineName: 'machine-name',
      },
      {} as LoroDocumentManager
    );
    const registerAgent = vi.spyOn(lody, 'registerAgent').mockResolvedValue();

    expect(registerAgent).not.toHaveBeenCalled();

    await lody.attachRemoteBridge();
    await flushMicrotasks();

    expect(mocks.attachRemoteBridge).toHaveBeenCalledTimes(1);
    expect(registerAgent).toHaveBeenCalledTimes(1);
    expect(registerAgent).toHaveBeenCalledWith(['codex']);

    await lody.attachRemoteBridge();
    await flushMicrotasks();

    expect(registerAgent).toHaveBeenCalledTimes(1);
  });

  it('propagates machine runtime initialization failures', async () => {
    mocks.initializeRuntime.mockRejectedValueOnce(new Error('registration unavailable'));
    const documentManager = {
      ensureMachineFlockDocJoined: vi.fn(),
    } as unknown as LoroDocumentManager;
    const { Lody } = await import('../src/lib/lody');
    const lody = new Lody(
      {
        logger: createSilentLogger(),
        workspaceId: 'workspace-1',
        token: 'token',
        userId: 'user-1',
        machineId: 'machine-1',
        machineName: 'machine-name',
      },
      documentManager
    );

    await expect(lody.start()).rejects.toThrow('registration unavailable');
    expect(documentManager.ensureMachineFlockDocJoined).not.toHaveBeenCalled();
  });

  it('defers builtin agent registration until initial meta sync completes', async () => {
    let resolveInitialMetaSync: ((value: boolean) => void) | undefined;
    const waitForInitialMetaSync = new Promise<boolean>((resolve) => {
      resolveInitialMetaSync = resolve;
    });
    const syncMachineFlockDoc = vi.fn(async () => true);
    const hasAgentConfig = vi.fn(async () => false);
    const createAgentConfig = vi.fn(async () => 'agent-config-id');
    const documentManager = {
      hasCompletedInitialMetaSync: vi.fn(() => false),
      onMetaRoomSynced: vi.fn(() => () => {}),
      onStreamsOnline: vi.fn(() => () => {}),
      waitForInitialMetaSync: vi.fn(async () => await waitForInitialMetaSync),
      syncMachineFlockDoc,
      hasAgentConfig,
      createAgentConfig,
      getAcpCapabilities: vi.fn(async () => ({
        cliType: 'builtin',
        agentType: 'codex',
        cacheVersion: ACP_CAPABILITY_CACHE_VERSION,
        sourceVersion: builtinCodexSourceVersion,
        modes: [],
        models: [],
        configOptions: [],
        availableCommands: [],
        fetchedAt: 0,
      })),
      updateAcpCapabilities: vi.fn(async () => {}),
      applyTitleGenerationDefaults: vi.fn(async () => {}),
    } as unknown as LoroDocumentManager;

    const { Lody } = await import('../src/lib/lody');
    const lody = new Lody(
      {
        logger: createSilentLogger(),
        workspaceId: 'workspace-1',
        token: 'token',
        userId: 'user-1',
        machineId: 'machine-1',
        machineName: 'machine-name',
      },
      documentManager
    );

    await lody.registerAgent(['codex']);

    expect(mocks.initializeRuntime).toHaveBeenCalledTimes(1);
    expect(createAgentConfig).not.toHaveBeenCalled();

    resolveInitialMetaSync?.(true);
    await flushMicrotasks();

    expect(syncMachineFlockDoc).toHaveBeenCalledWith('machine-1', {
      reason: 'builtin-agent-registration',
    });
    expect(hasAgentConfig).toHaveBeenCalledWith('builtin', 'codex', 'machine-1');
    expect(createAgentConfig).toHaveBeenCalledWith('builtin', 'codex', 'machine-1', 'Codex');
  });

  it('skips deferred builtin registration when initial meta sync never completes', async () => {
    const createAgentConfig = vi.fn(async () => 'agent-config-id');
    const documentManager = {
      hasCompletedInitialMetaSync: vi.fn(() => false),
      onMetaRoomSynced: vi.fn(() => () => {}),
      onStreamsOnline: vi.fn(() => () => {}),
      waitForInitialMetaSync: vi.fn(async () => false),
      syncMachineFlockDoc: vi.fn(async () => true),
      hasAgentConfig: vi.fn(async () => false),
      createAgentConfig,
      getAcpCapabilities: vi.fn(async () => ({
        cliType: 'builtin',
        agentType: 'codex',
        cacheVersion: ACP_CAPABILITY_CACHE_VERSION,
        sourceVersion: builtinCodexSourceVersion,
        modes: [],
        models: [],
        configOptions: [],
        availableCommands: [],
        fetchedAt: 0,
      })),
      updateAcpCapabilities: vi.fn(async () => {}),
      applyTitleGenerationDefaults: vi.fn(async () => {}),
    } as unknown as LoroDocumentManager;

    const { Lody } = await import('../src/lib/lody');
    const lody = new Lody(
      {
        logger: createSilentLogger(),
        workspaceId: 'workspace-1',
        token: 'token',
        userId: 'user-1',
        machineId: 'machine-1',
        machineName: 'machine-name',
      },
      documentManager
    );

    await lody.registerAgent(['codex']);
    await flushMicrotasks();

    expect(createAgentConfig).not.toHaveBeenCalled();
  });

  it('retries builtin registration with backoff when machine Flock sync is not confirmed', async () => {
    vi.useFakeTimers();
    const syncMachineFlockDoc = vi.fn(async () => true);
    syncMachineFlockDoc.mockResolvedValueOnce(false);
    syncMachineFlockDoc.mockResolvedValueOnce(false);
    const hasAgentConfig = vi.fn(async () => false);
    const createAgentConfig = vi.fn(async () => 'agent-config-id');
    const documentManager = {
      hasCompletedInitialMetaSync: vi.fn(() => true),
      waitForInitialMetaSync: vi.fn(async () => true),
      syncMachineFlockDoc,
      hasAgentConfig,
      createAgentConfig,
      getAcpCapabilities: vi.fn(async () => ({
        cliType: 'builtin',
        agentType: 'codex',
        cacheVersion: ACP_CAPABILITY_CACHE_VERSION,
        sourceVersion: builtinCodexSourceVersion,
        modes: [],
        models: [],
        configOptions: [],
        availableCommands: [],
        fetchedAt: 0,
      })),
      updateAcpCapabilities: vi.fn(async () => {}),
      applyTitleGenerationDefaults: vi.fn(async () => {}),
    } as unknown as LoroDocumentManager;

    const { Lody } = await import('../src/lib/lody');
    const lody = new Lody(
      {
        logger: createSilentLogger(),
        workspaceId: 'workspace-1',
        token: 'token',
        userId: 'user-1',
        machineId: 'machine-1',
        machineName: 'machine-name',
      },
      documentManager
    );

    await lody.registerAgent(['codex']);
    await flushMicrotasks();

    expect(syncMachineFlockDoc).toHaveBeenCalledTimes(1);
    expect(syncMachineFlockDoc).toHaveBeenCalledWith('machine-1', {
      reason: 'builtin-agent-registration',
    });
    expect(hasAgentConfig).not.toHaveBeenCalled();
    expect(createAgentConfig).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);
    await flushMicrotasks();

    expect(syncMachineFlockDoc).toHaveBeenCalledTimes(2);
    expect(hasAgentConfig).not.toHaveBeenCalled();
    expect(createAgentConfig).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);
    await flushMicrotasks();

    expect(syncMachineFlockDoc).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(10_000);
    await flushMicrotasks();

    expect(syncMachineFlockDoc).toHaveBeenCalledTimes(3);
    expect(hasAgentConfig).toHaveBeenCalledWith('builtin', 'codex', 'machine-1');
    expect(createAgentConfig).toHaveBeenCalledWith('builtin', 'codex', 'machine-1', 'Codex');
  });

  it('does not write static capabilities during builtin agent registration', async () => {
    const updateAcpCapabilities = vi.fn(async () => {});
    const getAcpCapabilities = vi.fn(async () => ({
      cliType: 'builtin' as const,
      agentType: 'codex',
      cacheVersion: ACP_CAPABILITY_CACHE_VERSION,
      sourceVersion: 'builtin-codex-acp:0.10.0+codex:0.10.0',
      modes: [],
      models: [],
      configOptions: [],
      availableCommands: [],
      fetchedAt: 0,
    }));
    const documentManager = {
      hasCompletedInitialMetaSync: vi.fn(() => true),
      waitForInitialMetaSync: vi.fn(async () => true),
      syncMachineFlockDoc: vi.fn(async () => true),
      hasAgentConfig: vi.fn(async () => true),
      createAgentConfig: vi.fn(async () => 'agent-config-id'),
      getAcpCapabilities,
      updateAcpCapabilities,
      applyTitleGenerationDefaults: vi.fn(async () => {}),
    } as unknown as LoroDocumentManager;

    const { Lody } = await import('../src/lib/lody');
    const lody = new Lody(
      {
        logger: createSilentLogger(),
        workspaceId: 'workspace-1',
        token: 'token',
        userId: 'user-1',
        machineId: 'machine-1',
        machineName: 'machine-name',
      },
      documentManager
    );

    await lody.registerAgent(['codex']);
    await flushMicrotasks();

    expect(mocks.fetchAcpCapabilities).not.toHaveBeenCalled();
    expect(getAcpCapabilities).not.toHaveBeenCalled();
    expect(updateAcpCapabilities).not.toHaveBeenCalled();
  });
});
