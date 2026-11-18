import type {
  AgentConfigListSummary,
  MachineCatalogPublicCapability,
  MachineCatalogQuotaEligibility,
  MachineId,
} from '@lody/shared';
import type { WorkspaceRuntime } from '../atoms/runtime';
export type MachineCatalogPublicTarget = Pick<
  AgentConfigListSummary,
  'id' | 'machineId' | 'cliType' | 'agentType'
>;
export type NativeMachineCatalogPublicView =
  | { readonly kind: 'legacy' }
  | {
      readonly kind: 'native';
      readonly synced: boolean;
      readonly generation: string | undefined;
      capability(config: MachineCatalogPublicTarget): MachineCatalogPublicCapability | undefined;
      roleCapability(
        config: MachineCatalogPublicTarget
      ): MachineCatalogPublicCapability | undefined;
      quota(config: MachineCatalogPublicTarget): MachineCatalogQuotaEligibility | undefined;
    };
/** A selected/frozen/unavailable native owner never falls through to Meta or
 * validates a private launch identity from missing renderer fields. */
export function readNativeMachineCatalogPublicView(
  runtime:
    | Pick<WorkspaceRuntime, 'ownsNativeMachineCatalog' | 'nativeMachineCatalogSource'>
    | null
    | undefined,
  machineId: MachineId
): NativeMachineCatalogPublicView {
  if (!runtime?.ownsNativeMachineCatalog?.(machineId)) return { kind: 'legacy' };
  const snapshot = runtime.nativeMachineCatalogSource?.readProjection(machineId);
  const selected = (config: MachineCatalogPublicTarget) => {
    if (
      !snapshot?.synced ||
      runtime.nativeMachineCatalogSource?.readProjection(machineId) !== snapshot ||
      config.machineId !== machineId
    )
      return undefined;
    const provider = snapshot.projection.agents.find((value) => value.id === config.id);
    if (!provider || provider.cliType !== config.cliType || provider.agentType !== config.agentType)
      return undefined;
    return snapshot.projection.acp.find(
      (value) =>
        value.configId === config.id &&
        value.cliType === config.cliType &&
        value.agentType === config.agentType
    );
  };
  const capability = (config: MachineCatalogPublicTarget) => selected(config)?.publicCapability;
  return {
    kind: 'native',
    get synced() {
      return (
        snapshot?.synced === true &&
        runtime.nativeMachineCatalogSource?.readProjection(machineId) === snapshot
      );
    },
    generation: snapshot?.generation,
    capability,
    roleCapability(config) {
      const value = capability(config);
      return value?.canValidateRolePins ? value : undefined;
    },
    quota: (config) => selected(config)?.quotaEligibility,
  };
}

/** Selection precedes access. A missing/reset native source cannot grant the
 * caller an old writer or manufacture an acknowledgement from a later read. */
export function nativeMachineCatalogSettingsForWrite(
  runtime: Pick<WorkspaceRuntime, 'workspaceId'> &
    Partial<Pick<WorkspaceRuntime, 'ownsNativeMachineCatalog' | 'nativeMachineCatalogSource'>>,
  machineId: MachineId
) {
  if (!runtime.ownsNativeMachineCatalog?.(machineId)) return undefined;
  const source = runtime.nativeMachineCatalogSource;
  const state = source?.readProjection(machineId);
  if (!source || !state?.synced) throw new Error('Native machine catalog is unavailable');
  const settings = source.getSnapshot();
  if (settings.binding.workspaceId !== runtime.workspaceId)
    throw new Error('Native machine catalog binding changed');
  return settings;
}
