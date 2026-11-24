import type { AgentConfigMeta, MachineId } from '@lody/shared';
import { createAsyncConcurrencyGate } from '@/lib/async-concurrency-gate';

export type StartupAcpCapabilitiesRefreshPorts = {
  listMachineIds: () => Promise<MachineId[]>;
  isMachineOnline: (machineId: MachineId) => boolean;
  listAgentConfigs: (machineId: MachineId) => Promise<AgentConfigMeta[]>;
  refreshAgentConfig: (
    machineId: MachineId,
    config: AgentConfigMeta,
    signal?: AbortSignal
  ) => Promise<void>;
  onError?: (error: unknown, context: { machineId: MachineId; configId?: string }) => void;
};

export type StartupAcpCapabilitiesRefreshResult = {
  hasFailures: boolean;
};

/**
 * Refresh every configured ACP on online machines once, serializing configs per machine.
 *
 * Connection invariant: callers must reuse the workspace runtime's existing Machine
 * Flock and RPC transports. This pass may add bounded RPC work, but it must never
 * create or retain one Streams subscription per agent config or refresh request.
 *
 * "Once" is owned by `refreshedConfigKeys`, not by the caller's decision to start
 * a pass. A pass that is aborted mid-way — presence leaving `synced` does exactly
 * that — is restarted by the caller, and without a record of which configs already
 * answered, each restart re-probed every config and turned one startup scan into a
 * standing per-reconnect probe cycle. Configs recorded here are skipped; failures
 * are deliberately not recorded, so they stay retryable on the next pass.
 */
export async function runStartupAcpCapabilitiesRefresh(
  ports: StartupAcpCapabilitiesRefreshPorts,
  options: {
    /** Caller-owned set, shared across every pass of one workspace runtime. */
    refreshedConfigKeys: Set<string>;
    machineConcurrency?: number;
    signal?: AbortSignal;
  }
): Promise<StartupAcpCapabilitiesRefreshResult> {
  const { refreshedConfigKeys, signal } = options;
  let hasFailures = false;
  if (signal?.aborted) return { hasFailures: true };
  const listedMachineIds = await ports.listMachineIds();
  if (signal?.aborted) return { hasFailures: true };
  const machineIds = listedMachineIds.filter(ports.isMachineOnline);
  const runMachine = createAsyncConcurrencyGate(options.machineConcurrency ?? 2);

  await Promise.all(
    machineIds.map((machineId) =>
      runMachine(async () => {
        if (signal?.aborted || !ports.isMachineOnline(machineId)) {
          hasFailures = true;
          return;
        }

        let configs: AgentConfigMeta[];
        try {
          configs = await ports.listAgentConfigs(machineId);
        } catch (error) {
          hasFailures = true;
          if (signal?.aborted) return;
          ports.onError?.(error, { machineId });
          return;
        }

        for (const config of configs) {
          if (signal?.aborted || !ports.isMachineOnline(machineId)) {
            hasFailures = true;
            return;
          }
          if (config.machineId !== machineId) {
            hasFailures = true;
            ports.onError?.(new Error('Agent config belongs to a different machine'), {
              machineId,
              configId: config.id,
            });
            continue;
          }
          const refreshedConfigKey = `${machineId}\u0000${config.id}`;
          if (refreshedConfigKeys.has(refreshedConfigKey)) {
            continue;
          }
          try {
            await ports.refreshAgentConfig(machineId, config, signal);
            refreshedConfigKeys.add(refreshedConfigKey);
          } catch (error) {
            hasFailures = true;
            if (signal?.aborted) return;
            ports.onError?.(error, { machineId, configId: config.id });
          }
        }
      })
    )
  );

  return { hasFailures: hasFailures || Boolean(signal?.aborted) };
}
