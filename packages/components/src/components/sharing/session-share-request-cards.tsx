import { useState } from 'react';
import { useAtomValue } from 'jotai';
import { Share2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useCloudMutation, useCloudQuery } from '@lody/platform/react';
import type { SessionShareRequest } from '@lody/cloud-api';
import type { SessionMeta, WorkspaceId } from '@lody/shared';
import { userAtom } from '@/atoms';
import { sessionMetaCacheAtom } from '@/atoms/doc-meta';
import { useAppCapability } from '@/lib/app-platform';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { useResolvedWorkspaceScope } from '@/hooks/use-resolved-workspace-scope';
import { ErrorBoundary } from '@/components/error-boundary';
import { Button } from '@/ui/button';
import { useSessionShareManagement } from '@/hooks/use-session-share-management';

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
  // The request query reads cloud state and throws into render when the backend
  // fails. These cards are an optional affordance rendered inside the
  // conversation, so that throw must not reach the chat-stream boundary and
  // replace the whole conversation with a crash screen. The boundary still
  // reports the error; sign-in failures keep propagating to the app's auth
  // recovery.
  return (
    <ErrorBoundary
      name="SessionShareRequestCards"
      variant="inline"
      resetKeys={[userId, props.workspaceId, props.session.id]}
      fallbackRender={({ resetErrorBoundary }) => (
        <RequestsUnavailable onRetry={resetErrorBoundary} />
      )}
    >
      <RequestCards key={`${userId}:${props.workspaceId}:${props.session.id}`} {...props} />
    </ErrorBoundary>
  );
}

/** Pending requests stay invisible until the query recovers: nothing is publishable from here. */
function RequestsUnavailable({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="my-3 flex items-center gap-2 text-xs text-muted-foreground">
      <span role="status">
        {t('sharing.request.unavailable', 'Could not load pending share requests.')}
      </span>
      <Button size="sm" variant="ghost" onClick={onRetry}>
        {t('common.retry', 'Retry')}
      </Button>
    </div>
  );
}

function RequestCards({
  workspaceId,
  session,
}: {
  workspaceId: WorkspaceId;
  session: SessionMeta;
}) {
  const requests = useCloudQuery(cloudOperations.sessionSharing.listRequests, {
    workspaceId,
    sourceSessionId: session.id,
  });
  return (
    <>
      {requests
        ?.filter((request) => ['pending', 'confirmed', 'published'].includes(request.status))
        .map((request) => (
          <RequestCard
            key={request.requestId}
            workspaceId={workspaceId}
            session={session}
            request={request}
          />
        ))}
    </>
  );
}

function RequestCard({
  workspaceId,
  session,
  request,
}: {
  workspaceId: WorkspaceId;
  session: SessionMeta;
  request: SessionShareRequest;
}) {
  const meta = useAtomValue(sessionMetaCacheAtom);
  const management = useSessionShareManagement(
    workspaceId,
    session.id,
    request.sessionIds,
    request.shareId,
    request
  );
  const cancel = useCloudMutation(cloudOperations.sessionSharing.cancelRequest);
  const [dismissing, setDismissing] = useState(false);
  const [failed, setFailed] = useState(false);
  const busy = management.busy || dismissing;
  const published = request.status === 'published' || management.result !== null;
  const dismiss = async () => {
    if (busy) return;
    setDismissing(true);
    setFailed(false);
    try {
      await cancel({ requestId: request.requestId });
    } catch {
      setFailed(true);
    } finally {
      setDismissing(false);
    }
  };
  return (
    <SessionShareConsent
      request={request}
      titles={Object.fromEntries(Object.values(meta).map((entry) => [entry.id, entry.title ?? '']))}
      management={management}
      busy={busy}
      published={published}
      failed={failed}
      onApprove={() => void management.onPublish()}
      onDeny={() => void dismiss()}
    />
  );
}

export function SessionShareConsent({
  request,
  titles,
  management,
  busy,
  published,
  failed,
  onApprove,
  onDeny,
}: {
  request: Pick<SessionShareRequest, 'purpose' | 'sessionIds' | 'status'>;
  titles: Record<string, string>;
  management: Pick<
    ReturnType<typeof useSessionShareManagement>,
    'busy' | 'phase' | 'progress' | 'error' | 'hasPending' | 'canCapture' | 'conflict'
  >;
  busy: boolean;
  published: boolean;
  failed: boolean;
  onApprove: () => void;
  onDeny: () => void;
}) {
  const { t } = useTranslation();
  return (
    <section
      className="my-3 flex flex-col gap-2 rounded-md border border-border bg-card p-3"
      aria-label={t('sharing.request.title', 'Share this conversation?')}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Share2 className="h-3.5 w-3.5" aria-hidden />
        <span>{t('sharing.request.title', 'Share this conversation?')}</span>
      </div>
      <p className="whitespace-pre-wrap break-words text-sm">
        {t('sharing.request.purpose', 'Purpose: {{purpose}}', { purpose: request.purpose })}
      </p>
      <p className="text-sm leading-6">
        {t(
          'sharing.request.deliveryDisclosure',
          'Approval publishes the selected conversations, including thinking, tool output and images, but not file attachments. Anyone with the link can read them without signing in. The complete access link will be returned to the requesting agent, which can use or forward it. You can revoke the link in Share management; downloaded copies cannot be recalled.'
        )}
      </p>
      <ul className="space-y-0.5 text-xs text-muted-foreground">
        {request.sessionIds.map((id) => (
          <li key={id} className="break-words">
            {titles[id] || t('sessions.untitled', 'Untitled session')}
            <span className="ml-2 font-mono">{id}</span>
          </li>
        ))}
      </ul>
      {management.busy && (
        <p role="status" className="text-xs">
          {t('sharing.request.publishing', 'Publishing automatically…')}
          {management.phase === 'uploading' ? ` ${management.progress}%` : ''}
        </p>
      )}
      {published && (
        <p role="status" className="text-sm">
          {t(
            'sharing.request.delivered',
            'Published. The agent can now receive the complete link.'
          )}
        </p>
      )}
      {(management.error || failed) && (
        <p role="alert" className="text-sm text-destructive">
          {management.error ||
            t('sharing.request.failed', 'Could not dismiss the request. Try again.')}
        </p>
      )}
      {request.status === 'confirmed' && !management.hasPending && !busy && !published && (
        <p className="text-xs">
          {t(
            'sharing.request.incomplete',
            'This deployment is not published yet and cannot be resumed after the editor closes. Abandon it, then ask the agent for a new share request with a new requestId.'
          )}
        </p>
      )}
      {!published && (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" disabled={busy} onClick={onDeny}>
            {request.status === 'confirmed'
              ? t('sharing.request.abandon', 'Abandon deployment')
              : t('sharing.request.deny', 'Do not share')}
          </Button>
          {(request.status === 'pending' || management.hasPending) && (
            <Button
              size="sm"
              disabled={busy || !management.canCapture || management.conflict}
              onClick={onApprove}
            >
              {management.hasPending
                ? t('common.retry', 'Retry')
                : t('sharing.request.approve', 'Approve and share')}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
