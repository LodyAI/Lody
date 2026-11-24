import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { getSessionOwnerAccessReason, type SessionMachineRecord } from '@/lib/session-visibility';
import { useVisibleLocalProjects } from './use-visible-local-projects';

/** Both menus and the write path use the current machine/project access projection. */
export function useSessionOwnerAccess() {
  const { t } = useTranslation();
  const index = useVisibleLocalProjects({ includeMachineFlock: false, includeMemberOnly: true });
  const latest = useRef(index);
  latest.current = index;
  return useCallback(
    (session: SessionMachineRecord, userId: string): string | null => {
      const { accessByMachineId, accessByProjectKey } = latest.current;
      const reason = getSessionOwnerAccessReason(
        session,
        userId,
        accessByMachineId,
        accessByProjectKey
      );
      switch (reason) {
        case 'machineUnavailable':
          return t('sessions.owner.machineUnavailable', 'Machine access unavailable');
        case 'machineNotShared':
          return t('sessions.owner.machineNotShared', 'Machine is not shared');
        case 'projectNotShared':
          return t('sessions.owner.projectNotShared', 'Local project is not shared');
        default:
          return null;
      }
    },
    [t, index]
  );
}
