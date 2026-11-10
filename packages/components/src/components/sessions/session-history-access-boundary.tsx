import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import { usePlatform } from '@lody/platform/react';
import { selectAtom } from 'jotai/utils';
import { getSessionRoomId, type SessionId } from '@lody/shared';
import { sessionMetaAtomFamily } from '@/atoms/doc-meta';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import {
  useVisibleLocalProjectKeySet,
  useVisibleMachineIdSet,
} from '@/hooks/use-visible-session-metas';
import { useSessionAccess } from '@/hooks/use-session-access';
import {
  isSessionMachineAvailable,
  isSessionReadShared,
  isContainedSession,
} from '@/lib/session-visibility';
import { useWorkspaceLocalAccountId } from '@/lib/e2ee-account';
import { jsonValueEqual } from '@/lib/json-value-equal';
import { SessionHistoryReader } from './session-history-reader';

function useSessionTarget(sessionId: SessionId) {
  return useAtomValue(
    useMemo(
      () =>
        selectAtom(
          sessionMetaAtomFamily(getSessionRoomId(sessionId)),
          (meta) =>
            meta
              ? {
                  id: sessionId,
                  machineId: meta.machineId,
                  userId: meta.userId,
                  project: meta.project,
                  parentSessionId: meta.parentSessionId,
                  childSessionPlacement: meta.childSessionPlacement,
                }
              : null,
          jsonValueEqual
        ),
      [sessionId]
    )
  );
}

/** Read-only targets never mount composers, machine catalogs, controls or RPC viewers. */
export function SessionHistoryAccessBoundary({
  sessionId,
  urlTab,
  onMobileBack,
  onMobilePresented,
  children,
}: {
  sessionId: SessionId;
  urlTab?: string;
  onMobileBack?: () => void;
  onMobilePresented?: (sessionId: string) => void;
  children: ReactNode;
}) {
  const accountId = useWorkspaceLocalAccountId();
  const localOnly = !usePlatform().capabilities.has('teamSharing');
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const { t } = useTranslation();
  const routed = useSessionTarget(sessionId);
  const parent = useSessionTarget((routed?.parentSessionId ?? sessionId) as SessionId);
  const root = isContainedSession(routed, parent) ? parent : routed;
  const rootId = root?.id ?? sessionId;
  const selectedId = (urlTab || sessionId) as SessionId;
  const selected = useSessionTarget(selectedId);
  const access = useSessionAccess();
  const {
    visibleMachineIds,
    ownedMachineIds,
    isLoading: machinesLoading,
  } = useVisibleMachineIdSet();
  const { visibleLocalProjectKeys, isLoading: projectsLoading } = useVisibleLocalProjectKeySet();
  const validTab = selectedId === rootId || isContainedSession(selected, root);
  const editable =
    !!root &&
    (ownedMachineIds.has(root.machineId) ||
      isSessionMachineAvailable(root, visibleMachineIds, visibleLocalProjectKeys)) &&
    (selectedId === rootId ||
      (validTab &&
        !!selected &&
        (ownedMachineIds.has(selected.machineId) ||
          isSessionMachineAvailable(selected, visibleMachineIds, visibleLocalProjectKeys))));
  const [checked, setChecked] = useState<object | null>(null);
  // Opening a deep link always authenticates this machine's latest policy as a fallback
  // for missed version notifications. The old policy cannot admit the first read.
  const checkKey = useMemo(() => ({}), [runtime, root?.machineId, selectedId, access.store]);
  useEffect(() => {
    let retired = false;
    if (!root?.machineId || !access.store || editable) {
      setChecked(checkKey);
      return;
    }
    void access.store.read(root.machineId).then(
      () => {
        if (!retired) setChecked(checkKey);
      },
      () => {
        if (!retired) setChecked(checkKey);
      }
    );
    return () => {
      retired = true;
    };
  }, [root?.machineId, access.store, editable, checkKey]);
  if (editable || localOnly) return children;
  if (machinesLoading || projectsLoading || access.loading || checked !== checkKey)
    return <p role="status">{t('common.loading')}</p>;
  // The detail subtree handles absent metadata, workspace transitions and local-only sessions.
  if (!root) return children;
  const readable =
    (isSessionReadShared(root, access.views, undefined, accountId) ||
      (!!accountId && root.userId === accountId)) &&
    (selectedId === rootId || (validTab && !!selected && selected.machineId === root.machineId));
  if (!readable) return <p role="status">{t('sessions.access.unavailable')}</p>;
  return (
    <SessionHistoryReader
      key={`${runtime?.workspaceId}:${runtime?.accountId}:${rootId}:${selectedId}`}
      rootSessionId={rootId}
      sessionId={validTab ? selectedId : rootId}
      onMobileBack={onMobileBack}
      onMobilePresented={onMobilePresented}
    />
  );
}
