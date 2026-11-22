import { useCallback } from 'react';
import { useStore } from 'jotai';
import { usePlatform } from '@lody/platform/react';
import { useTranslation } from 'react-i18next';
import {
  getSessionRoomId,
  isLoroRepoDocDeleted,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import { activeWorkspaceRuntimeAtom, type WorkspaceRuntime } from '@/atoms/runtime';
import { useSessionActions } from '@/hooks/use-session-actions';
import { useOrganization } from '@/hooks/useOrganization';
import { useStatusViewWritable } from '@/hooks/use-status-view-writable';
import { toast } from '@/lib/toast';
import { useWorkspaceLocalAccountId } from '@/lib/e2ee-account';
import { isSessionEditableToUser, type SessionMachineRecord } from '@/lib/session-visibility';
import {
  useVisibleLocalProjectKeySet,
  useVisibleMachineIdSet,
} from '@/hooks/use-visible-session-metas';
import {
  useMoveToFocusWithConfirmation,
  useSettleSessionWithConfirmation,
  useSnoozeSessionWithConfirmation,
} from '@/components/sessions/session-sub-conversation-confirmation';

/** The fields Later, Settle and Move to Focus write; Undo puts them back. */
export type StatusFields = Pick<SessionMeta, 'snoozedUntil' | 'settledAt' | 'focusRestoredAt'>;

const fieldsOf = (meta: Partial<SessionMeta> | undefined): StatusFields => ({
  snoozedUntil: typeof meta?.snoozedUntil === 'number' ? meta.snoozedUntil : undefined,
  settledAt: typeof meta?.settledAt === 'number' ? meta.settledAt : undefined,
  focusRestoredAt: typeof meta?.focusRestoredAt === 'number' ? meta.focusRestoredAt : undefined,
});

const sameFields = (a: StatusFields, b: StatusFields) =>
  a.snoozedUntil === b.snoozedUntil &&
  a.settledAt === b.settledAt &&
  a.focusRestoredAt === b.focusRestoredAt;

/** Undo writes back only the conversations whose status fields the action changed. */
export function planStatusUndo(
  before: ReadonlyMap<string, StatusFields>,
  after: ReadonlyMap<string, StatusFields>
): Array<{ sessionId: string; patch: StatusFields }> {
  const writes: Array<{ sessionId: string; patch: StatusFields }> = [];
  for (const [sessionId, prior] of before) {
    const current = after.get(sessionId);
    if (current && !sameFields(prior, current)) writes.push({ sessionId, patch: prior });
  }
  return writes;
}

async function readStatusFields(
  runtime: WorkspaceRuntime,
  sessionId: SessionId
): Promise<Map<string, StatusFields>> {
  const targets = await runtime.readSessionOperationTargets(sessionId, 'archive-tree');
  return new Map(targets.map((meta) => [meta.id, fieldsOf(meta)]));
}

async function rereadStatusFields(
  runtime: WorkspaceRuntime,
  ids: Iterable<string>
): Promise<Map<string, StatusFields>> {
  const entries = await Promise.all(
    [...ids].map(async (id) => {
      const entry = await runtime.repo.getDocMeta(getSessionRoomId(id as SessionId));
      return [
        id,
        isLoroRepoDocDeleted(entry) ? undefined : fieldsOf(entry?.meta as SessionMeta),
      ] as const;
    })
  );
  return new Map(
    entries.filter((entry): entry is readonly [string, StatusFields] => entry[1] !== undefined)
  );
}

/** Later / Settle / Move to Focus with the shared sub-conversation question and Undo. */
export function useMobileStatusActions() {
  const { t } = useTranslation();
  const store = useStore();
  const { snoozeSession, settleSession, moveSessionToFocus, updateSessionMetadata } =
    useSessionActions();
  const snooze = useSnoozeSessionWithConfirmation(snoozeSession);
  const settle = useSettleSessionWithConfirmation(settleSession);
  const focus = useMoveToFocusWithConfirmation(moveSessionToFocus);

  const report = useCallback((error: unknown) => {
    toast.error(error instanceof Error ? error.message : String(error));
  }, []);

  const withUndo = useCallback(
    async (sessionId: SessionId, run: () => Promise<boolean>, notice: string) => {
      const runtime = store.get(activeWorkspaceRuntimeAtom);
      const before = runtime ? await readStatusFields(runtime, sessionId) : new Map();
      if (!(await run())) return;
      if (!runtime) return;
      const after = await rereadStatusFields(runtime, before.keys());
      const undo = planStatusUndo(before, after);
      if (undo.length === 0) return;
      const toastId = `status-undo:${sessionId}`;
      toast(notice, {
        id: toastId,
        action: {
          label: t('common.undo', 'Undo'),
          onClick: () => {
            toast.dismiss(toastId);
            void (async () => {
              for (const write of undo) {
                await updateSessionMetadata(write.sessionId as SessionId, write.patch);
              }
            })().catch(report);
          },
        },
      });
    },
    [report, store, t, updateSessionMetadata]
  );

  const snoozeWithUndo = useCallback(
    (sessionId: string, until: number) => {
      void withUndo(
        sessionId as SessionId,
        () => snooze(sessionId as SessionId, until),
        t('chat.mobileHome.status.movedToLater', 'Moved to Later')
      ).catch(report);
    },
    [report, snooze, t, withUndo]
  );
  const settleWithUndo = useCallback(
    (sessionId: string) => {
      void withUndo(
        sessionId as SessionId,
        () => settle(sessionId as SessionId),
        t('chat.mobileHome.status.settled', 'Settled')
      ).catch(report);
    },
    [report, settle, t, withUndo]
  );
  const moveToFocus = useCallback(
    (sessionId: string) => {
      void focus(sessionId as SessionId).catch(report);
    },
    [focus, report]
  );

  return { snooze: snoozeWithUndo, settle: settleWithUndo, moveToFocus, report };
}

/**
 * Whether status actions may be offered: never to a read-only member, otherwise
 * the session-management guard's predicate (see the design note's limits).
 */
export function useCanManageSessionStatus(
  session: SessionMachineRecord | null | undefined
): boolean {
  const platform = usePlatform();
  const writable = useStatusViewWritable(useOrganization().role);
  const { visibleMachineIds, ownedMachineIds } = useVisibleMachineIdSet();
  const { visibleLocalProjectKeys } = useVisibleLocalProjectKeySet();
  const accountId = useWorkspaceLocalAccountId();
  if (!session || !writable) return false;
  if (platform.kind === 'local') return true;
  return isSessionEditableToUser(
    session,
    visibleMachineIds,
    visibleLocalProjectKeys,
    accountId,
    ownedMachineIds
  );
}
