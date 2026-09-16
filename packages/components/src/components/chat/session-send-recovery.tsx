import { getIpcServices, onIpcEvent } from '@/lib/electron-ipc-client';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useBlocker } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import type { WorkspaceRuntime } from '@/atoms/runtime';
import type { SessionSendRecord } from '@/lib/session-send-journal';
import {
  registerSessionSendExitGuard,
  requestSessionSendExit,
  type SessionSendExitReason,
} from '@/lib/session-send-exit';
import { hasPendingSessionSends } from '@/lib/session-send-journal-storage';
import { Button } from '@/ui/button';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/ui/alert-dialog';

const EMPTY: readonly SessionSendRecord[] = [];
const emptySnapshot = () => EMPTY;
const emptySubscribe = () => () => {};

type ExitRequest = { reason: SessionSendExitReason; resolve: (allow: boolean) => void };

/** Small independent projection; transfer progress never subscribes the conversation tree. */
export function SessionSendRecovery({ runtime }: { runtime: WorkspaceRuntime | null }) {
  const { t } = useTranslation();
  const journal = runtime?.sendJournal;
  const records = useSyncExternalStore(
    journal?.subscribe ?? emptySubscribe,
    journal?.getSnapshot ?? emptySnapshot,
    emptySnapshot
  );
  const pending = records.filter((record) => record.stage !== 'delivered');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [exitRequest, setExitRequest] = useState<ExitRequest | null>(null);
  const exitRef = useRef<ExitRequest | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const finishExit = useCallback((allow: boolean) => {
    exitRef.current?.resolve(allow);
    exitRef.current = null;
    setExitRequest(null);
  }, []);

  useEffect(() => {
    setError(null);
    if (!journal) return undefined;
    let active = true;
    void journal.refresh().catch((failure: unknown) => {
      if (active)
        setError(
          failure instanceof Error ? failure.message : t('sessions.sendRecoveryUnavailable')
        );
    });
    return () => {
      active = false;
    };
  }, [journal, t]);

  useEffect(
    () =>
      registerSessionSendExitGuard(async (reason) => {
        const active =
          journal?.getSnapshot().filter((record) => record.stage !== 'delivered') ?? [];
        let protectedRecords =
          active.length > 0 || (runtime?.sendResources.getActiveCount() ?? 0) > 0;
        if ((reason === 'logout' || reason === 'cache-clear') && typeof indexedDB !== 'undefined') {
          // Unknown versions or unreadable recovery data cannot authorize destructive exit.
          try {
            protectedRecords ||= await hasPendingSessionSends(
              indexedDB,
              reason === 'logout' ? (runtime?.accountId ?? undefined) : undefined
            );
          } catch {
            protectedRecords = true;
          }
        }
        if (!protectedRecords && !error) return true;
        if (exitRef.current) return false;
        return new Promise<boolean>((resolve) => {
          const request = { reason, resolve };
          exitRef.current = request;
          setExitRequest(request);
        });
      }),
    [error, journal, runtime]
  );

  useEffect(
    () => () => {
      exitRef.current?.resolve(false);
    },
    []
  );

  useBlocker({
    shouldBlockFn: async ({ current, next }) => {
      const currentWorkspace = (current.params as { workspaceName?: string }).workspaceName;
      const nextWorkspace = (next.params as { workspaceName?: string }).workspaceName;
      if (currentWorkspace === nextWorkspace) return false;
      return !(await requestSessionSendExit('workspace'));
    },
    enableBeforeUnload: () =>
      !!error ||
      (runtime?.sendResources.getActiveCount() ?? 0) > 0 ||
      !!journal?.getSnapshot().some((record) => record.stage !== 'delivered'),
  });

  useEffect(() => {
    const ipc = getIpcServices();
    if (!ipc) return undefined;
    const unsubscribe = onIpcEvent('app.sendLifecycle', (request) => {
      void (async () => {
        try {
          if (request.phase === 'commit') await runtime?.dispose();
          await ipc.app.replySendLifecycle({
            requestId: request.requestId,
            ready: true,
            pending:
              (runtime?.sendResources.getActiveCount() ?? 0) > 0 ||
              !!journal?.getSnapshot().some((record) => record.stage !== 'delivered'),
          });
        } catch (failure) {
          setError(
            failure instanceof Error ? failure.message : t('sessions.sendRecoveryUnavailable')
          );
          await ipc.app.replySendLifecycle({
            requestId: request.requestId,
            ready: false,
            pending: true,
          });
        }
      })().catch((failure: unknown) =>
        console.error('Could not report pending message lifecycle', failure)
      );
    });
    void ipc.app
      .registerSendLifecycle()
      .catch((failure: unknown) =>
        console.error('Could not register pending message lifecycle', failure)
      );
    return unsubscribe;
  }, [journal, runtime, t]);

  const retry = async (record: SessionSendRecord) => {
    if (!journal) return;
    setBusy(record.id);
    try {
      await journal.retry(record.sessionId);
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('sessions.sendRecoveryUnavailable'));
    } finally {
      setBusy(null);
    }
  };
  const cancel = async (record: SessionSendRecord) => {
    if (!journal) return;
    setBusy(record.id);
    try {
      await journal.cancel(record.id);
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('sessions.sendRecoveryUnavailable'));
    } finally {
      setBusy(null);
    }
  };
  const discard = async (record: SessionSendRecord) => {
    if (!journal) return;
    setBusy(record.id);
    try {
      await journal.discard(record.id);
      void journal
        .retry(record.sessionId)
        .catch((failure: unknown) => console.warn('Following message remains pending', failure));
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('sessions.sendRecoveryUnavailable'));
    } finally {
      setBusy(null);
    }
  };
  const destructiveExit = exitRequest?.reason === 'logout' || exitRequest?.reason === 'cache-clear';

  return (
    <>
      {pending.length > 0 || error ? (
        <details className="fixed right-4 bottom-4 z-40 w-80 max-w-[calc(100vw-2rem)] rounded-lg border bg-background p-3 text-sm shadow-lg">
          <summary className="cursor-pointer font-medium">
            <span role="status">{t('sessions.pendingSends', { count: pending.length })}</span>
          </summary>
          {error ? (
            <p className="mt-2 text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <ol className="mt-3 max-h-72 space-y-3 overflow-y-auto">
            {pending.map((record) => (
              <li key={record.id} className="space-y-2 border-t pt-2">
                <p className="line-clamp-2 break-words">
                  {record.entry.items
                    ?.flatMap((item) =>
                      item.type === 'text' && 'text' in item && typeof item.text === 'string'
                        ? [item.text]
                        : []
                    )
                    .join('\n') || t('sessions.attachmentMessage')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t(
                    record.stage === 'committed'
                      ? 'sessions.sendWaitingForSync'
                      : record.stage === 'prepared'
                        ? 'sessions.sendConfirmingResult'
                        : 'sessions.sendSavedLocally'
                  )}
                </p>
                {record.error ? <p className="text-xs text-destructive">{record.error}</p> : null}
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => {
                      void retry(record);
                    }}
                  >
                    {t('sessions.retryPendingSend')}
                  </Button>
                  {record.stage === 'saved' ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => {
                        void cancel(record);
                      }}
                    >
                      {t('sessions.cancelPendingSend')}
                    </Button>
                  ) : null}
                  {record.stage === 'prepared' || record.stage === 'committed' ? (
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={busy !== null}
                      onClick={() => {
                        void discard(record);
                      }}
                    >
                      {t('sessions.discardPendingSend')}
                    </Button>
                  ) : null}
                </div>
                {record.stage === 'prepared' || record.stage === 'committed' ? (
                  <p className="text-xs text-muted-foreground">
                    {t(
                      record.stage === 'committed'
                        ? 'sessions.discardPendingSendDescription'
                        : 'sessions.discardPreparedSendDescription'
                    )}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
      <AlertDialog
        open={exitRequest !== null}
        onOpenChange={(open) => {
          if (!open) finishExit(false);
        }}
      >
        <AlertDialogContent
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancelRef.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{t('sessions.pendingSendExitTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                destructiveExit
                  ? 'sessions.pendingSendDestructiveExit'
                  : 'sessions.pendingSendRetainedExit'
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel ref={cancelRef} onClick={() => finishExit(false)}>
              {t('sessions.stayWithPendingSends')}
            </AlertDialogCancel>
            {destructiveExit ? (
              <Button variant="destructive" onClick={() => finishExit(true)}>
                {t('sessions.discardPendingSendsAndContinue')}
              </Button>
            ) : (
              <Button onClick={() => finishExit(true)}>
                {t('sessions.leaveWithPendingSends')}
              </Button>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
