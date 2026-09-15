import { useEffect, useState, useSyncExternalStore } from 'react';
import { useAtomValue } from 'jotai';
import { AlertCircle, Check, Clock3, Image as ImageIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { SessionId } from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { getSessionFileIcon } from '@/components/ai-gui/session-file-card';
import { ConversationColumn } from '@/components/shared/conversation-column';
import type { SessionAttachmentDraft } from '@/lib/session-attachment-draft';
import type { SessionSendRecord } from '@/lib/session-send-journal';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { Progress } from '@/ui/progress';
import { Spinner } from '@/ui/spinner';

const empty: readonly SessionSendRecord[] = [];
const emptySnapshot = () => empty;
const emptySubscribe = () => () => {};

/**
 * One attachment is in exactly one of three states, and all three share a card
 * skeleton (icon slot / name + one status line / trailing status slot) so the
 * row does not resize as attachments move between them. `ready` wins over
 * `error`: preparation clears the error when it later succeeds, and a retry
 * skips attachments that already finished.
 */
type PendingAttachmentState = 'uploading' | 'ready' | 'failed';

const attachmentState = (attachment: SessionAttachmentDraft): PendingAttachmentState =>
  attachment.ready ? 'ready' : attachment.error ? 'failed' : 'uploading';

/** The one status line inside a card. The failed card owns the whole reason. */
function useAttachmentStatus(attachment: SessionAttachmentDraft) {
  const { t } = useTranslation();
  const state = attachmentState(attachment);
  const label =
    state === 'ready'
      ? t('sessions.attachmentPrepared')
      : state === 'failed'
        ? (attachment.error ?? '')
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
 * Trailing 32px slot: the state's glyph. All three stay mounted and cross-fade
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

function PendingImageAttachment({ attachment }: { attachment: SessionAttachmentDraft }) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(attachment.source);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [attachment.source]);

  const { state, label } = useAttachmentStatus(attachment);
  const failed = state === 'failed';

  return (
    <div
      className={cn(
        'w-36 overflow-hidden rounded-xl border transition-colors',
        failed ? FAILED_FRAME_CLASS : 'border-border/60 bg-card/80'
      )}
    >
      <div className="relative aspect-square bg-muted">
        {previewUrl ? (
          <img
            src={previewUrl}
            alt=""
            /* Pure black/white at 10%: a tinted neutral picks up the surface
               under it and reads as dirt on the image edge. */
            className="size-full object-cover outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
          />
        ) : (
          <div className="flex size-full items-center justify-center text-muted-foreground">
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
      </div>
      {/* Between the thumbnail and the caption rather than floating over the
          photo, so it lines up with the file card's strip. */}
      <AttachmentProgressTrack attachment={attachment} active={state === 'uploading'} />
      <div className="space-y-0.5 px-2.5 py-2">
        <p className="truncate text-xs font-medium" title={attachment.name}>
          {attachment.name}
        </p>
        <p
          className={cn(
            'truncate text-[11px]',
            failed ? 'text-destructive' : 'text-muted-foreground'
          )}
          title={failed ? label : undefined}
        >
          {label}
        </p>
      </div>
    </div>
  );
}

function PendingFileAttachment({ attachment }: { attachment: SessionAttachmentDraft }) {
  const { state, label } = useAttachmentStatus(attachment);
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
 */
export function PendingMessageRow({
  record,
  onRetry,
  onCancel,
}: {
  record: SessionSendRecord;
  onRetry: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const text = record.entry.items
    ?.flatMap((item) => (item.type === 'text' ? [item.text] : []))
    .join('\n');
  const failed = Boolean(record.error);
  const images = record.attachments?.filter((attachment) => attachment.kind === 'image') ?? [];
  const files = record.attachments?.filter((attachment) => attachment.kind === 'file') ?? [];
  // Only fall back to the record-level reason when no card shows one, so the
  // same failure is never spelled out twice.
  const reasonOnACard = record.attachments?.some(
    (attachment) => attachmentState(attachment) === 'failed'
  );
  const messageStatus = failed
    ? t('sessions.pendingMessageUploadFailed')
    : record.stage === 'prepared'
      ? t('sessions.pendingMessageWaiting')
      : t('sessions.pendingMessageUploading');
  const showRetry = failed;
  const showCancel = record.stage === 'saved';

  return (
    <ConversationColumn className="pb-3 sm:pb-4">
      <article className="ml-auto flex w-full max-w-[80%] flex-col items-end gap-1.5 sm:max-w-[70%]">
        {/* Neutral on purpose: the icon and the word already say "not sent", and
            the failure itself is framed below. Colouring this line too turned
            one fault into three red things stacked down the row. */}
        <div
          className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"
          role="status"
        >
          {failed ? (
            <AlertCircle className="size-3.5" strokeWidth={2} aria-hidden="true" />
          ) : (
            <Clock3 className="size-3.5" strokeWidth={2} aria-hidden="true" />
          )}
          <span>{messageStatus}</span>
        </div>
        {images.length ? (
          <div className="flex w-full flex-wrap justify-end gap-2">
            {images.map((attachment) => (
              <PendingImageAttachment key={attachment.id} attachment={attachment} />
            ))}
          </div>
        ) : null}
        {files.length ? (
          <div className="flex w-full flex-col items-end gap-2">
            {files.map((attachment) => (
              <PendingFileAttachment key={attachment.id} attachment={attachment} />
            ))}
          </div>
        ) : null}
        {text ? (
          <div className="max-w-full rounded-2xl border border-foreground/[0.08] bg-foreground/[0.05] px-4 py-2.5 text-sm break-words whitespace-pre-wrap">
            {text}
          </div>
        ) : null}
        {failed && !reasonOnACard ? <PendingFailureNotice reason={record.error!} clamp /> : null}
        {showRetry || showCancel ? (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {showCancel ? (
              <Button size="sm" variant="ghost" onClick={onCancel}>
                {t('sessions.cancelPendingSend')}
              </Button>
            ) : null}
            {showRetry ? (
              <Button size="sm" onClick={onRetry}>
                {t('sessions.retryPendingSend')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </article>
    </ConversationColumn>
  );
}

/** Local pending rows render beside ordinary conversation messages, never in the composer. */
export function SessionPendingMessages({ sessionId }: { sessionId: SessionId }) {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const journal = runtime?.sendJournal;
  const records = useSyncExternalStore(
    journal?.subscribe ?? emptySubscribe,
    journal?.getSnapshot ?? emptySnapshot,
    emptySnapshot
  );
  const { t } = useTranslation();
  const [failure, setFailure] = useState<string | null>(null);
  const pending = records.filter(
    (record) =>
      record.sessionId === sessionId && (record.stage === 'saved' || record.stage === 'prepared')
  );
  if (!pending.length) return null;
  const action = async (record: SessionSendRecord, cancel: boolean) => {
    try {
      if (cancel) await journal?.cancel(record.id);
      await journal?.retry(sessionId);
      setFailure(null);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : t('sessions.sendRecoveryUnavailable'));
    }
  };
  return (
    <section aria-label={t('sessions.pendingSends', { count: pending.length })}>
      {pending.map((record) => (
        <PendingMessageRow
          key={record.id}
          record={record}
          onRetry={() => void action(record, false)}
          onCancel={() => void action(record, true)}
        />
      ))}
      {/* The retry/cancel ACTION itself failed — a different fault from the
          record's own error, so it gets its own notice in the same frame. */}
      {failure ? (
        <ConversationColumn className="pb-3">
          <PendingFailureNotice reason={failure} role="alert" />
        </ConversationColumn>
      ) : null}
    </section>
  );
}
