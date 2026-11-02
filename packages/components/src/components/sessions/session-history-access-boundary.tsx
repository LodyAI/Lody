import { useMemo, type ReactNode } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import { selectAtom } from 'jotai/utils';
import { getSessionRoomId, type SessionId } from '@lody/shared';
import { sessionMetaAtomFamily } from '@/atoms/doc-meta';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import {
  useVisibleLocalProjectKeySet,
  useVisibleMachineIdSet,
} from '@/hooks/use-visible-session-metas';
import { useWorkspaceHistoryAccess } from '@/hooks/use-workspace-history-access';
import { isSessionMachineAvailable } from '@/lib/session-visibility';
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
                  machineId: meta.machineId,
                  project: meta.project,
                  parentSessionId: meta.parentSessionId,
                }
              : null,
          jsonValueEqual
        ),
      [sessionId]
    )
  );
}

/** An unavailable encrypted target never mounts the interactive machine-owning subtree. */
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
  const historyReadable = useWorkspaceHistoryAccess();
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const { t } = useTranslation();
  const root = useSessionTarget(sessionId);
  const selectedId = (urlTab || sessionId) as SessionId;
  const selected = useSessionTarget(selectedId);
  const { visibleMachineIds } = useVisibleMachineIdSet({ enabled: historyReadable });
  const { visibleLocalProjectKeys } = useVisibleLocalProjectKeySet({ enabled: historyReadable });
  const validTab = selectedId === sessionId || selected?.parentSessionId === sessionId;
  const historyOnly =
    historyReadable &&
    (!isSessionMachineAvailable(root, visibleMachineIds, visibleLocalProjectKeys) ||
      (validTab &&
        !isSessionMachineAvailable(selected, visibleMachineIds, visibleLocalProjectKeys)));
  if (runtime?.contentMode === 'e2ee' && !historyReadable)
    return <p role="status">{t('common.loading')}</p>;
  return historyOnly ? (
    <SessionHistoryReader
      key={`${runtime?.workspaceId}:${runtime?.accountId}:${sessionId}:${selectedId}`}
      rootSessionId={sessionId}
      sessionId={validTab ? selectedId : sessionId}
      onMobileBack={onMobileBack}
      onMobilePresented={onMobilePresented}
    />
  ) : (
    children
  );
}
