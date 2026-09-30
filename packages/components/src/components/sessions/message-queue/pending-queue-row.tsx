import { useEffect, useState } from 'react';
import { CircleAlert, File as FileIcon, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SessionSendProgressRing } from '@/components/sidebar-row-shared';
import type { SessionAttachmentDraft } from '@/lib/session-attachment-draft';
import type { PendingSessionSend } from '@/lib/session-pending-sends';
import { deriveSessionSendProgress } from '@/lib/session-send-status';
import { cn } from '@/lib/utils';
import { IconAction, TextAction } from './message-queue-row';

const MAX_INLINE_ATTACHMENTS = 3;

/** Same first-line box as a queued row's index and actions. */
const FIRST_LINE_BOX_CLASS = 'flex h-[calc(0.75rem*1.375)] shrink-0 items-center';

function LocalThumbnail({ attachment }: { attachment: SessionAttachmentDraft }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (attachment.kind !== 'image' || !attachment.source) return undefined;
    const next = URL.createObjectURL(attachment.source);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [attachment.kind, attachment.source]);
  return (
    <span
      className="flex size-[18px] shrink-0 items-center justify-center overflow-hidden rounded border border-border/40 bg-background/60"
      title={attachment.name}
    >
      {url ? (
        <img src={url} alt={attachment.name} className="h-full w-full object-cover" />
      ) : (
        <FileIcon className="size-2.5 text-muted-foreground" aria-hidden="true" />
      )}
    </span>
  );
}

function queuedText(record: PendingSessionSend): string {
  const task = (record.queue as { task?: unknown } | undefined)?.task;
  if (typeof task === 'string' && task.trim()) return task;
  return (
    record.entry.items
      ?.flatMap((item) => (item.type === 'text' ? [item.text] : []))
      .join('\n') ?? ''
  );
}

/**
 * A message routed to the queue while its attachments are still uploading (or
 * behind one that is). It exists only in renderer memory: it is not a queue
 * item yet, so it cannot be dragged, edited or used to steer. It takes the position the real
 * item will be appended to, and gives way to it in the same render when that
 * item syncs in.
 */
export function PendingQueueRow({
  record,
  index,
  divided,
  busy,
  onRetry,
  onCancel,
}: {
  record: PendingSessionSend;
  index: number;
  /** Draw the divider above: a row, local or real, precedes this one. */
  divided: boolean;
  busy: boolean;
  onRetry: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const status = deriveSessionSendProgress(record);
  const failed = status.state === 'failed';
  // Nothing to upload: it reads as queued, not as sending.
  const attachments = record.attachments;
  const instant = !failed && attachments.length === 0;
  const inline = attachments.slice(0, MAX_INLINE_ATTACHMENTS);
  const overflow = attachments.length - inline.length;
  const statusLabel =
    status.totalBytes > 0
      ? t('sessions.attachmentUploading', { progress: status.progress })
      : t('sessions.sendStatus.sendingWithoutSize');

  return (
    <div
      className={cn(
        'relative flex items-start gap-2 px-2 py-1.5',
        divided && 'border-t border-border/30'
      )}
      data-pending-queue-row={record.id}
      data-pending-queue-state={status.state}
    >
      <div
        aria-hidden="true"
        className={cn(
          FIRST_LINE_BOX_CLASS,
          'w-4 justify-center text-[10px] font-medium tabular-nums text-muted-foreground/60'
        )}
      >
        {index + 1}
      </div>
      <div className="flex min-w-0 flex-1 items-start gap-1.5">
        {inline.length > 0 ? (
          <div className="flex shrink-0 items-center gap-0.5 pt-px">
            {inline.map((attachment) => (
              <LocalThumbnail key={attachment.id} attachment={attachment} />
            ))}
            {overflow > 0 ? (
              <span className="ml-0.5 text-[10px] text-muted-foreground/70 tabular-nums">
                +{overflow}
              </span>
            ) : null}
          </div>
        ) : null}
        {/* Muted until it is a real queue item, like an unsent conversation's title. */}
        <div
          className={cn(
            'min-w-0 flex-1 overflow-hidden text-xs leading-snug',
            instant ? 'text-foreground/80' : 'text-foreground/55'
          )}
          style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}
        >
          {queuedText(record)}
        </div>
      </div>
      <div className={cn(FIRST_LINE_BOX_CLASS, 'gap-1')}>
        {failed ? (
          <>
            <CircleAlert
              className="size-3 text-destructive"
              strokeWidth={2.25}
              aria-label={t('sessions.pendingMessageUploadFailed')}
            />
            <TextAction
              text={t('sessions.retryPendingSend')}
              ariaLabel={t('sessions.retryPendingSend')}
              onClick={() => {
                if (!busy) onRetry();
              }}
            />
          </>
        ) : instant ? null : (
          <span
            role="status"
            className="flex items-center gap-1 text-[11px] text-muted-foreground tabular-nums"
          >
            <SessionSendProgressRing
              progress={status.totalBytes > 0 ? status.progress : undefined}
            />
            {statusLabel}
          </span>
        )}
        <IconAction
          icon={X}
          label={t('sessions.cancelPendingSend')}
          destructive
          disabled={busy}
          onClick={onCancel}
        />
      </div>
    </div>
  );
}
