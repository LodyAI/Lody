import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useAtomValue } from 'jotai';
import {
  AlertCircle,
  CheckCircle2,
  Circle,
  Clock3,
  Download,
  Eye,
  Image as ImageIcon,
} from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { useTranslation } from 'react-i18next';
import type { SessionId, WorkspaceId } from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { getRpcDeliveredTurnKey, rpcDeliveredTurnsAtom } from '@/atoms/session-dispatch-delivery';
import { DEFAULT_CONVERSATION_FONT_SIZE, type ConversationFontSize } from '@/atoms/settings';
import { conversationTextFontSizeStyle } from '@/components/ai-gui/conversation-font-size-classes';
import { useIsMessageSendingVisible } from '@/components/ai-gui/message-send-status-context';
import {
  formatSessionFileMeta,
  SessionFileCardLayout,
  SessionFileCardList,
} from '@/components/ai-gui/session-file-card';
import { peekSessionImageUrl } from '@/lib/session-image-cache';
import { UserChatBubble, type SessionChatUser } from '@/components/ai-gui/view';
import { ConversationColumn } from '@/components/shared/conversation-column';
import { UserAvatar } from '@/components/user-avatar';
import { useIsMobile } from '@/hooks/use-mobile';
import type { ConversationView } from '@/lib/conversation-view/types';
import { formatConversationTimestamp } from '@/lib/format-conversation-timestamp';
import { toIntlLocale } from '@/lib/intl-locale';
import type { SessionAttachmentDraft } from '@/lib/session-attachment-draft';
import type { PendingSessionSend } from '@/lib/session-pending-sends';
import { isQueueBoundSend } from '@/lib/session-send-status';
import { Button } from '@lody/ui/button';
import { Progress } from '@lody/ui/progress';
import { Spinner } from '@/ui/spinner';
import { themeColors } from '../../style/theme-colors.stylex';
import { themeRadius, themeSpace } from '../../style/theme-scale.stylex';

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

const styles = stylex.create({
  progress: { position: 'absolute', insetInline: 0, bottom: 0, pointerEvents: 'none' },
  metadata: { maxWidth: '100%' },
  timestamp: { flexShrink: 0, whiteSpace: 'nowrap' },
  status: { minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap' },
  statusLabel: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' },
  acceptedBubble: { position: 'relative', minWidth: 0, maxWidth: '100%' },
  sendingSpinner: {
    position: 'absolute',
    bottom: 13,
    right: '100%',
    marginRight: space[1.5],
    width: space[4],
    height: space[4],
    color: colors.secondaryLabel,
    display: { default: 'none', '@container (min-width: 520px)': 'inline-flex' },
  },
  sendingGlyph: { width: '100%', height: '100%' },

  /**
   * The whole red budget for a failure, in one place. A frame this faint plus one
   * glyph is enough to find the broken attachment; tinting the icon tile, the
   * filename, or the message status on top of it just made the row shout.
   */
  failedFrame: {
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'hsl(var(--destructive) / 0.3)',
    backgroundColor: 'hsl(var(--destructive) / 0.04)',
  },
  /**
   * A reason that has no attachment card to live on still arrives inside the same
   * frame, so every failure in the row reads as one kind of object. Loose red text
   * under the bubble was the one shape that did not.
   */
  failureNotice: {
    marginLeft: 'auto',
    display: 'flex',
    width: '100%',
    maxWidth: '24rem',
    alignItems: 'flex-start',
    gap: themeSpace[2],
    borderRadius: themeRadius.lg,
    paddingInline: themeSpace[2.5],
    paddingBlock: themeSpace[2],
  },
  failureGlyph: {
    marginTop: '1px',
    width: themeSpace[3.5],
    height: themeSpace[3.5],
    flexShrink: 0,
    color: themeColors.destructive,
  },
  failureReason: {
    minWidth: 0,
    fontSize: '0.75rem',
    lineHeight: '1.375',
    overflowWrap: 'break-word',
    color: themeColors.destructive,
  },
  failureReasonClamped: {
    overflow: 'hidden',
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: 2,
  },
  /** Said to a screen reader and to nobody else. */
  srOnly: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    margin: '-1px',
    padding: 0,
    overflow: 'hidden',
    clip: 'rect(0, 0, 0, 0)',
    whiteSpace: 'nowrap',
    borderWidth: 0,
  },

  /**
   * Framed like the delivered image the commit replaces it with: a lone image at
   * its natural size capped at 10.5rem, several as large squares. The delivered
   * image has no caption row, so the progress strip rides the frame's bottom edge
   * instead; a caption here is what made the row shrink the moment it was sent.
   */
  imageFrame: {
    position: 'relative',
    overflow: 'hidden',
    borderRadius: themeRadius.xl,
    borderWidth: '1px',
    borderStyle: 'solid',
    transitionProperty:
      'color, background-color, border-color, text-decoration-color, fill, stroke',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
  imageFrameSingle: {
    display: 'inline-flex',
    maxWidth: '100%',
    flexDirection: 'column',
  },
  imageFrameSquare: {
    width: 'calc(var(--spacing) * 36)',
    height: 'calc(var(--spacing) * 36)',
    flexShrink: 0,
    '@media (min-width: 640px)': {
      width: 'calc(var(--spacing) * 40)',
      height: 'calc(var(--spacing) * 40)',
    },
  },
  imageResting: {
    borderColor: 'hsl(var(--border) / 0.7)',
    backgroundColor: 'hsl(var(--muted) / 0.2)',
  },
  imageSingle: {
    display: 'block',
    maxHeight: '10.5rem',
    maxWidth: '100%',
    objectFit: 'contain',
  },
  imageSquare: {
    width: 'calc(var(--spacing) * 36)',
    height: 'calc(var(--spacing) * 36)',
    objectFit: 'cover',
    '@media (min-width: 640px)': {
      width: 'calc(var(--spacing) * 40)',
      height: 'calc(var(--spacing) * 40)',
    },
  },
  imagePlaceholder: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: themeColors.mutedForeground,
  },
  imagePlaceholderSingle: {
    height: 'calc(var(--spacing) * 36)',
    width: 'calc(var(--spacing) * 56)',
    maxWidth: '100%',
    '@media (min-width: 640px)': { width: 'calc(var(--spacing) * 72)' },
    '@media (min-width: 768px)': { width: 'calc(var(--spacing) * 80)' },
  },
  imagePlaceholderSquare: {
    width: 'calc(var(--spacing) * 36)',
    height: 'calc(var(--spacing) * 36)',
    '@media (min-width: 640px)': {
      width: 'calc(var(--spacing) * 40)',
      height: 'calc(var(--spacing) * 40)',
    },
  },
  imageGlyph: { width: themeSpace[6], height: themeSpace[6] },
  imageScrim: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'hsl(var(--background) / 0.55)',
  },
  scrimGlyph: { width: themeSpace[6], height: themeSpace[6], color: themeColors.destructive },
  fileGlyph: { width: themeSpace[4], height: themeSpace[4] },
  fileGlyphDestructive: {
    width: themeSpace[4],
    height: themeSpace[4],
    color: themeColors.destructive,
  },
  spinnerGlyph: { width: themeSpace[4], height: themeSpace[4] },

  /** The row: an ordinary right-aligned user message, not an error card. */
  row: { display: 'flex', width: '100%', flexDirection: 'row-reverse' },
  rowMobile: { gap: themeSpace[2], paddingLeft: themeSpace[7] },
  rowDesktop: { gap: themeSpace[2.5] },
  avatar: { marginTop: '0.5px', flexShrink: 0, color: themeColors.mutedForeground },
  body: {
    display: 'flex',
    minWidth: 0,
    flexGrow: 1,
    flexDirection: 'column',
    alignItems: 'flex-end',
    textAlign: 'left',
  },
  bodyMobile: { maxWidth: 'min(100%, 28rem)', gap: themeSpace[1] },
  bodyDesktop: {
    maxWidth: '100%',
    gap: themeSpace[1.5],
    '@container (min-width: 520px)': { maxWidth: '80%' },
    '@container (min-width: 720px)': { maxWidth: '70%' },
  },
  metadataRow: {
    display: 'flex',
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: themeSpace[1.5],
    fontSize: '11px',
    color: themeColors.mutedForeground,
  },
  timestampLabel: { fontVariantNumeric: 'tabular-nums' },
  statusRow: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: themeSpace[1],
    color: themeColors.mutedForeground,
  },
  statusGlyph: { width: themeSpace[3.5], height: themeSpace[3.5] },
  deliveredGlyph: { width: themeSpace[3.5], height: themeSpace[3.5], color: themeColors.primary },
  pendingGlyph: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
    color: themeColors.mutedForeground,
  },

  /** The not-yet-sent body. */
  held: {
    display: 'flex',
    minWidth: 0,
    maxWidth: '100%',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: themeSpace[2],
  },
  heldImages: {
    display: 'flex',
    width: '100%',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: themeSpace[2],
    paddingInline: themeSpace[2],
    paddingTop: themeSpace[1],
  },
  heldTextRow: {
    display: 'flex',
    maxWidth: '100%',
    justifyContent: 'flex-end',
    '@media (min-width: 640px)': { paddingLeft: themeSpace[2] },
  },
  heldBubble: {
    minWidth: 0,
    maxWidth: '100%',
    borderRadius: '1.15rem',
    backgroundColor: 'hsl(var(--foreground) / 0.05)',
    paddingInline: themeSpace[3.5],
    paddingBlock: themeSpace[2],
    '@media (min-width: 640px)': {
      borderRadius: themeRadius['2xl'],
      paddingInline: themeSpace[4],
      paddingBlock: themeSpace[2.5],
    },
  },
  heldText: {
    minWidth: 0,
    maxWidth: '100%',
    whiteSpace: 'pre-wrap',
    color: themeColors.reading,
    overflowWrap: 'anywhere',
  },
  actions: {
    display: 'flex',
    minHeight: themeSpace[7],
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: themeSpace[2],
  },
  column: {
    paddingBlock: themeSpace[2],
    '@media (min-width: 640px)': { paddingBlock: themeSpace[3] },
  },
  failureColumn: { paddingBottom: themeSpace[3] },
});

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
    <div {...stylex.props(styles.failureNotice, styles.failedFrame)} role={role}>
      <AlertCircle {...stylex.props(styles.failureGlyph)} strokeWidth={2} aria-hidden="true" />
      <span {...stylex.props(styles.failureReason, clamp && styles.failureReasonClamped)}>
        {reason}
      </span>
    </div>
  );
}

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
      {...stylex.props(
        styles.imageFrame,
        failed ? styles.failedFrame : styles.imageResting,
        single ? styles.imageFrameSingle : styles.imageFrameSquare
      )}
      title={`${attachment.name} · ${label}`}
    >
      {displayedPreviewUrl ? (
        <img
          src={displayedPreviewUrl}
          alt={attachment.name}
          {...stylex.props(single ? styles.imageSingle : styles.imageSquare)}
        />
      ) : (
        <div
          {...stylex.props(
            styles.imagePlaceholder,
            single ? styles.imagePlaceholderSingle : styles.imagePlaceholderSquare
          )}
        >
          <ImageIcon {...stylex.props(styles.imageGlyph)} aria-hidden="true" />
        </div>
      )}
      {failed ? (
        /* Neutral scrim, not a red wash: it only has to make the one glyph
           legible over whatever the photo happens to be. */
        <div {...stylex.props(styles.imageScrim)}>
          <AlertCircle {...stylex.props(styles.scrimGlyph)} aria-hidden="true" />
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
  const ready = attachment.ready?.type === 'file' ? attachment.ready : undefined;
  const ReadyIcon = ready?.transport === 'local' ? Clock3 : ready?.textPreview ? Eye : Download;
  return (
    <SessionFileCardLayout
      fileName={attachment.name}
      mimeType={attachment.mimeType}
      subtitle={ready ? formatSessionFileMeta(attachment.name, ready.sizeBytes) : label}
      actionIcon={
        failed ? (
          <AlertCircle {...stylex.props(styles.fileGlyphDestructive)} aria-hidden="true" />
        ) : state === 'uploading' ? (
          <Spinner className={stylex.props(styles.spinnerGlyph).className} />
        ) : state === 'ready' ? (
          <ReadyIcon {...stylex.props(styles.fileGlyph)} aria-hidden="true" />
        ) : (
          <Clock3 {...stylex.props(styles.fileGlyph)} aria-hidden="true" />
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
  const acceptedInput = Boolean(record.inputState);
  const delivered = useAtomValue(rpcDeliveredTurnsAtom).has(
    getRpcDeliveredTurnKey(record.sessionId, record.id)
  );
  const showSendingSpinner = useIsMessageSendingVisible(
    record.id,
    acceptedInput && !delivered && !failed
  );
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
    <ConversationColumn className={stylex.props(styles.column).className}>
      <article {...stylex.props(styles.row, isMobile ? styles.rowMobile : styles.rowDesktop)}>
        <div {...stylex.props(styles.avatar)}>
          <UserAvatar user={user} size="large" showIcon />
        </div>
        <div {...stylex.props(styles.body, isMobile ? styles.bodyMobile : styles.bodyDesktop)}>
          <div {...stylex.props(styles.metadataRow, styles.metadata)}>
            {timestampLabel ? (
              <span {...stylex.props(styles.timestampLabel, styles.timestamp)}>
                {timestampLabel}
              </span>
            ) : null}
            {acceptedInput ? (
              <span
                title={
                  delivered
                    ? t('sessions.sendStatus.delivered')
                    : t('sessions.sendStatus.sendingWithoutSize')
                }
              >
                {delivered ? (
                  <CheckCircle2 {...stylex.props(styles.deliveredGlyph)} strokeWidth={2} />
                ) : (
                  <Circle {...stylex.props(styles.pendingGlyph)} strokeWidth={2} />
                )}
              </span>
            ) : (
              <span
                {...stylex.props(styles.statusRow, styles.status)}
                role="status"
                title={messageStatus}
              >
                {failed ? (
                  <AlertCircle
                    {...stylex.props(styles.statusGlyph)}
                    strokeWidth={2}
                    aria-hidden="true"
                  />
                ) : (
                  <Clock3
                    {...stylex.props(styles.statusGlyph)}
                    strokeWidth={2}
                    aria-hidden="true"
                  />
                )}
                {isMobile ? (
                  <span {...stylex.props(styles.srOnly)}>{messageStatus}</span>
                ) : (
                  <span {...stylex.props(styles.statusLabel)}>{messageStatus}</span>
                )}
              </span>
            )}
          </div>
          {acceptedInput ? (
            <div {...stylex.props(styles.acceptedBubble)}>
              {showSendingSpinner ? (
                <span {...stylex.props(styles.sendingSpinner)}>
                  <Spinner {...stylex.props(styles.sendingGlyph)} />
                </span>
              ) : null}
              <UserChatBubble
                message={{ id: record.id, items: record.entry.items ?? [] }}
                sessionId={record.sessionId}
                conversationFontSize={conversationFontSize}
              />
            </div>
          ) : (
            <div {...stylex.props(styles.held)}>
              {images.length ? (
                <div {...stylex.props(styles.heldImages)}>
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
                <div {...stylex.props(styles.heldTextRow)}>
                  <div {...stylex.props(styles.heldBubble)}>
                    <div
                      {...stylex.props(styles.heldText)}
                      style={conversationTextFontSizeStyle(conversationFontSize)}
                    >
                      {text}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          )}
          {failed && !reasonOnACard ? <PendingFailureNotice reason={record.error!} clamp /> : null}
          {/* Always in the flow at the delivered row's 28px action height, so
              committing (which swaps these for hover-revealed copy/fork) does
              not move anything below. */}
          <div {...stylex.props(styles.actions)}>
            {!acceptedInput || failed ? (
              <Button size="small" variant="ghost" disabled={busy} onClick={onCancel}>
                {t(acceptedInput ? 'sessions.removeLocalInput' : 'sessions.cancelPendingSend')}
              </Button>
            ) : null}
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
 * Ready accepted inputs become individually keyed UI rows; attachment preparation
 * stays in the trailing slot. Only a hydrated history body completes the handoff.
 * Local input is neither authoritative history nor evidence of owner delivery.
 */
export function useSessionPendingMessages({
  sessionId,
  history,
  user,
  conversationFontSize,
}: {
  sessionId: SessionId;
  history?: Pick<ConversationView, 'indexOf' | 'turn' | 'subscribe'> | null;
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
          .filter((send) => {
            if (send.sessionId !== sessionId) return false;
            const index = history.indexOf(send.id);
            return index >= 0 && history.turn(index) !== undefined;
          })
          .map((send) => send.id)
          .join('\n')
      : '';
  const subscribeHistory = useCallback(
    (onChange: () => void) => history?.subscribe(onChange) ?? (() => {}),
    [history]
  );
  const landedKey = useSyncExternalStore(subscribeHistory, readLanded, readLanded);
  useEffect(() => {
    if (!landedKey || !pendingSends?.acknowledgeLanded) return;
    void pendingSends.acknowledgeLanded(landedKey.split('\n')).catch((error: unknown) => {
      console.warn('Confirmed input cleanup failed', error);
    });
  }, [pendingSends, landedKey, sends]);
  const { t } = useTranslation();
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // Queue-bound messages render in the queue sheet instead.
  const pending = useMemo(() => {
    const landed = new Set(landedKey ? landedKey.split('\n') : []);
    return sends.filter(
      (send) => send.sessionId === sessionId && !isQueueBoundSend(send) && !landed.has(send.id)
    );
  }, [sends, sessionId, landedKey]);
  const delivered = useAtomValue(rpcDeliveredTurnsAtom);
  const action = useCallback(
    async (send: PendingSessionSend, kind: 'retry' | 'cancel') => {
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
    },
    [pendingSends, t]
  );
  const rows = useMemo(
    () =>
      pending.map((send) => ({
        id: send.id,
        accepted: Boolean(send.inputState),
        content: (
          <PendingMessageRow
            key={send.id}
            record={send}
            user={user}
            conversationFontSize={conversationFontSize}
            busy={busy === send.id}
            onRetry={() => void action(send, 'retry')}
            onCancel={() => void action(send, 'cancel')}
          />
        ),
      })),
    [pending, user, conversationFontSize, busy, action]
  );
  const failureNotice = useMemo(
    () =>
      failure ? (
        <ConversationColumn className={stylex.props(styles.failureColumn).className}>
          <PendingFailureNotice reason={failure} role="alert" />
        </ConversationColumn>
      ) : null,
    [failure]
  );
  const localUserMessages = useMemo(() => rows.filter((row) => row.accepted), [rows]);
  const heldRows = useMemo(() => rows.filter((row) => !row.accepted), [rows]);
  const trailingContent = useMemo(
    () =>
      heldRows.length || failureNotice ? (
        <section aria-label={t('sessions.pendingSends', { count: heldRows.length })}>
          {heldRows.map((row) => row.content)}
          {failureNotice}
        </section>
      ) : null,
    [heldRows, failureNotice, t]
  );
  return {
    localUserMessages,
    isSending: pending.some(
      (send) =>
        Boolean(send.inputState) &&
        send.inputState !== 'confirmed' &&
        !send.error &&
        send.delivery.kind === 'dispatch' &&
        !delivered.has(getRpcDeliveredTurnKey(send.sessionId, send.id))
    ),
    trailingContent,
    content: pending.length ? (
      <section aria-label={t('sessions.pendingSends', { count: pending.length })}>
        {rows.map((row) => row.content)}
        {failureNotice}
      </section>
    ) : null,
  };
}

export function SessionPendingMessages(props: Parameters<typeof useSessionPendingMessages>[0]) {
  return useSessionPendingMessages(props).content;
}
