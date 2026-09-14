import { useSyncExternalStore, useState } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import type { SessionId } from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import type { SessionSendRecord } from '@/lib/session-send-journal';
import { Button } from '@/ui/button';

const empty: readonly SessionSendRecord[] = [];
const emptySnapshot = () => empty;
const emptySubscribe = () => () => {};

/** Independent pending rows; progress does not rerender the conversation history. */
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
    <section
      className="max-h-64 space-y-2 overflow-y-auto px-3 py-2"
      aria-label={t('sessions.pendingSends', { count: pending.length })}
    >
      {pending.map((record) => (
        <div key={record.id} className="rounded-lg border bg-muted/30 p-3 text-sm">
          <p className="font-medium">
            {t(
              record.stage === 'prepared'
                ? 'sessions.sendConfirmingResult'
                : 'sessions.attachmentPreparingNotSent'
            )}
          </p>
          <p className="line-clamp-3 whitespace-pre-wrap break-words">
            {record.entry.items
              ?.flatMap((item) => (item.type === 'text' ? [item.text] : []))
              .join('\n')}
          </p>
          {record.attachments?.map((attachment) => (
            <div key={attachment.id} className="mt-2 text-xs">
              <p className="truncate">
                {attachment.name} ·{' '}
                {attachment.ready
                  ? t('sessions.attachmentPrepared')
                  : (attachment.error ?? `${attachment.progress ?? 0}%`)}
              </p>
              {!attachment.ready ? (
                <progress
                  className="mt-1 h-1 w-full"
                  aria-label={attachment.name}
                  max={100}
                  value={attachment.progress ?? 0}
                />
              ) : null}
            </div>
          ))}
          {record.error ? <p className="mt-2 text-xs text-destructive">{record.error}</p> : null}
          <div className="mt-2 flex gap-2">
            {record.error ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void action(record, false);
                }}
              >
                {t('sessions.retryPendingSend')}
              </Button>
            ) : null}
            {record.stage === 'saved' ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  void action(record, true);
                }}
              >
                {t('sessions.cancelPendingSend')}
              </Button>
            ) : null}
          </div>
        </div>
      ))}
      {failure ? (
        <p role="alert" className="text-xs text-destructive">
          {failure}
        </p>
      ) : null}
    </section>
  );
}
