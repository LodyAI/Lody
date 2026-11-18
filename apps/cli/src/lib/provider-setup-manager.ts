import {
  applyProviderSetupCancellationToFlock,
  encodeCodexProfileConfig,
  deleteMachineFlockRowFromFlock,
  getMachineFlockAgentConfigs,
  getMachineFlockDocId,
  getMachineFlockProviderSetups,
  findBuiltinAgentOptOutToRetract,
  getMachineFlockProviderSetupCancellations,
  getServerNow,
  hasBuiltinRuntimeOverrideValues,
  hasEmptyModelSelectOption,
  isManagedBuiltinAgentType,
  machineFlockKeys,
  readMachineFlockRowsFromFlock,
  supportsBuiltinProviderSetup,
  writeMachineFlockRowToFlock,
  type AgentConfigId,
  type AgentConfigMeta,
  type MachineId,
  type MachineFlockWritableFlock,
  type ProviderSetupFailureCode,
  type ProviderSetupStatus,
  type ProviderSetupTask,
  type WorkspaceId,
} from '@lody/shared';
import type { LoroRepo } from 'loro-repo';

import type { SessionExecutionService } from '@/session/session-execution-service';
import { formatErrorMessage } from '@/utils/format-error';
import type { Logger } from '@/utils/logger';
import { getCodexProfileStore } from '@/agent/codex-profile-store';

type ProviderSetupExecution = Pick<
  SessionExecutionService,
  'getMachineAcpBinaryStatus' | 'installMachineAcpBinary' | 'refreshMachineAcpCapabilities'
>;

type ProviderSetupSyncScheduler = {
  markMachineFlockDocDirty: (machineId: MachineId, options?: { reason?: string }) => void;
};

/** Trusted machine owner only. Each change compares the previously read task in
 * the same transaction as its write; this port never exposes saved credentials
 * to a renderer. */
export type ProviderSetupStoragePort = {
  signal(): AbortSignal;
  observe(listener: () => void, onError: (error: unknown) => void): Promise<{ close(): void }>;
  read(): Promise<{
    configs: Record<string, AgentConfigMeta>;
    setups: Record<string, ProviderSetupTask>;
  }>;
  reconcileCancellations(): Promise<void>;
  replace(expected: ProviderSetupTask, next: ProviderSetupTask): Promise<boolean>;
  remove(expected: ProviderSetupTask): Promise<void>;
  publish(expected: ProviderSetupTask): Promise<void>;
};

export type ProviderSetupManagerOptions = {
  repo: LoroRepo;
  workspaceId: WorkspaceId;
  machineId: MachineId;
  execution: ProviderSetupExecution;
  sync: ProviderSetupSyncScheduler;
  logger: Logger;
  storage?: ProviderSetupStoragePort;
};

const RESUMABLE_STATUSES = new Set<ProviderSetupStatus>([
  'queued',
  'preparing-runtime',
  'verifying',
]);

const isMissingBubRuntimeError = (error: string | undefined): boolean => {
  if (!error) return false;
  const normalized = error.toLowerCase();
  return (
    normalized.includes('spawn bub enoent') ||
    normalized.includes('command not found') ||
    normalized.includes("no such command 'acp'") ||
    normalized.includes("failed to load plugin 'acp-server'") ||
    normalized.includes("no module named 'bub_acp_server'")
  );
};

const isMissingDimcodeRuntimeError = (error: string | undefined): boolean => {
  const normalized = error?.toLowerCase() ?? '';
  return (
    normalized.includes('spawn dimcode enoent') ||
    normalized.includes('command not found') ||
    normalized.includes('dimcode is not recognized') ||
    normalized.includes("'dimcode' is not recognized") ||
    normalized.includes("no such command 'acp'") ||
    normalized.includes("unknown command 'acp'") ||
    normalized.includes("unrecognized subcommand 'acp'")
  );
};

/**
 * Owns the non-interactive half of built-in provider creation on the target
 * machine. Flock rows are the durable queue: syncing a row or restarting the
 * CLI calls {@link kick}, while auth/failure states stay dormant until the UI
 * explicitly resumes them.
 */
export class ProviderSetupManager {
  private readonly repo: LoroRepo;
  private readonly workspaceId: WorkspaceId;
  private readonly machineId: MachineId;
  private readonly execution: ProviderSetupExecution;
  private readonly sync: ProviderSetupSyncScheduler;
  private readonly logger: Logger;
  private readonly storage?: ProviderSetupStoragePort;
  private drainPromise: Promise<void> | null = null;
  private drainRequested = false;
  private stopped = false;
  private readonly runtimeCancellation = new AbortController();
  private cleanupRetry: ReturnType<typeof setTimeout> | undefined;
  private storageObservation?: { close(): void };
  private storageWatching = false;

  constructor(options: ProviderSetupManagerOptions) {
    this.repo = options.repo;
    this.workspaceId = options.workspaceId;
    this.machineId = options.machineId;
    this.execution = options.execution;
    this.sync = options.sync;
    this.logger = options.logger;
    this.storage = options.storage;
  }

  kick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.drainRequested = true;
    if (!this.drainPromise) {
      this.drainPromise = this.drain()
        .catch((error) => {
          this.logger.debug(`[provider-setup] Queue scan failed: ${formatErrorMessage(error)}`);
        })
        .finally(() => {
          this.drainPromise = null;
          if (this.drainRequested && !this.stopped) {
            void this.kick();
          }
        });
    }
    return this.waitUntilIdle();
  }

  start(): void {
    if (!this.storage || this.storageWatching || this.stopped) return;
    this.storageWatching = true;
    void this.storage
      .observe(
        () => {
          if (!this.stopped) void this.kick();
        },
        () => {
          if (!this.stopped) this.logger.debug('[provider-setup] Native queue observation failed');
        }
      )
      .then(
        (observation) => {
          if (this.stopped) observation.close();
          else this.storageObservation = observation;
        },
        () => {
          this.storageWatching = false;
          if (!this.stopped) this.logger.debug('[provider-setup] Native queue observation failed');
        }
      );
  }

  stop(): void {
    this.stopped = true;
    this.runtimeCancellation.abort();
    this.storageObservation?.close();
    this.storageObservation = undefined;
    this.drainRequested = false;
    clearTimeout(this.cleanupRetry);
    this.cleanupRetry = undefined;
  }

  async resumeAfterAuthentication(setupId: AgentConfigId): Promise<void> {
    if (this.stopped) return;
    const setup = await this.readSetup(setupId);
    if (!setup || setup.status !== 'awaiting-auth') return;
    const { failureCode: _failureCode, ...base } = setup;
    await this.writeSetup(
      {
        ...base,
        status: 'queued',
        attempt: setup.attempt + 1,
        updatedAt: getServerNow(),
      },
      setup
    );
    void this.kick();
  }

  private async waitUntilIdle(): Promise<void> {
    while (this.drainPromise) {
      await this.drainPromise;
    }
  }

  private async drain(): Promise<void> {
    while (!this.stopped) {
      this.drainRequested = false;
      await this.reconcileCancellations();
      try {
        await this.reconcileCodexProfiles();
      } catch {
        this.logger.warn('[provider-setup] Codex profile scan failed; continuing setup queue');
      }
      const setups = (await this.readSetups())
        .filter((setup) => RESUMABLE_STATUSES.has(setup.status))
        .sort((left, right) => left.createdAt - right.createdAt);
      for (const setup of setups) {
        if (this.stopped) return;
        await this.processOne(setup);
      }
      if (!this.drainRequested) return;
    }
  }

  private async processOne(snapshot: ProviderSetupTask): Promise<void> {
    const signal = this.storage
      ? AbortSignal.any([this.runtimeCancellation.signal, this.storage.signal()])
      : this.runtimeCancellation.signal;
    if (signal.aborted) return;
    const fail = (id: AgentConfigId, attempt: number, code: ProviderSetupFailureCode) =>
      this.fail(id, attempt, code, signal);
    const updateStatus = (id: AgentConfigId, attempt: number, status: ProviderSetupStatus) =>
      this.updateStatus(id, attempt, status, signal);
    const setup = await this.readSetup(snapshot.id);
    if (
      signal.aborted ||
      !setup ||
      setup.attempt !== snapshot.attempt ||
      !RESUMABLE_STATUSES.has(setup.status)
    ) {
      return;
    }

    const existingConfig = await this.readAgentConfig(setup.id);
    if (signal.aborted) return;
    if (existingConfig) {
      if (!signal.aborted) await this.deleteSetup(setup.id, setup);
      return;
    }

    const attempt = setup.attempt;
    let unexpectedFailureCode: ProviderSetupFailureCode = 'runtime-unavailable';
    try {
      if (
        setup.config.cliType !== 'builtin' ||
        !supportsBuiltinProviderSetup(setup.config.agentType) ||
        hasBuiltinRuntimeOverrideValues(setup.config.runtimeOverrides)
      ) {
        await fail(setup.id, attempt, 'runtime-unavailable');
        return;
      }

      // Non-managed builtins prepare their command during the live probe:
      // Bub and Dimcode are user-installed. Keep the config
      // unpublished until that ACP process passes verification.
      if (isManagedBuiltinAgentType(setup.config.agentType)) {
        const preparing = await updateStatus(setup.id, attempt, 'preparing-runtime');
        if (!preparing || this.stopped || signal.aborted) return;

        const binaryStatus = await this.execution.getMachineAcpBinaryStatus({
          type: 'machine/acp-binary-status',
          machineId: this.machineId,
          workspaceId: this.workspaceId,
          agentType: preparing.config.agentType,
        });
        if (signal.aborted) return;
        if (
          !binaryStatus.success ||
          binaryStatus.status === 'unsupported-platform' ||
          binaryStatus.status === 'incompatible-host' ||
          binaryStatus.status === 'error'
        ) {
          await fail(setup.id, attempt, 'runtime-unavailable');
          return;
        }
        if (binaryStatus.status !== 'installed' && binaryStatus.status !== 'not-applicable') {
          unexpectedFailureCode = 'runtime-install-failed';
          const install = await this.execution.installMachineAcpBinary(
            {
              type: 'machine/acp-binary-install',
              machineId: this.machineId,
              workspaceId: this.workspaceId,
              agentType: preparing.config.agentType,
            },
            { signal }
          );
          if (signal.aborted) return;
          if (!install.success) {
            await fail(setup.id, attempt, 'runtime-install-failed');
            return;
          }
        }
      }

      unexpectedFailureCode = 'verification-failed';
      const verifying = await updateStatus(setup.id, attempt, 'verifying');
      if (!verifying || this.stopped || signal.aborted) return;
      const response = await this.execution.refreshMachineAcpCapabilities(
        {
          type: 'machine/acp-capabilities-refresh',
          machineId: this.machineId,
          workspaceId: this.workspaceId,
          configId: verifying.config.id,
          // Provider setup publishes a config only after the runtime it just
          // installed answered session/new, so this verification never accepts a
          // cached entry from an earlier install.
          force: true,
        },
        { signal }
      );
      if (signal.aborted) return;
      if (response.success) {
        if (hasEmptyModelSelectOption(response.capability?.configOptions)) {
          // The agent answered but its model catalog is empty: the provider is
          // degraded, not verified. Do not publish it as a working config — a
          // later setup attempt can verify again once the catalog heals.
          await fail(verifying.id, attempt, 'verification-failed');
          return;
        }
        await this.publishVerifiedConfig(verifying.id, attempt, signal);
        return;
      }
      if (response.authRequired) {
        await updateStatus(verifying.id, attempt, 'awaiting-auth');
        return;
      }
      await fail(
        verifying.id,
        attempt,
        (verifying.config.agentType === 'bub' && isMissingBubRuntimeError(response.error)) ||
          (verifying.config.agentType === 'dimcode' && isMissingDimcodeRuntimeError(response.error))
          ? 'runtime-unavailable'
          : 'verification-failed'
      );
    } catch (error) {
      if (signal.aborted) return;
      this.logger.debug(`[provider-setup] Failed setup ${setup.id}: ${formatErrorMessage(error)}`);
      await fail(setup.id, attempt, unexpectedFailureCode).catch(() => undefined);
    }
  }

  private async readSetups(): Promise<ProviderSetupTask[]> {
    if (this.storage) return Object.values((await this.storage.read()).setups);
    const handle = await this.repo.openFlockDoc(
      getMachineFlockDocId(this.workspaceId, this.machineId)
    );
    return Object.values(
      getMachineFlockProviderSetups(
        readMachineFlockRowsFromFlock(handle.flock, { families: ['providerSetup'] })
      )
    );
  }

  private async reconcileCancellations(): Promise<void> {
    if (this.storage) return this.storage.reconcileCancellations();
    const handle = await this.repo.openFlockDoc(
      getMachineFlockDocId(this.workspaceId, this.machineId)
    );
    const cancellations = Object.values(
      getMachineFlockProviderSetupCancellations(
        readMachineFlockRowsFromFlock(handle.flock, {
          families: ['providerSetupCancellation'],
        })
      )
    ).filter((cancellation) => cancellation.machineId === this.machineId);
    let changed = false;
    for (const cancellation of cancellations) {
      changed =
        applyProviderSetupCancellationToFlock(
          handle.flock,
          cancellation,
          Math.max(getServerNow(), cancellation.cancelledAt)
        ) || changed;
    }
    if (!changed) return;
    await this.repo.flush();
    this.sync.markMachineFlockDocDirty(this.machineId, { reason: 'provider-setup-cancel' });
  }

  private async reconcileCodexProfiles(): Promise<void> {
    const store = getCodexProfileStore();
    const profiles = await store.list(this.workspaceId);
    if (!profiles.length) return;
    const handle = this.storage
      ? undefined
      : await this.repo.openFlockDoc(getMachineFlockDocId(this.workspaceId, this.machineId));
    const rows = handle
      ? readMachineFlockRowsFromFlock(handle.flock, {
          families: ['agentConfig', 'providerSetup'],
        })
      : undefined;
    const native = this.storage ? await this.storage.read() : undefined;
    const configs = native?.configs ?? getMachineFlockAgentConfigs(rows!);
    const setups = native?.setups ?? getMachineFlockProviderSetups(rows!);
    for (const profile of profiles) {
      if (profile.machineId !== this.machineId) continue;
      const config =
        configs[profile.configId as AgentConfigId] ??
        setups[profile.configId as AgentConfigId]?.config;
      try {
        if (config?.codexAuth?.profileId === profile.profile.profileId)
          await store.reconcileGenerations(profile);
        else if (!(await store.remove(profile))) this.scheduleCleanupRetry();
      } catch {
        this.scheduleCleanupRetry();
        this.logger.debug(
          '[provider-setup] Codex credential cleanup is pending; it will retry on the next scan'
        );
      }
    }
  }

  private scheduleCleanupRetry(): void {
    if (this.stopped || this.cleanupRetry) return;
    this.cleanupRetry = setTimeout(() => {
      this.cleanupRetry = undefined;
      void this.kick();
    }, 30_000);
    this.cleanupRetry.unref?.();
  }

  private async readSetup(setupId: AgentConfigId): Promise<ProviderSetupTask | undefined> {
    if (this.storage) return (await this.storage.read()).setups[setupId];
    const handle = await this.repo.openFlockDoc(
      getMachineFlockDocId(this.workspaceId, this.machineId)
    );
    const rows = readMachineFlockRowsFromFlock(handle.flock, {
      prefixes: [
        machineFlockKeys.providerSetup(setupId),
        machineFlockKeys.providerSetupCancellation(setupId),
      ],
    });
    if (getMachineFlockProviderSetupCancellations(rows)[setupId]) {
      return undefined;
    }
    return getMachineFlockProviderSetups(rows)[setupId];
  }

  private async readAgentConfig(setupId: AgentConfigId) {
    if (this.storage) return (await this.storage.read()).configs[setupId];
    const handle = await this.repo.openFlockDoc(
      getMachineFlockDocId(this.workspaceId, this.machineId)
    );
    return getMachineFlockAgentConfigs(
      readMachineFlockRowsFromFlock(handle.flock, {
        prefixes: [machineFlockKeys.agentConfig(setupId)],
      })
    )[setupId];
  }

  private async updateStatus(
    setupId: AgentConfigId,
    attempt: number,
    status: ProviderSetupStatus,
    signal?: AbortSignal
  ): Promise<ProviderSetupTask | undefined> {
    const current = await this.readSetup(setupId);
    if (signal?.aborted || !current || current.attempt !== attempt) return undefined;
    const { failureCode: _failureCode, ...base } = current;
    const next: ProviderSetupTask = {
      ...base,
      status,
      updatedAt: getServerNow(),
    };
    if (!(await this.writeSetup(next, current))) return undefined;
    return next;
  }

  private async fail(
    setupId: AgentConfigId,
    attempt: number,
    failureCode: ProviderSetupFailureCode,
    signal?: AbortSignal
  ): Promise<void> {
    const current = await this.readSetup(setupId);
    if (signal?.aborted || !current || current.attempt !== attempt) return;
    await this.writeSetup(
      {
        ...current,
        status: 'failed',
        failureCode,
        updatedAt: getServerNow(),
      },
      current
    );
  }

  private async writeSetup(
    setup: ProviderSetupTask,
    expected?: ProviderSetupTask
  ): Promise<boolean> {
    if (this.storage) return expected ? this.storage.replace(expected, setup) : false;
    const handle = await this.repo.openFlockDoc(
      getMachineFlockDocId(this.workspaceId, this.machineId)
    );
    const changed = writeMachineFlockRowToFlock(
      handle.flock,
      {
        key: machineFlockKeys.providerSetup(setup.id),
        value: setup,
      },
      setup.updatedAt
    );
    if (!changed) return true;
    await this.repo.flush();
    this.sync.markMachineFlockDocDirty(this.machineId, { reason: 'provider-setup-update' });
    return true;
  }

  private async deleteSetup(setupId: AgentConfigId, expected?: ProviderSetupTask): Promise<void> {
    if (this.storage) {
      if (expected) await this.storage.remove(expected);
      return;
    }
    const handle = await this.repo.openFlockDoc(
      getMachineFlockDocId(this.workspaceId, this.machineId)
    );
    const changed = deleteMachineFlockRowFromFlock(
      handle.flock,
      machineFlockKeys.providerSetup(setupId),
      getServerNow()
    );
    if (!changed) return;
    await this.repo.flush();
    this.sync.markMachineFlockDocDirty(this.machineId, { reason: 'provider-setup-delete' });
  }

  private async publishVerifiedConfig(
    setupId: AgentConfigId,
    attempt: number,
    signal?: AbortSignal
  ): Promise<void> {
    if (this.storage) {
      const setup = await this.readSetup(setupId);
      if (
        signal?.aborted ||
        !setup ||
        setup.attempt !== attempt ||
        setup.status !== 'verifying' ||
        this.stopped
      )
        return;
      if (setup.config.codexAuth)
        await getCodexProfileStore().resolve(this.workspaceId, setup.config);
      if (!signal?.aborted) await this.storage.publish(setup);
      return;
    }
    const handle = await this.repo.openFlockDoc(
      getMachineFlockDocId(this.workspaceId, this.machineId)
    );
    const rows = readMachineFlockRowsFromFlock(handle.flock, {
      prefixes: [
        machineFlockKeys.providerSetup(setupId),
        machineFlockKeys.providerSetupCancellation(setupId),
        machineFlockKeys.agentConfig(setupId),
      ],
      families: ['builtinAgentOptOut'],
    });
    const cancellation = getMachineFlockProviderSetupCancellations(rows)[setupId];
    if (cancellation) {
      const changed = applyProviderSetupCancellationToFlock(
        handle.flock,
        cancellation,
        Math.max(getServerNow(), cancellation.cancelledAt)
      );
      if (changed) {
        await this.repo.flush();
        this.sync.markMachineFlockDocDirty(this.machineId, { reason: 'provider-setup-cancel' });
      }
      return;
    }
    const setup = getMachineFlockProviderSetups(rows)[setupId];
    if (
      signal?.aborted ||
      !setup ||
      setup.attempt !== attempt ||
      setup.status !== 'verifying' ||
      this.stopped
    ) {
      return;
    }
    if (getMachineFlockAgentConfigs(rows)[setupId]) {
      await this.deleteSetup(setupId);
      return;
    }
    if (setup.config.codexAuth)
      await getCodexProfileStore().resolve(this.workspaceId, setup.config);

    const now = getServerNow();
    const flock = handle.flock as unknown as MachineFlockWritableFlock;
    flock.set(machineFlockKeys.agentConfig(setupId), encodeCodexProfileConfig(setup.config), now);
    // Publishing is the user adding the provider explicitly, so the earlier same-type
    // removal intent has to be retracted too, or the list holds it while startup still
    // treats it as removed.
    const optOutKey = findBuiltinAgentOptOutToRetract(rows, setup.config);
    if (optOutKey) {
      flock.delete(optOutKey, now);
    }
    flock.delete(machineFlockKeys.providerSetup(setupId), now);
    flock.commit();
    await this.repo.flush();
    this.sync.markMachineFlockDocDirty(this.machineId, { reason: 'provider-setup-publish' });
  }
}
