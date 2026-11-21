import { useCallback, useRef } from 'react';
import { atom, useAtomValue, useStore } from 'jotai';
import { useTranslation } from 'react-i18next';
import {
  findFreshSessionPresenceState,
  type LodyPresenceStateMap,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { lodyPresenceNowMsAtom, lodyPresenceStatesAtom } from '@/atoms/presence';
import { Button } from '@lody/ui/button';
import { AlertDialog } from '@/ui/dialog';

/**
 * Confirmation for actions that optionally include opened sub-conversations.
 *
 * Archive, Settle, Snooze and Move to Focus take only the target Session (plus
 * contained Tabs for Archive): an opened Session is independent work. When the
 * conversation has opened active sub-conversations, the user decides whether
 * they go too; the dialog says how many there are and how many are still
 * working, because archiving stops them. Archive's always-confirm callers (the
 * easy-to-fire keyboard shortcut) reuse the same dialog for the plain
 * "Archive chat?" question, so no flow stacks two confirmations.
 */

export type OpenedSubConversationSummary = {
  /** Active (not archived) Sessions opened from this conversation tree. */
  count: number;
  /** Of those, the ones that are working now, counting their own Tabs. */
  workingCount: number;
};

export type SubConversationAction = 'archive' | 'settle' | 'snooze' | 'focus';

export type SubConversationChoice = 'tree' | 'session' | null;

const NO_SUB_CONVERSATIONS: OpenedSubConversationSummary = { count: 0, workingCount: 0 };

type PendingConfirmation = OpenedSubConversationSummary & {
  action: SubConversationAction;
  resolve: (choice: SubConversationChoice) => void;
};

const pendingConfirmationAtom = atom<PendingConfirmation | null>(null);

/** `targets` is an `archive-tree` read: the root first, then its descendants. */
export function summarizeOpenedSubConversations(
  targets: readonly SessionMeta[],
  isWorking: (sessionId: SessionId) => boolean
): OpenedSubConversationSummary {
  const descendants = targets.slice(1);
  // Tabs belong to their owner; only first-class opened Sessions are sub-conversations.
  const opened = descendants.filter(
    (session) => !session.parentSessionId && session.isArchived !== true
  );
  const workingIds = new Set<SessionId>();
  for (const session of descendants) {
    if (!isWorking(session.id)) continue;
    workingIds.add(session.parentSessionId ?? session.id);
  }
  return {
    count: opened.length,
    workingCount: opened.filter((session) => workingIds.has(session.id)).length,
  };
}

export function isSessionWorking(states: LodyPresenceStateMap, nowMs: number) {
  return (sessionId: SessionId) =>
    findFreshSessionPresenceState(states, sessionId, nowMs)?.status != null;
}

function useConfirmationRequest(action: SubConversationAction) {
  const store = useStore();
  return useCallback(
    (summary: OpenedSubConversationSummary) =>
      new Promise<SubConversationChoice>((resolve) => {
        // A newer request supersedes an unanswered one.
        store.get(pendingConfirmationAtom)?.resolve(null);
        store.set(pendingConfirmationAtom, { action, ...summary, resolve });
      }),
    [action, store]
  );
}

/**
 * Opens the shared dialog for an explicit archive confirmation. A zero summary
 * asks the plain archive question, answered with `'session'`; `null` means
 * cancelled.
 */
export function useArchiveConfirmationRequest(): (
  summary?: OpenedSubConversationSummary
) => Promise<SubConversationChoice> {
  const request = useConfirmationRequest('archive');
  return useCallback((summary = NO_SUB_CONVERSATIONS) => request(summary), [request]);
}

/**
 * Reads the opened-sub-conversation summary from one Repo snapshot and runs
 * `run` directly when there is nothing to ask about, unless `confirm` forces
 * the question anyway.
 */
function useConfirmedSessionAction<Args extends unknown[]>(
  action: SubConversationAction,
  run: (sessionId: SessionId, includeOpenedSessions: boolean, ...args: Args) => Promise<void>
): (sessionId: SessionId, confirm: boolean, ...args: Args) => Promise<boolean> {
  const store = useStore();
  const requestConfirmation = useConfirmationRequest(action);
  return useCallback(
    async (sessionId: SessionId, confirm: boolean, ...args: Args) => {
      const runtime = store.get(activeWorkspaceRuntimeAtom);
      // A held creation has no metadata yet, so nothing can have been opened from it.
      const summary =
        !runtime || runtime.pendingSends?.hasPendingCreation(sessionId)
          ? NO_SUB_CONVERSATIONS
          : summarizeOpenedSubConversations(
              await runtime.readSessionOperationTargets(sessionId, 'archive-tree'),
              isSessionWorking(store.get(lodyPresenceStatesAtom), store.get(lodyPresenceNowMsAtom))
            );
      if (summary.count === 0 && !confirm) {
        await run(sessionId, false, ...args);
        return true;
      }
      const choice = await requestConfirmation(summary);
      if (choice === null) return false;
      await run(sessionId, choice === 'tree', ...args);
      return true;
    },
    [run, requestConfirmation, store]
  );
}

/**
 * Resolves `true` once archived, `false` when the user cancelled. Without opened
 * active sub-conversations it archives directly, unless `confirm` asks for the
 * plain question anyway.
 */
export function useArchiveSessionWithConfirmation(
  archiveSession: (
    sessionId: SessionId,
    options?: { includeOpenedSessions?: boolean }
  ) => Promise<void>
): (sessionId: SessionId, options?: { confirm?: boolean }) => Promise<boolean> {
  const confirmed = useConfirmedSessionAction('archive', (sessionId, includeOpenedSessions) =>
    archiveSession(sessionId, { includeOpenedSessions })
  );
  return useCallback(
    (sessionId, options) => confirmed(sessionId, options?.confirm === true),
    [confirmed]
  );
}

/** Resolves `true` once settled, `false` when the user cancelled. */
export function useSettleSessionWithConfirmation(
  settleSession: (
    sessionId: SessionId,
    options?: { includeOpenedSessions?: boolean }
  ) => Promise<void>
): (sessionId: SessionId) => Promise<boolean> {
  const confirmed = useConfirmedSessionAction('settle', (sessionId, includeOpenedSessions) =>
    settleSession(sessionId, { includeOpenedSessions })
  );
  return useCallback((sessionId) => confirmed(sessionId, false), [confirmed]);
}

/** Resolves `true` once snoozed, `false` when the user cancelled. */
export function useSnoozeSessionWithConfirmation(
  snoozeSession: (
    sessionId: SessionId,
    snoozedUntil: number,
    options?: { includeOpenedSessions?: boolean }
  ) => Promise<void>
): (sessionId: SessionId, snoozedUntil: number) => Promise<boolean> {
  const confirmed = useConfirmedSessionAction(
    'snooze',
    (sessionId, includeOpenedSessions, snoozedUntil: number) =>
      snoozeSession(sessionId, snoozedUntil, { includeOpenedSessions })
  );
  return useCallback(
    (sessionId, snoozedUntil) => confirmed(sessionId, false, snoozedUntil),
    [confirmed]
  );
}

/** Resolves `true` once moved to Focus, `false` when the user cancelled. */
export function useMoveToFocusWithConfirmation(
  moveSessionToFocus: (
    sessionId: SessionId,
    options?: { includeOpenedSessions?: boolean }
  ) => Promise<void>
): (sessionId: SessionId) => Promise<boolean> {
  const confirmed = useConfirmedSessionAction('focus', (sessionId, includeOpenedSessions) =>
    moveSessionToFocus(sessionId, { includeOpenedSessions })
  );
  return useCallback((sessionId) => confirmed(sessionId, false), [confirmed]);
}

/** Mounted once per workspace; renders only while a request is pending. */
export function SessionSubConversationConfirmationDialog() {
  const pending = useAtomValue(pendingConfirmationAtom);
  const store = useStore();
  const answer = useCallback(
    (choice: SubConversationChoice) => {
      const current = store.get(pendingConfirmationAtom);
      if (!current) return;
      store.set(pendingConfirmationAtom, null);
      current.resolve(choice);
    },
    [store]
  );
  return <SessionSubConversationConfirmationView pending={pending} onAnswer={answer} />;
}

const DIALOG_COPY = {
  archive: {
    title: 'Archive sub-conversations too?',
    working: '{{count}} are still working; archiving them stops that work.',
    onlyThis: 'Archive this only',
    all: 'Archive all',
  },
  settle: {
    title: 'Mark sub-conversations as completed too?',
    working: '{{count}} are still working.',
    onlyThis: 'Mark this only',
    all: 'Mark all as completed',
  },
  snooze: {
    title: 'Snooze sub-conversations too?',
    working: '{{count}} are still working.',
    onlyThis: 'Snooze this only',
    all: 'Snooze all',
  },
  focus: {
    title: 'Move sub-conversations to Focus too?',
    working: '{{count}} are still working.',
    onlyThis: 'Move this only',
    all: 'Move all to Focus',
  },
} as const;

export function SessionSubConversationConfirmationView({
  pending,
  onAnswer,
}: {
  pending: (OpenedSubConversationSummary & { action: SubConversationAction }) | null;
  onAnswer: (choice: SubConversationChoice) => void;
}) {
  const { t } = useTranslation();
  // Keep the last counts while the dialog animates out.
  const shown = useRef(pending);
  if (pending) shown.current = pending;
  const count = shown.current?.count ?? 0;
  const workingCount = shown.current?.workingCount ?? 0;
  const action = shown.current?.action ?? 'archive';
  const copy = DIALOG_COPY[action];
  const keyPrefix = `sessions.${action}SubConversations`;
  const plainConfirmRef = useRef<HTMLButtonElement>(null);
  const footer =
    count === 0 ? (
      <>
        <Button variant="secondary" onClick={() => onAnswer(null)}>
          {t('common.cancel', 'Cancel')}
        </Button>
        <Button ref={plainConfirmRef} onClick={() => onAnswer('session')}>
          {t('sessions.archiveConfirm.confirm', 'Archive')}
        </Button>
      </>
    ) : (
      <>
        <Button variant="secondary" onClick={() => onAnswer(null)}>
          {t('common.cancel', 'Cancel')}
        </Button>
        <Button variant="secondary" onClick={() => onAnswer('session')}>
          {t(`${keyPrefix}.onlyThis`, copy.onlyThis)}
        </Button>
        <Button onClick={() => onAnswer('tree')}>{t(`${keyPrefix}.all`, copy.all)}</Button>
      </>
    );
  return (
    <AlertDialog.Root
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) onAnswer(null);
      }}
    >
      {/* The plain question focuses Archive so Enter confirms; Esc cancels. */}
      <AlertDialog.Content initialFocus={count === 0 ? () => plainConfirmRef.current : undefined}>
        <AlertDialog.Header>
          {count === 0 ? (
            <>
              <AlertDialog.Title>
                {t('sessions.archiveConfirm.title', 'Archive chat?')}
              </AlertDialog.Title>
              <AlertDialog.Description>
                {t(
                  'sessions.archiveConfirm.description',
                  'This chat will move to the archive. You can restore it later.'
                )}
              </AlertDialog.Description>
            </>
          ) : (
            <>
              <AlertDialog.Title>{t(`${keyPrefix}.title`, copy.title)}</AlertDialog.Title>
              <AlertDialog.Description>
                {t(`${keyPrefix}.description`, {
                  count,
                  // The status sentence is interpolated so each language owns its spacing.
                  status:
                    workingCount > 0
                      ? t(`${keyPrefix}.working`, {
                          count: workingCount,
                          defaultValue: copy.working,
                        })
                      : t(`${keyPrefix}.idle`, 'None of them is working right now.'),
                  defaultValue:
                    'This conversation opened {{count}} active sub-conversations. {{status}}',
                })}
              </AlertDialog.Description>
            </>
          )}
        </AlertDialog.Header>
        {/* Plain buttons: an answer must settle before the close counts as Cancel. */}
        <AlertDialog.Footer>{footer}</AlertDialog.Footer>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}
