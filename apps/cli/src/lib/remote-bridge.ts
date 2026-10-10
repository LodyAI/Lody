import { fileLocksLegacy } from '@/utils/file-lock';
import type { MachineId } from '@lody/shared';
import type { Logger } from '@/utils/logger';
import type { LocalWorkspaceCatalogService } from '@/lib/local-workspace-catalog';
import { formatErrorMessage } from '@/utils/format-error';

export type RemoteBridgeWorkspace = {
  id: string;
  name: string;
  slug: string | null;
  role: string;
};

export type RemoteBridgeRuntime = {
  attachRemoteBridge: () => Promise<void>;
  detachRemoteBridge: () => Promise<void>;
  handleRemoteAccessRevoked: () => Promise<void>;
};

export type RemoteBridgeReconcileResult = {
  allowedWorkspaceIds: Set<string>;
  revokedRunningWorkspaceIds: Set<string>;
};

const ATTACH_RETRY_INITIAL_DELAY_MS = 5_000;
const ATTACH_RETRY_MAX_DELAY_MS = 5 * 60_000;

export class RemoteBridge {
  private allowedWorkspaceIds = new Set<string>();
  private readonly attachRetryTimers = new Map<string, NodeJS.Timeout>();
  private readonly attachRetryDelaysMs = new Map<string, number>();

  constructor(
    private readonly args: {
      logger: Logger;
      catalog: LocalWorkspaceCatalogService;
      userId: string;
      machineId: MachineId;
      machineName: string;
      getRuntime: (workspaceId: string) => RemoteBridgeRuntime | undefined;
    }
  ) {}

  async reconcileOnline(input: {
    workspaces: RemoteBridgeWorkspace[];
    runningWorkspaceIds: Iterable<string>;
  }): Promise<RemoteBridgeReconcileResult> {
    await fileLocksLegacy.runPromise(
      this.args.catalog.cacheRemoteWorkspaces({
        identity: { userId: this.args.userId },
        machine: {
          machineId: this.args.machineId,
          machineName: this.args.machineName,
        },
        workspaces: input.workspaces,
      })
    );

    const allowedWorkspaceIds = new Set(input.workspaces.map((workspace) => workspace.id));
    this.allowedWorkspaceIds = allowedWorkspaceIds;
    for (const workspaceId of this.attachRetryTimers.keys()) {
      if (!allowedWorkspaceIds.has(workspaceId)) {
        this.clearAttachRetry(workspaceId);
      }
    }
    const revokedRunningWorkspaceIds = new Set<string>();

    for (const workspaceId of input.runningWorkspaceIds) {
      if (allowedWorkspaceIds.has(workspaceId)) {
        continue;
      }
      revokedRunningWorkspaceIds.add(workspaceId);
      const runtime = this.args.getRuntime(workspaceId);
      if (runtime) {
        await runtime.handleRemoteAccessRevoked();
      }
    }

    return { allowedWorkspaceIds, revokedRunningWorkspaceIds };
  }

  async attachAllowedRuntimes(workspaceIds: Iterable<string>): Promise<void> {
    for (const workspaceId of workspaceIds) {
      await this.attachRuntimeIfAllowed(workspaceId);
    }
  }

  async attachRuntimeIfAllowed(workspaceId: string): Promise<void> {
    if (!this.allowedWorkspaceIds.has(workspaceId)) {
      return;
    }
    const runtime = this.args.getRuntime(workspaceId);
    if (!runtime) {
      return;
    }
    try {
      await runtime.attachRemoteBridge();
      this.clearAttachRetry(workspaceId);
    } catch (error) {
      this.args.logger.warn(
        `[remote-bridge] Failed to attach workspace ${workspaceId}: ${formatErrorMessage(error)}`
      );
      // A markOffline/revoke may have raced this attach (that is exactly what a
      // superseded-epoch failure means); re-check before scheduling so an
      // offline/revoked workspace does not re-enter the retry loop.
      if (!this.allowedWorkspaceIds.has(workspaceId)) {
        return;
      }
      // The workspace-list subscription only re-fires on actual changes, so a
      // one-off failure (e.g. meta sync timeout on a slow catch-up) would leave
      // the workspace silently local-only forever without this retry.
      this.scheduleAttachRetry(workspaceId);
    }
  }

  async markOffline(runtimes: Iterable<RemoteBridgeRuntime>): Promise<void> {
    this.allowedWorkspaceIds.clear();
    this.clearAllAttachRetries();
    for (const runtime of runtimes) {
      try {
        await runtime.detachRemoteBridge();
      } catch (error) {
        this.args.logger.debug(
          `[remote-bridge] Failed to detach remote runtime: ${formatErrorMessage(error)}`
        );
      }
    }
  }

  shutdown(): void {
    this.clearAllAttachRetries();
  }

  private scheduleAttachRetry(workspaceId: string): void {
    if (this.attachRetryTimers.has(workspaceId)) {
      return;
    }
    const delayMs = this.attachRetryDelaysMs.get(workspaceId) ?? ATTACH_RETRY_INITIAL_DELAY_MS;
    this.attachRetryDelaysMs.set(workspaceId, Math.min(delayMs * 2, ATTACH_RETRY_MAX_DELAY_MS));
    const timer = setTimeout(() => {
      this.attachRetryTimers.delete(workspaceId);
      void this.attachRuntimeIfAllowed(workspaceId);
    }, delayMs);
    timer.unref?.();
    this.attachRetryTimers.set(workspaceId, timer);
  }

  private clearAttachRetry(workspaceId: string): void {
    const timer = this.attachRetryTimers.get(workspaceId);
    if (timer) {
      clearTimeout(timer);
      this.attachRetryTimers.delete(workspaceId);
    }
    this.attachRetryDelaysMs.delete(workspaceId);
  }

  private clearAllAttachRetries(): void {
    for (const timer of this.attachRetryTimers.values()) {
      clearTimeout(timer);
    }
    this.attachRetryTimers.clear();
    this.attachRetryDelaysMs.clear();
  }
}
