import { useState } from 'react';
import { useAtomValue } from 'jotai';
import { AlertCircle, AlertTriangle, Share2 } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
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
import { Button } from '@lody/ui/button';
import { useSessionShareManagement } from '@/hooks/use-session-share-management';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { corner, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { shareSurface } from './surface';

const styles = stylex.create({
  unavailable: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    marginBlock: space[3],
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
  },
  /** The consent is a block of the conversation: the card rung, no border. */
  card: {
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    gap: space[3],
    marginBlock: space[3],
    padding: space[4],
    backgroundColor: colors.elevatedBackground,
    boxShadow: shadow.card,
    borderRadius: radius.large,
    cornerShape: corner.shape,
    color: colors.label,
  },
  eyebrow: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1.5],
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
  },
  eyebrowIcon: { flexShrink: 0, width: '14px', height: '14px' },
  purpose: {
    margin: 0,
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
    fontWeight: 500,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
  prose: { margin: 0, fontSize: text.bodySize, lineHeight: text.bodyLeading },
  /** The exact targets: a block inside the card, so the region rung. */
  targets: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    margin: 0,
    listStyle: 'none',
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
  },
  target: { overflowWrap: 'anywhere' },
  ink: { color: colors.label },
  targetId: {
    marginInlineStart: space[2],
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  },
  status: {
    margin: 0,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
  },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: space[2] },
});

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
    <div {...stylex.props(styles.unavailable)}>
      <span role="status">
        {t('sharing.request.unavailable', 'Could not load pending share requests.')}
      </span>
      <Button size="small" variant="ghost" onClick={onRetry}>
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
        ?.filter((request) => ['pending', 'confirmed'].includes(request.status))
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
  if (published) return null;
  return (
    <section
      {...stylex.props(styles.card)}
      aria-label={t('sharing.request.title', 'Share this conversation?')}
    >
      <div {...stylex.props(styles.eyebrow)}>
        <Share2 {...stylex.props(styles.eyebrowIcon)} aria-hidden />
        <span>{t('sharing.request.title', 'Share this conversation?')}</span>
      </div>
      <p {...stylex.props(styles.purpose)}>
        {t('sharing.request.purpose', 'Purpose: {{purpose}}', { purpose: request.purpose })}
      </p>
      <p {...stylex.props(styles.prose)}>
        {t(
          'sharing.request.deliveryDisclosure',
          'Approval publishes the selected conversations, including thinking, tool output and images, but not file attachments. Anyone with the link can read them without signing in. The complete access link will be returned to the requesting agent, which can use or forward it. You can revoke the link in Share management; downloaded copies cannot be recalled.'
        )}
      </p>
      <ul {...stylex.props(shareSurface.region, styles.targets)}>
        {request.sessionIds.map((id) => (
          <li key={id} {...stylex.props(styles.target)}>
            <span {...stylex.props(styles.ink)}>
              {titles[id] || t('sessions.untitled', 'Untitled session')}
            </span>
            <span {...stylex.props(styles.targetId)}>{id}</span>
          </li>
        ))}
      </ul>
      {management.busy && (
        <p role="status" {...stylex.props(styles.status)}>
          {t('sharing.request.publishing', 'Publishing automatically…')}
          {management.phase === 'uploading' ? ` ${management.progress}%` : ''}
        </p>
      )}
      {(management.error || failed) && (
        <div role="alert" {...stylex.props(shareSurface.message, shareSurface.messageDestructive)}>
          <AlertCircle
            aria-hidden
            {...stylex.props(shareSurface.mark, shareSurface.markDestructive)}
          />
          <p {...stylex.props(styles.status, shareSurface.messageBody, styles.ink)}>
            {management.error ||
              t('sharing.request.failed', 'Could not dismiss the request. Try again.')}
          </p>
        </div>
      )}
      {request.status === 'confirmed' && !management.hasPending && !busy && !published && (
        <div {...stylex.props(shareSurface.message, shareSurface.messageWarning)}>
          <AlertTriangle
            aria-hidden
            {...stylex.props(shareSurface.mark, shareSurface.markWarning)}
          />
          <p {...stylex.props(styles.status, shareSurface.messageBody, styles.ink)}>
            {t(
              'sharing.request.incomplete',
              'This deployment is not published yet and cannot be resumed after the editor closes. Abandon it, then ask the agent for a new share request with a new requestId.'
            )}
          </p>
        </div>
      )}
      {!published && (
        <div {...stylex.props(styles.actions)}>
          <Button size="small" variant="ghost" disabled={busy} onClick={onDeny}>
            {request.status === 'confirmed'
              ? t('sharing.request.abandon', 'Abandon deployment')
              : t('sharing.request.deny', 'Do not share')}
          </Button>
          {(request.status === 'pending' || management.hasPending) && (
            <Button
              size="small"
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
