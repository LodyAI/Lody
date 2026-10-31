import { runtimeInitializingAtom } from '@/atoms/control-connection';
import { useE2eeAccountId } from '@/lib/e2ee-account';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from '@tanstack/react-router';
import { useAtomValue, useSetAtom } from 'jotai';
import { usePlatform } from '@lody/platform/react';
import { BootNavigate } from '@/components/boot-navigate';
import { RouteMessage } from '@/components/route-message';
import { BlockingWaitPlaceholder } from '@/components/blocking-wait-placeholder';
import { userAtom } from '@/atoms';
import { e2eeWorkspaceCreationFeatureEnabledAtom } from '@/atoms/settings';
import { workspaceContentModeAtom } from '@/atoms/workspace-content-mode';
import {
  runtimeAtom,
  workspaceModeAdmissionRetryAtom,
  workspaceRuntimeInitFailureAtom,
  type WorkspaceRuntimeInitFailure,
} from '@/atoms/runtime';
import { WorkspaceModeAdmissionTimeoutError } from '../providers/workspace-mode-admission';
import { E2eeClientUpgradeRequiredError } from '../providers/cloud-e2ee-workspaces';
import {
  E2eeLocalEvidenceConflictError,
  E2eeLocalEvidenceCorruptError,
  repairUnreadableE2eeCaches,
  recoverE2eeWorkspaceIdentity,
} from '@/lib/e2ee-workspace-storage';

function admissionFailureHelp(errorType: string): string {
  switch (errorType) {
    case WorkspaceModeAdmissionTimeoutError.name:
      return 'e2ee.mode.timedOutHelp';
    case E2eeLocalEvidenceCorruptError.name:
      return 'e2ee.mode.localCorruptHelp';
    case E2eeLocalEvidenceConflictError.name:
      return 'e2ee.mode.localConflictHelp';
    case E2eeClientUpgradeRequiredError.name:
      return 'e2ee.mode.upgradeHelp';
    default:
      return 'e2ee.mode.failedHelp';
  }
}

/** Encryption is invisible until the user could have met it: the workspace is
 * known to be encrypted, or the developer encrypted-creation option is on. */
function showsEncryptionDetail(
  failure: WorkspaceRuntimeInitFailure,
  encryptedCreationEnabled: boolean
): boolean {
  return Boolean(
    failure.modeAdmission && (failure.modeAdmission.knownEncrypted || encryptedCreationEnabled)
  );
}

/** Holds the routed workspace until the runtime's admission verdict exists.
 * Ordinary workspaces receive a provisional verdict immediately and render as
 * before E2EE; only workspaces with encryption evidence wait here.
 */
export function WorkspaceAdmissionGate({
  workspaceName,
  children,
}: {
  workspaceName: string;
  children: ReactNode;
}) {
  const platform = usePlatform();
  const mode = useAtomValue(workspaceContentModeAtom);
  const user = useAtomValue(userAtom);
  const runtime = useAtomValue(runtimeAtom);
  const initializing = useAtomValue(runtimeInitializingAtom);
  const encrypted = Boolean(
    mode?.descriptor && 'contentMode' in mode.descriptor && mode.descriptor.contentMode === 'e2ee'
  );
  const failure = useAtomValue(workspaceRuntimeInitFailureAtom);
  const needsNativeIdentity =
    encrypted ||
    Boolean(failure?.workspaceSlug === workspaceName && failure.modeAdmission?.knownEncrypted);
  const e2eeAccountId = useE2eeAccountId(needsNativeIdentity);
  const accountId = user?.id ?? e2eeAccountId;
  const retryAdmission = useSetAtom(workspaceModeAdmissionRetryAtom);
  const encryptedCreationEnabled = useAtomValue(e2eeWorkspaceCreationFeatureEnabledAtom);
  const { t } = useTranslation();
  const navigate = useNavigate();
  const recoveryScope = JSON.stringify([accountId, workspaceName, failure]);
  const currentScope = useRef<string | null>(recoveryScope);
  currentScope.current = recoveryScope;
  const [recheckScope, setRecheckScope] = useState<string | null>(null);
  useEffect(() => {
    currentScope.current = recoveryScope;
    return () => {
      if (currentScope.current === recoveryScope) currentScope.current = null;
    };
  }, [recoveryScope]);
  if (
    failure?.workspaceSlug === workspaceName &&
    failure.errorType === 'e2ee_device_revoked' &&
    failure.workspaceId
  ) {
    const workspaceId = failure.workspaceId;
    // Membership remains: this device may be paired again from the control page.
    return (
      <RouteMessage
        gate={null}
        title={t('e2ee.devices.revokedTitle')}
        description={t('e2ee.devices.revoked')}
        actionLabel={t('e2ee.devices.pairAgain')}
        onRetry={() =>
          void navigate({ to: '/workspace/e2ee/$workspaceId', params: { workspaceId } })
        }
      />
    );
  }
  if (failure?.workspaceSlug === workspaceName && failure.errorType === 'e2ee_member_removed')
    return (
      <RouteMessage
        gate={null}
        title={t('e2ee.members.removedTitle')}
        description={t('e2ee.members.removed')}
      />
    );
  if (!platform.e2eeWorkspaces) return children;
  if (!mode || mode.workspaceSlug !== workspaceName || mode.accountId !== accountId) {
    if (failure?.workspaceSlug !== workspaceName) {
      return (
        <BlockingWaitPlaceholder
          gate="workspace_admission"
          variant="boot"
          title={t('workspace.route.loadingTitle')}
          description={t('workspace.route.loadingDescription')}
        />
      );
    }
    const encryption = showsEncryptionDetail(failure, encryptedCreationEnabled);
    return (
      <RouteMessage
        gate="workspace_admission"
        title={encryption ? t('e2ee.mode.failed') : t('workspace.route.openErrorTitle')}
        description={
          encryption
            ? t(
                recheckScope === recoveryScope
                  ? 'e2ee.mode.identityRecheckHelp'
                  : admissionFailureHelp(failure.errorType)
              )
            : t('workspace.route.openErrorDescription')
        }
        onRetry={() => {
          const identityFailure =
            failure.errorType === E2eeLocalEvidenceCorruptError.name ||
            failure.errorType === E2eeLocalEvidenceConflictError.name;
          const workspaceId = failure.modeAdmission?.workspaceId;
          const native = platform.e2eeWorkspaces?.runtime;
          const isCurrent = () => currentScope.current === recoveryScope;
          void (async () => {
            try {
              if (identityFailure && accountId) {
                if (workspaceId)
                  await recoverE2eeWorkspaceIdentity({
                    storage: localStorage,
                    accountId,
                    workspaceId,
                    runtime: native,
                    isCurrent,
                  });
                else repairUnreadableE2eeCaches(localStorage, accountId);
              }
              if (isCurrent()) retryAdmission((value) => value + 1);
            } catch {
              if (isCurrent()) setRecheckScope(recoveryScope);
            }
          })();
        }}
      />
    );
  }
  if (
    mode.descriptor &&
    'contentMode' in mode.descriptor &&
    mode.descriptor.contentMode === 'e2ee'
  ) {
    if (
      runtime?.workspaceId === mode.workspaceId &&
      runtime.accountId === mode.accountId &&
      runtime.contentMode === 'e2ee'
    )
      return children;
    if (initializing)
      return (
        <BlockingWaitPlaceholder
          gate="workspace_admission"
          variant="boot"
          title={t('workspace.route.loadingTitle')}
          description={t('workspace.route.loadingDescription')}
        />
      );
    return (
      <BootNavigate
        to="/workspace/e2ee/$workspaceId"
        params={{ workspaceId: mode.workspaceId }}
        replace
      />
    );
  }
  return children;
}
