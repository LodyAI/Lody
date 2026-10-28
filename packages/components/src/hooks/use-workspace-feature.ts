import { runtimeAtom } from '@/atoms/runtime';
import type { MachineId } from '@lody/shared';
import { localMachineIdAtom } from '@/atoms/local-probe';
import { useTranslation } from 'react-i18next';
import { workspaceFeatureUnavailableMessage } from '@/lib/workspace-feature';
import { useAtomValue } from 'jotai';
import { workspaceContentModeAtom } from '@/atoms/workspace-content-mode';
import {
  workspaceSupports,
  type WorkspaceRestrictedFeature,
} from '@lody/shared/workspace-streams-content';

/** Local display guard. The operation must also check its explicit runtime/content. */
export function useWorkspaceFeature(feature: WorkspaceRestrictedFeature): boolean {
  const mode = useAtomValue(workspaceContentModeAtom);
  const runtime = useAtomValue(runtimeAtom);
  const encrypted = Boolean(
    mode?.descriptor && 'contentMode' in mode.descriptor && mode.descriptor.contentMode === 'e2ee'
  );
  return workspaceSupports(
    {
      mode: encrypted ? 'protected' : 'plaintext',
      encryptedPresence:
        runtime?.workspaceId === mode?.workspaceId &&
        runtime?.accountId === mode?.accountId &&
        runtime?.presenceAvailable === true,
    },
    feature
  );
}

/** An absent reason means supported; callers use the same verdict and copy. */
export function useWorkspaceFeatureReason(feature: WorkspaceRestrictedFeature): string | undefined {
  const allowed = useWorkspaceFeature(feature);
  const { t } = useTranslation();
  return allowed ? undefined : workspaceFeatureUnavailableMessage(feature, t);
}

/** Local IPC keeps its existing route; only unsupported remote controls are hidden. */
export function useMachineRpcFeatureReason(
  machineId: MachineId | string | null | undefined
): string | undefined {
  const reason = useWorkspaceFeatureReason('rpc');
  const localMachineId = useAtomValue(localMachineIdAtom);
  return machineId && machineId === localMachineId ? undefined : reason;
}
