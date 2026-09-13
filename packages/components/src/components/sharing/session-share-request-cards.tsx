import { useState } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import { useCloudMutation, useCloudQuery } from '@lody/platform/react';
import type { SessionShareRequest } from '@lody/cloud-api';
import type { SessionMeta, WorkspaceId } from '@lody/shared';
import { userAtom } from '@/atoms';
import { sessionMetaCacheAtom } from '@/atoms/doc-meta';
import { useAppCapability } from '@/lib/app-platform';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { useResolvedWorkspaceScope } from '@/hooks/use-resolved-workspace-scope';
import { Button } from '@/ui/button';
import { SessionShareDialog } from './session-share-dialog';

/** Approval lives in authenticated cloud state, never in agent-writable history. */
export function SessionShareRequestCards(props: {
  workspaceId: WorkspaceId;
  session: SessionMeta;
  isVisible: boolean;
}) {
  const supported = useAppCapability('teamSharing');
  const scope = useResolvedWorkspaceScope({ workspaceId: props.workspaceId, enabled: supported });
  const userId = useAtomValue(userAtom)?.id;
  if (!scope.enabled || !userId || !props.isVisible) return null;
  return <RequestCards key={`${userId}:${props.workspaceId}:${props.session.id}`} {...props} />;
}

function RequestCards({
  workspaceId,
  session,
}: {
  workspaceId: WorkspaceId;
  session: SessionMeta;
}) {
  const { t } = useTranslation();
  const requests = useCloudQuery(cloudOperations.sessionSharing.listRequests, {
    workspaceId,
    sourceSessionId: session.id,
  });
  const cancel = useCloudMutation(cloudOperations.sessionSharing.cancelRequest);
  const meta = useAtomValue(sessionMetaCacheAtom);
  const [selected, setSelected] = useState<SessionShareRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const dismiss = async (requestId: string) => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await cancel({ requestId });
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {requests
        ?.filter((request) => request.status === 'pending' || request.status === 'confirmed')
        .map((request) => (
          <section
            key={request.requestId}
            className="my-3 rounded-lg border border-border p-4"
            aria-label={t('sharing.request.title', 'Share request')}
          >
            <p className="text-sm font-medium">{t('sharing.request.title', 'Share request')}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t(
                'sharing.request.notice',
                'The agent requested a static share. Nothing is published until you review and confirm.'
              )}
            </p>
            {request.status === 'confirmed' && (
              <p className="mt-1 text-sm text-muted-foreground">
                {selected?.requestId === request.requestId
                  ? t(
                      'sharing.request.incompleteOpen',
                      'This deployment is not published yet. Retry in the open editor. Closing it discards the upload credentials; you must then abandon this deployment and request a new share.'
                    )
                  : t(
                      'sharing.request.incomplete',
                      'This deployment is not published yet and cannot be resumed after the editor closes. Abandon it, then ask the agent for a new share request with a new requestId.'
                    )}
              </p>
            )}
            <ul className="my-2 list-inside list-disc text-sm">
              {request.sessionIds.map((id) => (
                <li key={id}>
                  {Object.values(meta).find((value) => value.id === id)?.title ||
                    t('sessions.untitled', 'Untitled session')}
                </li>
              ))}
            </ul>
            <div className="flex gap-2">
              {request.status === 'pending' && (
                <Button size="sm" disabled={busy} onClick={() => setSelected(request)}>
                  {t('sharing.request.review', 'Review share')}
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || selected?.requestId === request.requestId}
                onClick={() => void dismiss(request.requestId)}
              >
                {request.status === 'confirmed'
                  ? t('sharing.request.abandon', 'Abandon deployment')
                  : t('common.dismiss', 'Dismiss')}
              </Button>
            </div>
          </section>
        ))}
      {failed && (
        <p role="alert" className="text-sm text-destructive">
          {t('sharing.request.failed', 'Could not dismiss the request. Try again.')}
        </p>
      )}
      {/* Keep the editor mounted when begin consumes the pending request. */}
      {selected && (
        <SessionShareDialog
          workspaceId={workspaceId}
          session={session}
          confirmation={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  );
}
