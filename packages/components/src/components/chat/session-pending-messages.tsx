import { useEffect, useState, useSyncExternalStore } from 'react';
import { useAtomValue } from 'jotai';
import { AlertCircle, Clock3, File, Image as ImageIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { SessionId } from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { ConversationColumn } from '@/components/shared/conversation-column';
import type { SessionAttachmentDraft } from '@/lib/session-attachment-draft';
import type { SessionSendRecord } from '@/lib/session-send-journal';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { Progress } from '@/ui/progress';

const empty: readonly SessionSendRecord[] = [];
const emptySnapshot = () => empty;
const emptySubscribe = () => () => {};

function PendingImageAttachment({ attachment }: { attachment: SessionAttachmentDraft }) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(attachment.source);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [attachment.source]);

  const { t } = useTranslation();
  const status = attachment.ready
    ? t('sessions.attachmentPrepared')
    : attachment.error
      ? attachment.error
      : t('sessions.attachmentUploading', { progress: attachment.progress ?? 0 });

  return (
    <div className="w-36 overflow-hidden rounded-xl border border-border/60 bg-card/80">
      <div className="relative aspect-square bg-muted">
        {previewUrl ? (
          <img src={previewUrl} alt="" className="size-full object-cover" />
        ) : (
          <div className="flex size-full items-center justify-center text-muted-foreground">
            <ImageIcon className="size-6" aria-hidden="true" />
          </div>
        )}
        {!attachment.ready && !attachment.error ? (
          <Progress
            value={attachment.progress ?? 0}
            aria-label={t('sessions.attachmentUploading', { progress: attachment.progress ?? 0 })}
            className="absolute right-2 bottom-2 left-2 h-1.5 bg-background/70 [&>div]:bg-primary"
          />
        ) : null}
      </div>
      <div className="space-y-0.5 px-2.5 py-2">
        <p className="truncate text-xs font-medium">{attachment.name}</p>
        <p className={cn('truncate text-[11px] text-muted-foreground', attachment.error && 'text-destructive')}>
          {status}
        </p>
      </div>
    </div>
  );
}

function PendingFileAttachment({ attachment }: { attachment: SessionAttachmentDraft }) {
  const { t } = useTranslation();
  const status = attachment.ready
    ? t('sessions.attachmentPrepared')
    : attachment.error
      ? attachment.error
      : t('sessions.attachmentUploading', { progress: attachment.progress ?? 0 });

  return (
    <div className="w-full max-w-sm rounded-xl border border-border/60 bg-card/80 px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <File className="size-5" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{attachment.name}</span>
          <span
            className={cn(
              'block truncate text-xs text-muted-foreground tabular-nums',
              attachment.error && 'text-destructive'
            )}
          >
            {status}
          </span>
        </span>
      </div>
      {!attachment.ready && !attachment.error ? (
        <Progress
          value={attachment.progress ?? 0}
          aria-label={t('sessions.attachmentUploading', { progress: attachment.progress ?? 0 })}
          className="mt-2 h-1.5"
        />
      ) : null}
    </div>
  );
}

function PendingMessageRow({
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
  const messageStatus = record.error
    ? t('sessions.pendingMessageUploadFailed')
    : record.stage === 'prepared'
      ? t('sessions.pendingMessageWaiting')
      : t('sessions.pendingMessageUploading');

  return (
    <ConversationColumn className="px-3 pb-3 sm:pb-4">
      <article className="ml-auto flex w-full max-w-[80%] flex-col items-end gap-1.5 sm:max-w-[70%]">
        <div
          className={cn(
            'inline-flex items-center gap-1.5 text-[11px] text-muted-foreground',
            record.error && 'text-destructive'
          )}
          role="status"
        >
          {record.error ? (
            <AlertCircle className="size-3.5" aria-hidden="true" />
          ) : (
            <Clock3 className="size-3.5" aria-hidden="true" />
          )}
          <span>{messageStatus}</span>
        </div>
        {record.attachments?.some((attachment) => attachment.kind === 'image') ? (
          <div className="flex w-full flex-wrap justify-end gap-2">
            {record.attachments
              .filter((attachment) => attachment.kind === 'image')
              .map((attachment) => (
                <PendingImageAttachment key={attachment.id} attachment={attachment} />
              ))}
          </div>
        ) : null}
        {record.attachments?.some((attachment) => attachment.kind === 'file') ? (
          <div className="flex w-full flex-col items-end gap-2">
            {record.attachments
              .filter((attachment) => attachment.kind === 'file')
              .map((attachment) => (
                <PendingFileAttachment key={attachment.id} attachment={attachment} />
              ))}
          </div>
        ) : null}
        {text ? (
          <div className="max-w-full rounded-2xl border border-foreground/[0.08] bg-foreground/[0.05] px-4 py-2.5 text-sm whitespace-pre-wrap break-words">
            {text}
          </div>
        ) : null}
        {record.error ? <p className="text-xs text-destructive">{record.error}</p> : null}
        <div className="flex gap-1">
          {record.error ? (
            <Button size="sm" variant="outline" onClick={onRetry}>
              {t('sessions.retryPendingSend')}
            </Button>
          ) : null}
          {record.stage === 'saved' ? (
            <Button size="sm" variant="ghost" onClick={onCancel}>
              {t('sessions.cancelPendingSend')}
            </Button>
          ) : null}
        </div>
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
      {failure ? (
        <ConversationColumn className="px-3 pb-3 text-xs text-destructive" role="alert">
          {failure}
        </ConversationColumn>
      ) : null}
    </section>
  );
}
