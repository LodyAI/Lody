import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import type { SessionMeta, WorkspaceId } from '@lody/shared';
import { sessionMetaCacheAtom } from '@/atoms/doc-meta';
import { getSessionShareCandidates } from '@/lib/session-share-candidates';
import { useSessionShareManagement } from '@/hooks/use-session-share-management';

/**
 * What the publication editor needs, whichever surface hosts it: the dialog or the
 * header panel. Mounted only while an editor is open, so a closed header neither
 * queries nor traverses session metadata.
 */
export function useShareEditorModel(
  workspaceId: WorkspaceId,
  session: SessionMeta,
  shareId?: string
) {
  const { t } = useTranslation();
  const meta = useAtomValue(sessionMetaCacheAtom);
  // Discovery proposes the explicit set frozen by the publishing client.
  const candidates = useMemo(
    () =>
      [session, ...getSessionShareCandidates(session.id, Object.values(meta)).slice(0, 96)].map(
        (entry) => ({
          sessionId: entry.id,
          title: (entry.title ?? '') || t('sessions.untitled', 'Untitled session'),
        })
      ),
    [meta, session, t]
  );
  const management = useSessionShareManagement(
    workspaceId,
    session.id,
    candidates.map((entry) => entry.sessionId),
    shareId
  );
  return { candidates, management };
}
