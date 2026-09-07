import {
  applyProviderSetupCancellationToFlock,
  deleteMachineFlockRowFromFlock,
  getMachineFlockAgentConfigs,
  getMachineFlockDocId,
  getMachineFlockProviderSetups,
  findBuiltinAgentOptOutToRetract,
  getMachineFlockProviderSetupCancellations,
  getServerNow,
  machineFlockKeys,
  readMachineFlockRowsFromFlock,
  writeMachineFlockRowToFlock,
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

type ProviderSetupExecution = Pick<
  SessionExecutionService,
  'getMachineAcpBinaryStatus' | 'installMachineAcpBinary' | 'refreshMachineAcpCapabilities'
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
};

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
  private drainPromise: Promise<void> | null = null;
  private drainRequested = false;
  private stopped = false;

  constructor(options: ProviderSetupManagerOptions) {
    this.repo = options.repo;
    this.workspaceId = options.workspaceId;
    this.machineId = options.machineId;
    this.execution = options.execution;
    this.sync = options.sync;
    this.logger = options.logger;
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

  private async waitUntilIdle(): Promise<void> {
    while (this.drainPromise) {
      await this.drainPromise;
    }
  }

  private async drain(): Promise<void> {
    while (!this.stopped) {
      this.drainRequested = false;
      await this.reconcileCancellations();
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
    if (existingConfig) {
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
      const response = await this.execution.refreshMachineAcpCapabilities({
        type: 'machine/acp-capabilities-refresh',
        machineId: this.machineId,
        workspaceId: this.workspaceId,
        configId: verifying.config.id,
      });
      if (response.success) {
        await this.publishVerifiedConfig(verifying.id, attempt);
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
    if (getMachineFlockProviderSetupCancellations(rows)[setupId]) {
      return undefined;
    }
    return getMachineFlockProviderSetups(rows)[setupId];
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

  private async publishVerifiedConfig(setupId: AgentConfigId, attempt: number): Promise<void> {
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
    if (!setup || setup.attempt !== attempt || setup.status !== 'verifying' || this.stopped) {
      return;
    }
    if (getMachineFlockAgentConfigs(rows)[setupId]) {
      await this.deleteSetup(setupId);
      return;
    }

    const now = getServerNow();
    const flock = handle.flock as unknown as MachineFlockWritableFlock;
    flock.set(machineFlockKeys.agentConfig(setupId), setup.config, now);
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
