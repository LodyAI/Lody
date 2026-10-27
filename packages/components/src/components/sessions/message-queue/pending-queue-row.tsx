import * as stylex from '@stylexjs/stylex';
import { useEffect, useState } from 'react';
import { CircleAlert, File as FileIcon, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SessionSendProgressRing } from '@/components/sidebar-row-shared';
import type { SessionAttachmentDraft } from '@/lib/session-attachment-draft';
import type { PendingSessionSend } from '@/lib/session-pending-sends';
import { deriveSessionSendProgress } from '@/lib/session-send-status';
import { queueSurface } from './surface';
import { IconAction, TextAction, queueRowStyles } from './message-queue-row';
import { themeColors } from '../../../style/theme-colors.stylex';
import { themeFontSize, themeSpace } from '../../../style/theme-scale.stylex';

const MAX_INLINE_ATTACHMENTS = 3;

const styles = stylex.create({
  thumbnail: {
    display: 'flex',
    width: '18px',
    height: '18px',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    borderRadius: '0.25rem',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'hsl(var(--border) / 0.4)',
    backgroundColor: 'hsl(var(--background) / 0.6)',
  },
  thumbnailImage: { width: '100%', height: '100%', objectFit: 'cover' },
  thumbnailIcon: {
    width: themeSpace[2.5],
    height: themeSpace[2.5],
    color: themeColors.mutedForeground,
  },
  divider: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: 'hsl(var(--border) / 0.3)',
  },
  text: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    overflow: 'hidden',
    fontSize: themeFontSize.xs,
    lineHeight: '1.375',
  },
  textInstant: { color: 'hsl(var(--foreground) / 0.8)' },
  textUploading: { color: 'hsl(var(--foreground) / 0.55)' },
  actions: { display: 'flex', flexShrink: 0, alignItems: 'center' },
  alertIcon: {
    width: themeSpace[3],
    height: themeSpace[3],
    color: themeColors.destructive,
  },
  status: {
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[1],
    fontSize: '11px',
    color: themeColors.mutedForeground,
    fontVariantNumeric: 'tabular-nums',
  },
});

function LocalThumbnail({ attachment }: { attachment: SessionAttachmentDraft }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (attachment.kind !== 'image' || !attachment.source) return undefined;
    const next = URL.createObjectURL(attachment.source);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [attachment.kind, attachment.source]);
  return (
    <span {...stylex.props(styles.thumbnail)} title={attachment.name}>
      {url ? (
        <img src={url} alt={attachment.name} {...stylex.props(styles.thumbnailImage)} />
      ) : (
        <FileIcon {...stylex.props(styles.thumbnailIcon)} aria-hidden="true" />
      )}
    </span>
  );
}

function queuedText(record: PendingSessionSend): string {
  const task = (record.queue as { task?: unknown } | undefined)?.task;
  if (typeof task === 'string' && task.trim()) return task;
  return (
    record.entry.items?.flatMap((item) => (item.type === 'text' ? [item.text] : [])).join('\n') ??
    ''
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

  const rowProps = stylex.props(queueSurface.row, queueRowStyles.row, divided && styles.divider);

  return (
    <div {...rowProps} data-pending-queue-row={record.id} data-pending-queue-state={status.state}>
      <div
        aria-hidden="true"
        {...stylex.props(
          queueRowStyles.leadingBox,
          queueRowStyles.leadingIndex,
          queueRowStyles.leadingIndexMuted
        )}
      >
        {index + 1}
      </div>
      <div {...stylex.props(queueRowStyles.rowBody)}>
        {inline.length > 0 ? (
          <div {...stylex.props(queueRowStyles.rowImages)}>
            {inline.map((attachment) => (
              <LocalThumbnail key={attachment.id} attachment={attachment} />
            ))}
            {overflow > 0 ? (
              <span {...stylex.props(queueRowStyles.rowOverflow)}>+{overflow}</span>
            ) : null}
          </div>
        ) : null}
        {/* Muted until it is a real queue item, like an unsent conversation's title. */}
        <div
          {...stylex.props(
            queueSurface.text,
            styles.text,
            instant ? styles.textInstant : styles.textUploading
          )}
          style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}
        >
          {queuedText(record)}
        </div>
      </div>
      <div {...stylex.props(queueSurface.actions, queueSurface.pendingActions, styles.actions)}>
        {failed ? (
          <>
            <CircleAlert
              {...stylex.props(styles.alertIcon)}
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
          <span role="status" {...stylex.props(styles.status)}>
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
