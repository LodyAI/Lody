import { useSetAtom } from 'jotai';
import { getSessionRoomId, type WorkspaceId } from '@lody/shared';
import { pendingSendSessionMetasAtom } from '@/atoms/doc-meta';
import {
  acceptedSessionHistoryProjectionsAtom,
  addAcceptedSessionHistoryProjection,
  type AcceptedSessionHistoryProjection,
} from '@/atoms/session-history-projection';
import { sessionSendStatusesAtom } from '@/atoms/session-send-status';
import { hasUnsavedRendererChanges } from '@/lib/renderer-unload-guards';
import { getIpcServices, onIpcEvent } from '@/lib/electron-ipc-client';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useBlocker } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import type { WorkspaceRuntime } from '@/atoms/runtime';
import type { SessionSendViewRecord } from '@/lib/session-send-journal';
import {
  registerSessionSendExitGuard,
  requestSessionSendExit,
  type SessionSendExitReason,
} from '@/lib/session-send-exit';
import { hasPendingSessionSends } from '@/lib/session-send-journal-storage';
import { deriveSessionSendStatuses, selectInstantHistoryRecords } from '@/lib/session-send-status';
import { toast } from '@/lib/toast';
import { Button } from '@lody/ui/button';
import { AlertDialog } from '@lody/ui/alert-dialog';

const EMPTY: readonly SessionSendViewRecord[] = [];
const emptySnapshot = () => EMPTY;
const emptySubscribe = () => () => {};

type ExitRequest = { reason: SessionSendExitReason; resolve: (allow: boolean) => void };

/**
 * Owns the workspace side of pending sends: local placeholder metadata, the
 * sidebar send status, and exit protection. It draws no surface of its own —
 * progress and recovery actions live on the conversation's pending rows.
 */
export function SessionSendRecovery({ runtime }: { runtime: WorkspaceRuntime | null }) {
  const { t } = useTranslation();
  const journal = runtime?.sendJournal;
  const records = useSyncExternalStore(
    journal?.subscribe ?? emptySubscribe,
    journal?.getSnapshot ?? emptySnapshot,
    emptySnapshot
  );
  const setPendingMetas = useSetAtom(pendingSendSessionMetasAtom);
  const setSendStatuses = useSetAtom(sessionSendStatusesAtom);
  const setHistoryProjections = useSetAtom(acceptedSessionHistoryProjectionsAtom);
  const instantHistory = selectInstantHistoryRecords(records);
  const instantHistoryKey = instantHistory.map((record) => record.id).join('\n');
  const instantHistoryRef = useRef(instantHistory);
  instantHistoryRef.current = instantHistory;
  useLayoutEffect(() => {
    // Keyed on membership: journal snapshots change at upload-progress rate, and
    // every projection change rebuilds the open conversation's view wrapper.
    // Layout timing: the stream drops these pending rows in the same render, so
    // the projected turn must land before paint.
    let next: ReadonlyMap<string, AcceptedSessionHistoryProjection> = new Map();
    for (const record of instantHistoryRef.current)
      next = addAcceptedSessionHistoryProjection(next, {
        workspaceId: record.workspaceId as WorkspaceId,
        sessionId: record.sessionId,
        entry: record.entry,
      });
    setHistoryProjections(next);
  }, [instantHistoryKey, setHistoryProjections]);
  useEffect(() => {
    const next = Object.fromEntries(
      records
        .filter(
          (record) => record.creation && record.stage !== 'delivered' && !record.cancelRequested
        )
        .map((record) => [getSessionRoomId(record.sessionId), record.creation!])
    );
    setPendingMetas((previous) =>
      JSON.stringify(previous) === JSON.stringify(next) ? previous : next
    );
    setSendStatuses(deriveSessionSendStatuses(records));
  }, [records, setPendingMetas, setSendStatuses]);
  useEffect(
    () => () => {
      setPendingMetas({});
      setSendStatuses({});
      setHistoryProjections(new Map());
    },
    [runtime, setHistoryProjections, setPendingMetas, setSendStatuses]
  );

  const exitCommitted = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [exitRequest, setExitRequest] = useState<ExitRequest | null>(null);
  const exitRef = useRef<ExitRequest | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const finishExit = useCallback((allow: boolean) => {
    exitRef.current?.resolve(allow);
    exitRef.current = null;
    setExitRequest(null);
  }, []);

  useEffect(() => {
    if (error) toast.error(error, { id: 'session-send-recovery-error' });
  }, [error]);

  useEffect(() => {
    setError(null);
    if (!journal) return undefined;
    let active = true;
    const refresh = () => {
      void journal.refresh().catch((failure: unknown) => {
        if (active)
          setError(
            failure instanceof Error ? failure.message : t('sessions.sendRecoveryUnavailable')
          );
      });
    };
    refresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      active = false;
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
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

  const hasPendingWork = useCallback(
    () =>
      !!error ||
      (runtime?.sendResources.getActiveCount() ?? 0) > 0 ||
      !!journal?.getSnapshot().some((record) => record.stage !== 'delivered'),
    [error, journal, runtime]
  );

  useBlocker({
    shouldBlockFn: async ({ current, next }) => {
      const currentWorkspace = (current.params as { workspaceName?: string }).workspaceName;
      const nextWorkspace = (next.params as { workspaceName?: string }).workspaceName;
      if (currentWorkspace === nextWorkspace) return false;
      return !(await requestSessionSendExit('workspace'));
    },
    enableBeforeUnload: () => !exitCommitted.current && hasPendingWork(),
  });

  useEffect(() => {
    const ipc = getIpcServices();
    if (!ipc) return undefined;
    const unsubscribe = onIpcEvent('app.sendLifecycle', (request) => {
      void (async () => {
        try {
          // Send approval never authorizes discarding another module's edits.
          // Recheck at commit in case edits changed while the native dialog was open.
          if (hasUnsavedRendererChanges()) {
            await ipc.app.replySendLifecycle({
              requestId: request.requestId,
              ready: false,
              pending: hasPendingWork(),
              unsaved: true,
            });
            return;
          }
          if (request.phase === 'commit') {
            await runtime?.dispose();
            // Durable records remain for recovery, but this document has joined
            // its work and must not veto the already approved native exit.
            exitCommitted.current = true;
          }
          await ipc.app.replySendLifecycle({
            requestId: request.requestId,
            ready: true,
            pending: hasPendingWork(),
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
  }, [hasPendingWork, runtime, t]);

  const destructiveExit = exitRequest?.reason === 'logout' || exitRequest?.reason === 'cache-clear';

  return (
    <AlertDialog.Root
      open={exitRequest !== null}
      onOpenChange={(open) => {
        if (!open) finishExit(false);
      }}
    >
      <AlertDialog.Content initialFocus={cancelRef}>
        <AlertDialog.Header>
          <AlertDialog.Title>{t('sessions.pendingSendExitTitle')}</AlertDialog.Title>
          <AlertDialog.Description>
            {t(
              destructiveExit
                ? 'sessions.pendingSendDestructiveExit'
                : 'sessions.pendingSendRetainedExit'
            )}
          </AlertDialog.Description>
        </AlertDialog.Header>
        <AlertDialog.Footer>
          <Button ref={cancelRef} onClick={() => finishExit(false)}>
            {t('sessions.stayWithPendingSends')}
          </Button>
          {destructiveExit ? (
            <Button variant="destructive" onClick={() => finishExit(true)}>
              {t('sessions.discardPendingSendsAndContinue')}
            </Button>
          ) : (
            <Button onClick={() => finishExit(true)}>{t('sessions.leaveWithPendingSends')}</Button>
          )}
        </AlertDialog.Footer>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}
