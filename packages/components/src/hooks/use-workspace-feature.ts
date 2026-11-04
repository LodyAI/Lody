import { currentWorkspaceIdAtom, currentWorkspaceSlugAtom } from '@/atoms/workspace-context';
import { useWorkspaceRouteTargetSlug } from '../providers/workspace-route-target';
import { userAtom } from '@/atoms';
import type { MachineId } from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { usePlatform, usePlatformWorkspaces } from '@lody/platform/react';
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
  const encrypted = Boolean(
    mode?.descriptor && 'contentMode' in mode.descriptor && mode.descriptor.contentMode === 'e2ee'
  );
  return workspaceSupports({ mode: encrypted ? 'protected' : 'plaintext' }, feature);
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

export type { LegacyWorkspaceQueryStatus } from '../lib/legacy-workspace-admission';
import {
  LegacyWorkspaceAdmissionError,
  assertLegacyWorkspaceAccess,
  resolveLegacyWorkspaceQueryStatus,
  type LegacyWorkspaceQueryStatus,
} from '../lib/legacy-workspace-admission';
import { useStore } from 'jotai';
import { useCallback } from 'react';

/** Consume RuntimeProvider's account/workspace-bound describe verdict. A local
 * runtime or a workspace listing cannot prove that remote plaintext APIs apply.
 */
export function useLegacyWorkspaceQueryStatus(
  workspaceId: string | null | undefined
): LegacyWorkspaceQueryStatus {
  const platform = usePlatform();
  const mode = useAtomValue(workspaceContentModeAtom);
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const accountId = useAtomValue(userAtom)?.id ?? null;
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom);
  const currentWorkspaceSlug = useAtomValue(currentWorkspaceSlugAtom);
  const routeSlug = useWorkspaceRouteTargetSlug() ?? currentWorkspaceSlug;
  const workspacesState = usePlatformWorkspaces();
  return resolveLegacyWorkspaceQueryStatus({
    workspaceId,
    platformKind: platform.kind,
    mode,
    runtime,
    accountId,
    currentWorkspaceId,
    routeSlug,
    workspacesState,
  });
}

/** This UI/query decision never grants access to a machine or transport. */
export function useLegacyWorkspaceQueriesEnabled(workspaceId: string | null | undefined): boolean {
  return useLegacyWorkspaceQueryStatus(workspaceId) === 'allowed';
}

/** Recheck live atoms at the actual operation, including callbacks retained across navigation. */
export function useAssertLegacyWorkspaceAccess() {
  const store = useStore();
  const platform = usePlatform();
  const currentSlug = useAtomValue(currentWorkspaceSlugAtom);
  const routeSlug = useWorkspaceRouteTargetSlug() ?? currentSlug;
  const accountId = useAtomValue(userAtom)?.id ?? null;
  return useCallback(
    (workspaceId: string | null | undefined) => {
      if ((store.get(userAtom)?.id ?? null) !== accountId && platform.kind !== 'local')
        throw new LegacyWorkspaceAdmissionError('account_changed');
      return assertLegacyWorkspaceAccess({
        workspaceId,
        platformKind: platform.kind,
        mode: store.get(workspaceContentModeAtom),
        runtime: store.get(activeWorkspaceRuntimeAtom),
        accountId: store.get(userAtom)?.id ?? null,
        currentWorkspaceId: store.get(currentWorkspaceIdAtom),
        routeSlug,
        workspacesState: platform.workspaces.state.get(),
      });
    },
    [store, platform, routeSlug, accountId]
  );
}
