import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useAtomValue } from 'jotai';
import { AlertCircle, Clock3, Download, Eye, Image as ImageIcon } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import type { SessionId, WorkspaceId } from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { DEFAULT_CONVERSATION_FONT_SIZE, type ConversationFontSize } from '@/atoms/settings';
import { conversationTextFontSizeStyle } from '@/components/ai-gui/conversation-font-size-classes';
import {
  getSessionFileIcon,
  SessionFileCardLayout,
  SessionFileCardList,
} from '@/components/ai-gui/session-file-card';
import { formatFileSize } from '@/lib/session-file-presentation';
import { peekSessionImageUrl } from '@/lib/session-image-cache';
import type { SessionChatUser } from '@/components/ai-gui/view';
import { ConversationColumn } from '@/components/shared/conversation-column';
import { UserAvatar } from '@/components/user-avatar';
import { useIsMobile } from '@/hooks/use-mobile';
import type { ConversationView } from '@/lib/conversation-view/types';
import { formatConversationTimestamp } from '@/lib/format-conversation-timestamp';
import { toIntlLocale } from '@/lib/intl-locale';
import type { SessionAttachmentDraft } from '@/lib/session-attachment-draft';
import type { PendingSessionSend } from '@/lib/session-pending-sends';
import { isQueueBoundSend } from '@/lib/session-send-status';
import { cn } from '@/lib/utils';
import { Button } from '@lody/ui/button';
import { Progress } from '@lody/ui/progress';
import { Spinner } from '@/ui/spinner';

const empty: readonly PendingSessionSend[] = [];
const emptySnapshot = () => empty;
const emptySubscribe = () => () => {};

/**
 * Attachments share a card across uploading, stopped, ready and failed states. The
 * fixed layout (icon slot / name + one status line / trailing status slot) keeps the
 * row stable as attachments move between them. `ready` wins over
 * `error`: preparation clears the error when it later succeeds, and a retry
 * skips attachments that already finished.
 */
type PendingAttachmentState = 'uploading' | 'interrupted' | 'ready' | 'failed';

const attachmentState = (
  attachment: SessionAttachmentDraft,
  active = true
): PendingAttachmentState =>
  attachment.ready ? 'ready' : attachment.error ? 'failed' : active ? 'uploading' : 'interrupted';

/** The one status line inside a card. The failed card owns the whole reason. */
function useAttachmentStatus(attachment: SessionAttachmentDraft, active: boolean) {
  const { t } = useTranslation();
  const state = attachmentState(attachment, active);
  const label =
    state === 'ready'
      ? t('sessions.attachmentPrepared')
      : state === 'failed'
        ? (attachment.error ?? '')
        : state === 'interrupted'
          ? t('sessions.attachmentInterrupted')
          : t('sessions.attachmentUploading', { progress: attachment.progress ?? 0 });
  return { state, label };
}

/**
 * The whole red budget for a failure, in one place. A frame this faint plus one
 * glyph is enough to find the broken attachment; tinting the icon tile, the
 * filename, or the message status on top of it just made the row shout.
 */
const FAILED_FRAME_CLASS = 'border-destructive/30 bg-destructive/[0.04]';

/**
 * A reason that has no attachment card to live on still arrives inside the same
 * frame, so every failure in the row reads as one kind of object. Loose red text
 * under the bubble was the one shape that did not.
 */
function PendingFailureNotice({
  reason,
  clamp,
  role,
}: {
  reason: string;
  clamp?: boolean;
  role?: 'alert';
}) {
  return (
    <div
      className={cn(
        'ml-auto flex w-full max-w-sm items-start gap-2 rounded-lg border px-2.5 py-2',
        FAILED_FRAME_CLASS
      )}
      role={role}
    >
      <AlertCircle
        className="mt-px size-3.5 shrink-0 text-destructive"
        strokeWidth={2}
        aria-hidden="true"
      />
      <span
        className={cn(
          'min-w-0 text-xs leading-snug break-words text-destructive',
          clamp && 'line-clamp-2'
        )}
      >
        {reason}
      </span>
    </div>
  );
}

const styles = stylex.create({
  progress: { position: 'absolute', insetInline: 0, bottom: 0, pointerEvents: 'none' },
  metadata: { maxWidth: '100%' },
  timestamp: { flexShrink: 0, whiteSpace: 'nowrap' },
  status: { minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap' },
  statusLabel: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' },
});

/** Overlay the delivered card's bottom edge without adding a layout row. */
function AttachmentProgressTrack({
  attachment,
  active,
}: {
  attachment: SessionAttachmentDraft;
  active: boolean;
}) {
  const { t } = useTranslation();
  return active ? (
    <div {...stylex.props(styles.progress)} data-attachment-progress="">
      <Progress
        value={attachment.progress ?? 0}
        aria-label={t('sessions.attachmentUploading', { progress: attachment.progress ?? 0 })}
      />
    </div>
  ) : null;
}

/** The delivered `UserImageBlock`'s large-thumbnail square. */
const IMAGE_SQUARE_CLASS = 'h-36 w-36 sm:h-40 sm:w-40';

/**
 * Framed like the delivered image the commit replaces it with: a lone image at
 * its natural size capped at 10.5rem, several as large squares. The delivered
 * image has no caption row, so the progress strip rides the frame's bottom edge
 * instead; a caption here is what made the row shrink the moment it was sent.
 */
function PendingImageAttachment({
  attachment,
  active,
  single,
  workspaceId,
  sessionId,
}: {
  attachment: SessionAttachmentDraft;
  active: boolean;
  single: boolean;
  workspaceId: WorkspaceId;
  sessionId: SessionId;
}) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!attachment.source) {
      setPreviewUrl(null);
      return undefined;
    }
    const url = URL.createObjectURL(attachment.source);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [attachment.source]);

  const { state, label } = useAttachmentStatus(attachment, active);
  const failed = state === 'failed';
  const readyPreviewUrl =
    attachment.ready?.type === 'image'
      ? peekSessionImageUrl({ workspaceId, sessionId, imageId: attachment.ready.imageId })
      : null;
  const displayedPreviewUrl = readyPreviewUrl ?? previewUrl;

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-xl border transition-colors',
        failed ? FAILED_FRAME_CLASS : 'border-border/70 bg-muted/20',
        single ? 'inline-flex max-w-full flex-col' : `${IMAGE_SQUARE_CLASS} shrink-0`
      )}
      title={`${attachment.name} · ${label}`}
    >
      {displayedPreviewUrl ? (
        <img
          src={displayedPreviewUrl}
          alt={attachment.name}
          className={
            single
              ? 'block max-h-[10.5rem] max-w-full object-contain'
              : `${IMAGE_SQUARE_CLASS} object-cover`
          }
        />
      ) : (
        <div
          className={cn(
            'flex items-center justify-center text-muted-foreground',
            single ? 'h-36 w-56 max-w-full sm:w-72 md:w-80' : IMAGE_SQUARE_CLASS
          )}
        >
          <ImageIcon className="size-6" aria-hidden="true" />
        </div>
      )}
      {failed ? (
        /* Neutral scrim, not a red wash: it only has to make the one glyph
           legible over whatever the photo happens to be. */
        <div className="absolute inset-0 flex items-center justify-center bg-background/55">
          <AlertCircle className="size-6 text-destructive" aria-hidden="true" />
        </div>
      ) : null}
      <AttachmentProgressTrack attachment={attachment} active={state === 'uploading'} />
    </div>
  );
}

function PendingFileAttachment({
  attachment,
  active,
}: {
  attachment: SessionAttachmentDraft;
  active: boolean;
}) {
  const { state, label } = useAttachmentStatus(attachment, active);
  const failed = state === 'failed';
  const Icon = getSessionFileIcon(attachment.name, attachment.mimeType);

  const ready = attachment.ready?.type === 'file' ? attachment.ready : undefined;
  const ReadyIcon = ready?.transport === 'local' ? Clock3 : ready?.textPreview ? Eye : Download;
  return (
    <SessionFileCardLayout
      fileName={attachment.name}
      subtitle={ready ? formatFileSize(ready.sizeBytes) : label}
      icon={<Icon className="size-5" aria-hidden="true" />}
      actionIcon={
        failed ? (
          <AlertCircle className="size-4 text-destructive" aria-hidden="true" />
        ) : state === 'uploading' ? (
          <Spinner className="size-4" />
        ) : state === 'ready' ? (
          <ReadyIcon className="size-4" aria-hidden="true" />
        ) : (
          <Clock3 className="size-4" aria-hidden="true" />
        )
      }
      failed={failed}
      progress={<AttachmentProgressTrack attachment={attachment} active={state === 'uploading'} />}
    />
  );
}

/**
 * A pending send is an ORDINARY right-aligned user message, not an error card:
 * the message level carries one short status ("Not sent"), and the reason lives
 * inside the attachment card that actually failed. Exported for Storybook so the
 * states render without a workspace runtime.
 *
 * The shell (avatar column, widths, metadata line, image frames, text bubble)
 * mirrors the delivered `UserMessageRowView`: when the turn commits, that row
 * takes this one's place and only the status beside the timestamp changes.
 */
export function PendingMessageRow({
  record,
  user,
  conversationFontSize = DEFAULT_CONVERSATION_FONT_SIZE,
  onRetry,
  onCancel,
  busy = false,
}: {
  record: PendingSessionSend;
  user?: SessionChatUser;
  conversationFontSize?: ConversationFontSize;
  busy?: boolean;
  onRetry: () => void;
  onCancel: () => void;
}) {
  const { t, i18n } = useTranslation();
  const isMobile = useIsMobile();
  const text = record.entry.items
    ?.flatMap((item) => (item.type === 'text' ? [item.text] : []))
    .join('\n');
  const timestampLabel = formatConversationTimestamp(record.entry.timestamp, {
    locale: toIntlLocale(i18n?.resolvedLanguage ?? i18n?.language),
  });
  const failed = Boolean(record.error);
  const images = record.attachments.filter((attachment) => attachment.kind === 'image');
  const files = record.attachments.filter((attachment) => attachment.kind === 'file');
  const uploading = record.attachments.some((attachment) => !attachment.ready);
  // Only fall back to the record-level reason when no card shows one, so the
  // same failure is never spelled out twice. Image frames carry no caption.
  const reasonOnACard = files.some((attachment) => attachmentState(attachment) === 'failed');
  const messageStatus = failed
    ? t('sessions.pendingMessageUploadFailed')
    : uploading
      ? t('sessions.pendingMessageUploading')
      : t('sessions.pendingMessageWaiting');

  return (
    <ConversationColumn className="py-2 sm:py-3">
      <article className={cn('flex w-full flex-row-reverse', isMobile ? 'gap-2 pl-7' : 'gap-2.5')}>
        <div className="mt-0.5 shrink-0 text-muted-foreground">
          <UserAvatar user={user} size="large" showIcon />
        </div>
        <div
          className={cn(
            'flex min-w-0 flex-1 flex-col items-end text-left',
            isMobile
              ? 'max-w-[min(100%,28rem)] gap-1'
              : 'max-w-full gap-1.5 @[520px]:max-w-[80%] @[720px]:max-w-[70%]'
          )}
        >
          <div
            className={cn(
              'flex flex-row-reverse items-center gap-1.5 text-[11px] text-muted-foreground',
              stylex.props(styles.metadata).className
            )}
          >
            {timestampLabel ? (
              <span className={cn('tabular-nums', stylex.props(styles.timestamp).className)}>
                {timestampLabel}
              </span>
            ) : null}
            {/* Where the delivered row shows its read mark. Neutral on purpose:
                the icon and the word already say "not sent", and the failure
                itself is framed below. */}
            <span
              className={cn(
                'inline-flex items-center gap-1 text-muted-foreground',
                stylex.props(styles.status).className
              )}
              role="status"
              title={messageStatus}
            >
              {failed ? (
                <AlertCircle className="size-3.5" strokeWidth={2} aria-hidden="true" />
              ) : (
                <Clock3 className="size-3.5" strokeWidth={2} aria-hidden="true" />
              )}
              {isMobile ? (
                <span className="sr-only">{messageStatus}</span>
              ) : (
                <span {...stylex.props(styles.statusLabel)}>{messageStatus}</span>
              )}
            </span>
          </div>
          <div className="flex min-w-0 max-w-full flex-col items-end gap-2">
            {images.length ? (
              <div className="flex w-full flex-wrap justify-end gap-2 px-2 pt-1">
                {images.map((attachment) => (
                  <PendingImageAttachment
                    key={attachment.id}
                    attachment={attachment}
                    active={!failed}
                    single={images.length === 1}
                    workspaceId={record.workspaceId as WorkspaceId}
                    sessionId={record.sessionId}
                  />
                ))}
              </div>
            ) : null}
            {files.length ? (
              <SessionFileCardList align="end">
                {files.map((attachment) => (
                  <PendingFileAttachment
                    key={attachment.id}
                    attachment={attachment}
                    active={!failed}
                  />
                ))}
              </SessionFileCardList>
            ) : null}
            {text ? (
              <div className="flex max-w-full justify-end sm:pl-2">
                <div className="min-w-0 max-w-full rounded-[1.15rem] bg-foreground/[0.05] px-3.5 py-2 sm:rounded-2xl sm:px-4 sm:py-2.5">
                  <div
                    className="min-w-0 max-w-full whitespace-pre-wrap text-reading [overflow-wrap:anywhere]"
                    style={conversationTextFontSizeStyle(conversationFontSize)}
                  >
                    {text}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
          {failed && !reasonOnACard ? <PendingFailureNotice reason={record.error!} clamp /> : null}
          {/* Always in the flow at the delivered row's 28px action height, so
              committing (which swaps these for hover-revealed copy/fork) does
              not move anything below. */}
          <div className="flex min-h-7 flex-wrap items-center justify-end gap-2">
            <Button size="small" variant="ghost" disabled={busy} onClick={onCancel}>
              {t('sessions.cancelPendingSend')}
            </Button>
            {failed ? (
              <Button size="small" disabled={busy} onClick={onRetry}>
                {t('sessions.retryPendingSend')}
              </Button>
            ) : null}
          </div>
        </div>
      </article>
    </ConversationColumn>
  );
}

/**
 * Held sends render beside ordinary conversation messages, never in the
 * composer. `history` hides a send whose turn already landed: the write reaches
 * the conversation view before the held send is removed, and both must not show
 * at once. `user` is the local sender as the delivered row resolves it.
 */
export function SessionPendingMessages({
  sessionId,
  history,
  user,
  conversationFontSize,
}: {
  sessionId: SessionId;
  history?: Pick<ConversationView, 'indexOf' | 'subscribe'> | null;
  user?: SessionChatUser;
  conversationFontSize?: ConversationFontSize;
}) {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const pendingSends = runtime?.pendingSends;
  const sends = useSyncExternalStore(
    pendingSends?.subscribe ?? emptySubscribe,
    pendingSends?.getSnapshot ?? emptySnapshot,
    emptySnapshot
  );
  // A string snapshot: the view changes at token rate, the landed set rarely.
  const readLanded = () =>
    history
      ? sends
          .filter((send) => history.indexOf(send.id) >= 0)
          .map((send) => send.id)
          .join('\n')
      : '';
  const subscribeHistory = useCallback(
    (onChange: () => void) => history?.subscribe(onChange) ?? (() => {}),
    [history]
  );
  const landedKey = useSyncExternalStore(subscribeHistory, readLanded, readLanded);
  const landed = new Set(landedKey ? landedKey.split('\n') : []);
  const { t } = useTranslation();
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // Queue-bound messages render in the queue sheet instead.
  const pending = sends.filter(
    (send) => send.sessionId === sessionId && !isQueueBoundSend(send) && !landed.has(send.id)
  );
  if (!pending.length) return null;
  const action = async (send: PendingSessionSend, kind: 'retry' | 'cancel') => {
    setBusy(send.id);
    try {
      if (kind === 'cancel') await pendingSends?.cancel(send.id);
      else pendingSends?.retry(send.id);
      setFailure(null);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : t('sessions.sendError'));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section aria-label={t('sessions.pendingSends', { count: pending.length })}>
      {pending.map((send) => (
        <PendingMessageRow
          key={send.id}
          record={send}
          user={user}
          conversationFontSize={conversationFontSize}
          busy={busy === send.id}
          onRetry={() => void action(send, 'retry')}
          onCancel={() => void action(send, 'cancel')}
        />
      ))}
      {failure ? (
        <ConversationColumn className="pb-3">
          <PendingFailureNotice reason={failure} role="alert" />
        </ConversationColumn>
      ) : null}
    </section>
  );
}
