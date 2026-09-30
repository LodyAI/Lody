import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useAtomValue } from 'jotai';
import { AlertCircle, Check, Clock3, Image as ImageIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { SessionId } from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { DEFAULT_CONVERSATION_FONT_SIZE, type ConversationFontSize } from '@/atoms/settings';
import { conversationTextFontSizeStyle } from '@/components/ai-gui/conversation-font-size-classes';
import { getSessionFileIcon } from '@/components/ai-gui/session-file-card';
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
 * skeleton (icon slot / name + one status line / trailing status slot) so the
 * row does not resize as attachments move between them. `ready` wins over
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

/**
 * Trailing 32px slot: the state's glyph. The glyphs stay mounted and cross-fade
 * with opacity/scale/blur, so an attachment settling from uploading to ready or
 * failed reads as one object changing rather than a swap. CSS rather than
 * framer-motion: no other component under chat/ or ai-gui/ pulls that dependency
 * into the conversation's module graph.
 */
function AttachmentStateIcon({ state }: { state: PendingAttachmentState }) {
  const glyph = (active: boolean) =>
    cn(
      'absolute transition-[opacity,scale,filter] duration-300 ease-[cubic-bezier(0.2,0,0,1)]',
      active ? 'scale-100 opacity-100 blur-none' : 'scale-25 opacity-0 blur-[4px]'
    );
  return (
    <span className="relative flex size-8 shrink-0 items-center justify-center">
      <AlertCircle
        className={cn(glyph(state === 'failed'), 'size-4 text-destructive')}
        aria-hidden="true"
      />
      <Spinner
        className={cn(glyph(state === 'uploading'), 'size-4 text-muted-foreground')}
        spinning={state === 'uploading'}
      />
      <Clock3
        className={cn(glyph(state === 'interrupted'), 'size-4 text-muted-foreground')}
        aria-hidden="true"
      />
      <Check
        className={cn(glyph(state === 'ready'), 'size-4 text-muted-foreground')}
        aria-hidden="true"
      />
    </span>
  );
}

/**
 * A flush strip on the card's bottom edge, ALWAYS in the flow and always the
 * same height — empty when the attachment is not transferring. Reserving the row
 * is what keeps one card height across uploading / ready / failed.
 *
 * It is deliberately not absolutely positioned inside the card's padding: at
 * `bottom-2` the bar overlapped the 40px content row by 2px and left an
 * unrelated 8px gap beneath it, so the spacing above and below never matched
 * anything else in the card. Flush and full-width has no such arbitrary offsets,
 * and the card's own `overflow-hidden` rounds its ends.
 */
function AttachmentProgressTrack({
  attachment,
  active,
}: {
  attachment: SessionAttachmentDraft;
  active: boolean;
}) {
  const { t } = useTranslation();
  return (
    /* The attribute, not the height class, is the contract: `Progress` merges to
       the same h-1/w-full and would be indistinguishable by styling alone. */
    <div className="h-1 w-full" data-attachment-progress="">
      {active ? (
        <Progress
          value={attachment.progress ?? 0}
          aria-label={t('sessions.attachmentUploading', { progress: attachment.progress ?? 0 })}
          className="h-1 rounded-none"
        />
      ) : null}
    </div>
  );
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
}: {
  attachment: SessionAttachmentDraft;
  active: boolean;
  single: boolean;
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

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-xl border transition-colors',
        failed ? FAILED_FRAME_CLASS : 'border-border/70 bg-muted/20',
        single ? 'inline-flex max-w-full flex-col' : `${IMAGE_SQUARE_CLASS} shrink-0`
      )}
      title={`${attachment.name} · ${label}`}
    >
      {previewUrl ? (
        <img
          src={previewUrl}
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
      <div className="absolute inset-x-0 bottom-0">
        <AttachmentProgressTrack attachment={attachment} active={state === 'uploading'} />
      </div>
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

  return (
    <div
      className={cn(
        'w-full max-w-sm overflow-hidden rounded-xl border transition-colors',
        failed ? FAILED_FRAME_CLASS : 'border-border/60 bg-card/80'
      )}
    >
      <div className="flex min-w-0 items-center gap-3 px-3 py-2.5">
        {/* The tile keeps the file's identity in every state — tinting it red
            too only doubled the alarm without adding information. */}
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="size-5" aria-hidden="true" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm leading-tight font-medium" title={attachment.name}>
            {attachment.name}
          </span>
          <span
            className={cn(
              'truncate text-xs leading-tight tabular-nums',
              failed ? 'text-destructive' : 'text-muted-foreground'
            )}
            title={failed ? label : undefined}
          >
            {label}
          </span>
        </span>
        <AttachmentStateIcon state={state} />
      </div>
      <AttachmentProgressTrack attachment={attachment} active={state === 'uploading'} />
    </div>
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
          <div className="flex flex-row-reverse items-center gap-1.5 text-[11px] text-muted-foreground">
            {timestampLabel ? <span className="tabular-nums">{timestampLabel}</span> : null}
            {/* Where the delivered row shows its read mark. Neutral on purpose:
                the icon and the word already say "not sent", and the failure
                itself is framed below. */}
            <span
              className="inline-flex items-center gap-1 text-muted-foreground"
              role="status"
              title={messageStatus}
            >
              {failed ? (
                <AlertCircle className="size-3.5" strokeWidth={2} aria-hidden="true" />
              ) : (
                <Clock3 className="size-3.5" strokeWidth={2} aria-hidden="true" />
              )}
              {isMobile ? <span className="sr-only">{messageStatus}</span> : messageStatus}
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
                  />
                ))}
              </div>
            ) : null}
            {files.length ? (
              <div className="flex w-full flex-col items-end gap-2">
                {files.map((attachment) => (
                  <PendingFileAttachment
                    key={attachment.id}
                    attachment={attachment}
                    active={!failed}
                  />
                ))}
              </div>
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
