import {
  applyProviderSetupCancellationToFlock,
  assertAgentConfigDoesNotContainCodexCredential,
  deleteMachineFlockRowFromFlock,
  getMachineFlockAgentConfigs,
  getMachineFlockDocId,
  getMachineFlockProviderSetups,
  findBuiltinAgentOptOutToRetract,
  getMachineFlockProviderSetupCancellations,
  getServerNow,
  machineFlockKeys,
  readMachineFlockRowsFromFlock,
  withLodyCodexCredentialRevision,
  writeMachineFlockRowToFlock,
  type AgentConfigMeta,
  type AgentConfigId,
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
import { getProviderCredentialBindingDigest } from '@/agent/provider-credential-adapter';
import {
  listProviderCredentialConfigIds,
  reconcileProviderCredential,
  stageProviderCredential,
} from '@/agent/provider-credential-store';

type ProviderSetupExecution = Pick<
  SessionExecutionService,
  | 'getMachineAcpBinaryStatus'
  | 'installMachineAcpBinary'
  | 'probeMachineAcpCapabilitiesForProviderSetup'
>;

type ProviderSetupSyncScheduler = {
  markMachineFlockDocDirty: (machineId: MachineId, options?: { reason?: string }) => void;
};

export type ProviderSetupManagerOptions = {
  repo: LoroRepo;
  workspaceId: WorkspaceId;
  machineId: MachineId;
  execution: ProviderSetupExecution;
  sync: ProviderSetupSyncScheduler;
  logger: Logger;
  listCredentialConfigIds?: typeof listProviderCredentialConfigIds;
  reconcileCredential?: typeof reconcileProviderCredential;
  stageCredential?: typeof stageProviderCredential;
};

export type ProviderSetupPublicationDurability = 'durable' | 'uncertain';

type PublishVerifiedConfigResult =
  | { published: false }
  | { published: true; durability: ProviderSetupPublicationDurability };

const RESUMABLE_STATUSES = new Set<ProviderSetupStatus>([
  'queued',
  'preparing-runtime',
  'verifying',
]);

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
  private readonly listCredentialConfigIds: typeof listProviderCredentialConfigIds;
  private readonly reconcileCredential: typeof reconcileProviderCredential;
  private readonly stageCredential: typeof stageProviderCredential;
  private readonly credentialMutationChains = new Map<AgentConfigId, Promise<void>>();
  private drainPromise: Promise<void> | null = null;
  private drainRequested = false;
  private credentialRecoveryRequested = false;
  private credentialRecoveryCompleted = false;
  private stopped = false;

  constructor(options: ProviderSetupManagerOptions) {
    this.repo = options.repo;
    this.workspaceId = options.workspaceId;
    this.machineId = options.machineId;
    this.execution = options.execution;
    this.sync = options.sync;
    this.logger = options.logger;
    this.listCredentialConfigIds =
      options.listCredentialConfigIds ?? listProviderCredentialConfigIds;
    this.reconcileCredential = options.reconcileCredential ?? reconcileProviderCredential;
    this.stageCredential = options.stageCredential ?? stageProviderCredential;
  }

  kick(options: { recoverCredentials?: boolean } = {}): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (options.recoverCredentials && !this.credentialRecoveryCompleted) {
      this.credentialRecoveryRequested = true;
    }
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

  stop(): void {
    this.stopped = true;
    this.drainRequested = false;
  }

  async resumeAfterAuthentication(setupId: AgentConfigId): Promise<void> {
    if (this.stopped) return;
    const setup = await this.readSetup(setupId);
    if (!setup || setup.status !== 'awaiting-auth') return;
    const { failureCode: _failureCode, ...base } = setup;
    await this.writeSetup({
      ...base,
      status: 'queued',
      attempt: setup.attempt + 1,
      updatedAt: getServerNow(),
    });
    void this.kick();
  }

  async commitCredentialSetup(
    setupId: AgentConfigId,
    setupRevision: string,
    expectedBindingDigest: string,
    apiKey: string,
    signal?: AbortSignal,
    markCommitted?: () => void,
    publishCapabilities?: () => Promise<void>
  ): Promise<ProviderSetupPublicationDurability> {
    return await this.runCredentialMutation(setupId, async () => {
      if (this.stopped) throw new Error('Provider setup manager is stopped');
      signal?.throwIfAborted();
      const setup = await this.readSetup(setupId);
      if (!setup || setup.status !== 'awaiting-auth' || setup.setupRevision !== setupRevision) {
        throw new Error('Provider setup was cancelled or replaced');
      }
      const publishedConfig = await this.readAgentConfig(setup.id);
      const verifiedConfig: AgentConfigMeta = {
        ...setup.config,
        env: withLodyCodexCredentialRevision(setup.config.env, setupRevision),
      };
      if (getProviderCredentialBindingDigest(verifiedConfig) !== expectedBindingDigest) {
        throw new Error('Provider setup no longer matches the confirmed credential target');
      }
      const staged = await this.stageCredential(
        this.workspaceId,
        verifiedConfig,
        apiKey,
        publishedConfig
      );
      if (signal?.aborted) {
        await staged.rollback();
        signal.throwIfAborted();
      }
      let publicationCommitted = false;
      const published = await this.publishVerifiedConfig(
        setup.id,
        setup.attempt,
        setupRevision,
        signal,
        () => {
          publicationCommitted = true;
          markCommitted?.();
        },
        verifiedConfig
      ).catch(async (error: unknown) => {
        if (!publicationCommitted) await staged.rollback();
        throw error;
      });
      if (!published.published) {
        await staged.rollback();
        throw new Error('Provider setup was cancelled or replaced');
      }
      if (published.durability === 'durable') {
        await staged.finalize().catch((error) => {
          this.logger.debug(
            `[provider-setup] Published ${setup.id}, but old credential binding cleanup is deferred to startup recovery: ${formatErrorMessage(error)}`
          );
        });
        await publishCapabilities?.().catch((error) => {
          this.logger.debug(
            `[provider-setup] Published ${setup.id}, but capability cache publication is deferred to a later refresh: ${formatErrorMessage(error)}`
          );
        });
      }
      return published.durability;
    });
  }

  private async runCredentialMutation<T>(
    configId: AgentConfigId,
    operation: () => Promise<T>
  ): Promise<T> {
    const prior = this.credentialMutationChains.get(configId) ?? Promise.resolve();
    const result = prior.then(operation);
    const settled = result.then(
      () => undefined,
      () => undefined
    );
    this.credentialMutationChains.set(configId, settled);
    try {
      return await result;
    } finally {
      if (this.credentialMutationChains.get(configId) === settled) {
        this.credentialMutationChains.delete(configId);
      }
    }
  }

  private async commitVerifiedSetup(
    setupId: AgentConfigId,
    attempt: number,
    publishCapabilities: () => Promise<void>
  ): Promise<void> {
    await this.runCredentialMutation(setupId, async () => {
      const published = await this.publishVerifiedConfig(setupId, attempt);
      if (!published.published || published.durability !== 'durable') return;
      await publishCapabilities().catch((error) => {
        this.logger.debug(
          `[provider-setup] Published ${setupId}, but capability cache publication is deferred to a later refresh: ${formatErrorMessage(error)}`
        );
      });
    });
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
      if (this.credentialRecoveryRequested) {
        this.credentialRecoveryRequested = false;
        try {
          await this.reconcileCredentialBindings();
          this.credentialRecoveryCompleted = true;
        } catch (error) {
          this.credentialRecoveryRequested = true;
          throw error;
        }
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
    const setup = await this.readSetup(snapshot.id);
    if (!setup || setup.attempt !== snapshot.attempt || !RESUMABLE_STATUSES.has(setup.status)) {
      return;
    }

    const existingConfig = await this.readAgentConfig(setup.id);
    if (existingConfig && !setup.setupRevision) {
      await this.deleteSetup(setup.id);
      return;
    }

    const attempt = setup.attempt;
    let unexpectedFailureCode: ProviderSetupFailureCode = 'runtime-unavailable';
    try {
      const preparing = await this.updateStatus(setup.id, attempt, 'preparing-runtime');
      if (!preparing || this.stopped) return;

      const binaryStatus = await this.execution.getMachineAcpBinaryStatus({
        type: 'machine/acp-binary-status',
        machineId: this.machineId,
        workspaceId: this.workspaceId,
        agentType: preparing.config.agentType,
      });
      if (
        !binaryStatus.success ||
        binaryStatus.status === 'unsupported-platform' ||
        binaryStatus.status === 'incompatible-host' ||
        binaryStatus.status === 'error'
      ) {
        await this.fail(setup.id, attempt, 'runtime-unavailable');
        return;
      }
      if (binaryStatus.status !== 'installed' && binaryStatus.status !== 'not-applicable') {
        unexpectedFailureCode = 'runtime-install-failed';
        const install = await this.execution.installMachineAcpBinary({
          type: 'machine/acp-binary-install',
          machineId: this.machineId,
          workspaceId: this.workspaceId,
          agentType: preparing.config.agentType,
        });
        if (!install.success) {
          await this.fail(setup.id, attempt, 'runtime-install-failed');
          return;
        }
      }

      unexpectedFailureCode = 'verification-failed';
      const verifying = await this.updateStatus(setup.id, attempt, 'verifying');
      if (!verifying || this.stopped) return;
      const probe = await this.execution.probeMachineAcpCapabilitiesForProviderSetup(
        verifying.config
      );
      const response = probe.response;
      if (response.success) {
        await this.commitVerifiedSetup(verifying.id, attempt, probe.publishCapabilities);
        return;
      }
      if (response.authRequired) {
        await this.updateStatus(verifying.id, attempt, 'awaiting-auth');
        return;
      }
      await this.fail(verifying.id, attempt, 'verification-failed');
    } catch (error) {
      this.logger.debug(`[provider-setup] Failed setup ${setup.id}: ${formatErrorMessage(error)}`);
      await this.fail(setup.id, attempt, unexpectedFailureCode).catch(() => undefined);
    }
  }

  private async readSetups(): Promise<ProviderSetupTask[]> {
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
    const handle = await this.repo.openFlockDoc(
      getMachineFlockDocId(this.workspaceId, this.machineId)
    );
    const rows = readMachineFlockRowsFromFlock(handle.flock, {
      families: ['providerSetupCancellation', 'providerSetup'],
    });
    const setups = getMachineFlockProviderSetups(rows);
    const cancellations = Object.values(getMachineFlockProviderSetupCancellations(rows)).filter(
      (cancellation) => cancellation.machineId === this.machineId
    );
    const reconcileIds = new Set<AgentConfigId>();
    let changed = false;
    for (const cancellation of cancellations) {
      const setupRevision = setups[cancellation.id]?.setupRevision;
      if (
        cancellation.setupRevision &&
        (!setupRevision || setupRevision !== cancellation.setupRevision)
      ) {
        continue;
      }
      reconcileIds.add(cancellation.id);
      changed =
        applyProviderSetupCancellationToFlock(
          handle.flock,
          cancellation,
          Math.max(getServerNow(), cancellation.cancelledAt)
        ) || changed;
    }
    if (changed) {
      await this.repo.flush();
      this.sync.markMachineFlockDocDirty(this.machineId, { reason: 'provider-setup-cancel' });
    }
    for (const configId of reconcileIds) {
      await this.reconcileCredentialBinding(configId);
    }
  }

  private async reconcileCredentialBindings(): Promise<void> {
    const handle = await this.repo.openFlockDoc(
      getMachineFlockDocId(this.workspaceId, this.machineId)
    );
    const rows = readMachineFlockRowsFromFlock(handle.flock, {
      families: ['providerSetupCancellation', 'providerSetup', 'agentConfig'],
    });
    const configs = getMachineFlockAgentConfigs(rows);
    const setups = getMachineFlockProviderSetups(rows);
    const cancellations = getMachineFlockProviderSetupCancellations(rows);
    const credentialConfigIds = await this.listCredentialConfigIds(this.workspaceId);
    const ids = new Set<AgentConfigId>([
      ...(Object.keys(configs) as AgentConfigId[]),
      ...(Object.keys(setups) as AgentConfigId[]),
      ...(Object.keys(cancellations) as AgentConfigId[]),
      ...(credentialConfigIds as AgentConfigId[]),
    ]);
    for (const id of ids) {
      await this.reconcileCredentialBinding(id);
    }
  }

  private async reconcileCredentialBinding(configId: AgentConfigId): Promise<void> {
    await this.runCredentialMutation(configId, async () => {
      const handle = await this.repo.openFlockDoc(
        getMachineFlockDocId(this.workspaceId, this.machineId)
      );
      const rows = readMachineFlockRowsFromFlock(handle.flock, {
        prefixes: [
          machineFlockKeys.providerSetup(configId),
          machineFlockKeys.agentConfig(configId),
        ],
      });
      const config = getMachineFlockAgentConfigs(rows)[configId];
      const setup = getMachineFlockProviderSetups(rows)[configId];
      const referencedConfigs = [setup?.config, config].filter(
        (entry): entry is NonNullable<typeof entry> => Boolean(entry)
      );
      await this.reconcileCredential(this.workspaceId, configId, referencedConfigs);
    });
  }

  private async readSetup(setupId: AgentConfigId): Promise<ProviderSetupTask | undefined> {
    const handle = await this.repo.openFlockDoc(
      getMachineFlockDocId(this.workspaceId, this.machineId)
    );
    const rows = readMachineFlockRowsFromFlock(handle.flock, {
      prefixes: [
        machineFlockKeys.providerSetup(setupId),
        machineFlockKeys.providerSetupCancellation(setupId),
      ],
    });
    const setup = getMachineFlockProviderSetups(rows)[setupId];
    const cancellation = getMachineFlockProviderSetupCancellations(rows)[setupId];
    if (
      cancellation &&
      (!setup?.setupRevision ||
        !cancellation.setupRevision ||
        setup.setupRevision === cancellation.setupRevision)
    ) {
      return undefined;
    }
    return setup;
  }

  private async readAgentConfig(setupId: AgentConfigId) {
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
    status: ProviderSetupStatus
  ): Promise<ProviderSetupTask | undefined> {
    const current = await this.readSetup(setupId);
    if (!current || current.attempt !== attempt) return undefined;
    const { failureCode: _failureCode, ...base } = current;
    const next: ProviderSetupTask = {
      ...base,
      status,
      updatedAt: getServerNow(),
    };
    await this.writeSetup(next);
    return next;
  }

  private async fail(
    setupId: AgentConfigId,
    attempt: number,
    failureCode: ProviderSetupFailureCode
  ): Promise<void> {
    const current = await this.readSetup(setupId);
    if (!current || current.attempt !== attempt) return;
    await this.writeSetup({
      ...current,
      status: 'failed',
      failureCode,
      updatedAt: getServerNow(),
    });
  }

  private async writeSetup(setup: ProviderSetupTask): Promise<void> {
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
    if (!changed) return;
    await this.repo.flush();
    this.sync.markMachineFlockDocDirty(this.machineId, { reason: 'provider-setup-update' });
  }

  private async deleteSetup(setupId: AgentConfigId): Promise<void> {
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
    expectedSetupRevision?: string,
    signal?: AbortSignal,
    markCommitted?: () => void,
    verifiedConfig?: AgentConfigMeta
  ): Promise<PublishVerifiedConfigResult> {
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
    if (
      cancellation &&
      (!getMachineFlockProviderSetups(rows)[setupId]?.setupRevision ||
        !cancellation.setupRevision ||
        getMachineFlockProviderSetups(rows)[setupId]?.setupRevision === cancellation.setupRevision)
    ) {
      const changed = applyProviderSetupCancellationToFlock(
        handle.flock,
        cancellation,
        Math.max(getServerNow(), cancellation.cancelledAt)
      );
      if (changed) {
        await this.repo.flush();
        this.sync.markMachineFlockDocDirty(this.machineId, { reason: 'provider-setup-cancel' });
      }
      return { published: false };
    }
    const setup = getMachineFlockProviderSetups(rows)[setupId];
    if (
      !setup ||
      setup.attempt !== attempt ||
      (expectedSetupRevision
        ? setup.status !== 'awaiting-auth' || setup.setupRevision !== expectedSetupRevision
        : setup.status !== 'verifying') ||
      this.stopped
    ) {
      return { published: false };
    }
    const currentConfig = getMachineFlockAgentConfigs(rows)[setupId];
    if (currentConfig && !setup.replacesPublishedConfig) {
      await this.deleteSetup(setupId);
      return { published: false };
    }
    if (signal?.aborted) return { published: false };

    const now = getServerNow();
    const flock = handle.flock as unknown as MachineFlockWritableFlock;
    const publicationBase = verifiedConfig ?? setup.config;
    const publishedConfig =
      setup.replacesPublishedConfig && currentConfig
        ? {
            ...publicationBase,
            name: currentConfig.name,
            description: currentConfig.description,
            prompt: currentConfig.prompt,
            titleGeneration: currentConfig.titleGeneration,
            brandId: currentConfig.brandId,
          }
        : publicationBase;
    assertAgentConfigDoesNotContainCodexCredential(publishedConfig);
    flock.set(machineFlockKeys.agentConfig(setupId), publishedConfig, now);
    // Publishing is the user adding the provider explicitly, so the earlier same-type
    // removal intent has to be retracted too, or the list holds it while startup still
    // treats it as removed.
    const optOutKey = findBuiltinAgentOptOutToRetract(rows, publishedConfig);
    if (optOutKey) {
      flock.delete(optOutKey, now);
    }
    flock.delete(machineFlockKeys.providerSetup(setupId), now);
    flock.delete(machineFlockKeys.providerSetupCancellation(setupId), now);
    signal?.throwIfAborted();
    try {
      flock.commit();
    } catch (error) {
      this.logger.debug(
        `[provider-setup] Publication commit failed for configId=${setupId} setupRevision=${expectedSetupRevision ?? 'none'}: ${formatErrorMessage(error)}`
      );
      throw error;
    }
    markCommitted?.();
    try {
      await this.repo.flush();
    } catch (error) {
      this.logger.debug(
        `[provider-setup] Publication durability is uncertain for configId=${setupId} setupRevision=${expectedSetupRevision ?? 'none'}: ${formatErrorMessage(error)}`
      );
      this.sync.markMachineFlockDocDirty(this.machineId, { reason: 'provider-setup-publish' });
      return { published: true, durability: 'uncertain' };
    }
    this.sync.markMachineFlockDocDirty(this.machineId, { reason: 'provider-setup-publish' });
    return { published: true, durability: 'durable' };
  }
}
