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
 * Archive with an explicit choice about opened sub-conversations.
 *
 * Archive itself takes only contained Tabs (`collectSessionArchiveTargets`): an
 * opened Session is independent work. When the conversation has opened active
 * sub-conversations, the user decides whether they go too; the dialog says how
 * many there are and how many are still working, because archiving stops them.
 * Callers that always confirm (the easy-to-fire keyboard shortcut) use the same
 * dialog, which then asks the plain "Archive chat?" question, so no flow stacks
 * two confirmations.
 */

export type OpenedSubConversationSummary = {
  /** Active (not archived) Sessions opened from this conversation tree. */
  count: number;
  /** Of those, the ones that are working now, counting their own Tabs. */
  workingCount: number;
};

export type ArchiveChoice = 'tree' | 'session' | null;

const NO_SUB_CONVERSATIONS: OpenedSubConversationSummary = { count: 0, workingCount: 0 };

type PendingArchiveConfirmation = OpenedSubConversationSummary & {
  resolve: (choice: ArchiveChoice) => void;
};

const pendingArchiveConfirmationAtom = atom<PendingArchiveConfirmation | null>(null);

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

function isSessionWorking(states: LodyPresenceStateMap, nowMs: number) {
  return (sessionId: SessionId) =>
    findFreshSessionPresenceState(states, sessionId, nowMs)?.status != null;
}

/**
 * Opens the shared dialog. A zero summary asks the plain archive question,
 * answered with `'session'`; `null` means cancelled.
 */
export function useArchiveConfirmationRequest(): (
  summary?: OpenedSubConversationSummary
) => Promise<ArchiveChoice> {
  const store = useStore();
  return useCallback(
    (summary = NO_SUB_CONVERSATIONS) =>
      new Promise<ArchiveChoice>((resolve) => {
        // A newer request supersedes an unanswered one.
        store.get(pendingArchiveConfirmationAtom)?.resolve(null);
        store.set(pendingArchiveConfirmationAtom, { ...summary, resolve });
      }),
    [store]
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
  const store = useStore();
  const requestConfirmation = useArchiveConfirmationRequest();
  return useCallback(
    async (sessionId: SessionId, options?: { confirm?: boolean }) => {
      const runtime = store.get(activeWorkspaceRuntimeAtom);
      // A held creation has no metadata yet, so nothing can have been opened from it.
      const summary =
        !runtime || runtime.pendingSends?.hasPendingCreation(sessionId)
          ? NO_SUB_CONVERSATIONS
          : summarizeOpenedSubConversations(
              await runtime.readSessionOperationTargets(sessionId, 'archive-tree'),
              isSessionWorking(store.get(lodyPresenceStatesAtom), store.get(lodyPresenceNowMsAtom))
            );
      if (summary.count === 0 && options?.confirm !== true) {
        await archiveSession(sessionId);
        return true;
      }
      const choice = await requestConfirmation(summary);
      if (choice === null) return false;
      await archiveSession(sessionId, { includeOpenedSessions: choice === 'tree' });
      return true;
    },
    [archiveSession, requestConfirmation, store]
  );
}

/** Mounted once per workspace; renders only while a request is pending. */
export function SessionArchiveConfirmationDialog() {
  const pending = useAtomValue(pendingArchiveConfirmationAtom);
  const store = useStore();
  const answer = useCallback(
    (choice: ArchiveChoice) => {
      const current = store.get(pendingArchiveConfirmationAtom);
      if (!current) return;
      store.set(pendingArchiveConfirmationAtom, null);
      current.resolve(choice);
    },
    [store]
  );
  return <SessionArchiveConfirmationView summary={pending} onAnswer={answer} />;
}

export function SessionArchiveConfirmationView({
  summary,
  onAnswer,
}: {
  summary: OpenedSubConversationSummary | null;
  onAnswer: (choice: ArchiveChoice) => void;
}) {
  const { t } = useTranslation();
  // Keep the last counts while the dialog animates out.
  const shown = useRef(summary);
  if (summary) shown.current = summary;
  const count = shown.current?.count ?? 0;
  const workingCount = shown.current?.workingCount ?? 0;
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
          {t('sessions.archiveSubConversations.onlyThis', 'Archive this only')}
        </Button>
        <Button onClick={() => onAnswer('tree')}>
          {t('sessions.archiveSubConversations.all', 'Archive all')}
        </Button>
      </>
    );
  return (
    <AlertDialog.Root
      open={summary !== null}
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
              <AlertDialog.Title>
                {t('sessions.archiveSubConversations.title', 'Archive sub-conversations too?')}
              </AlertDialog.Title>
              <AlertDialog.Description>
                {t('sessions.archiveSubConversations.description', {
                  count,
                  // The status sentence is interpolated so each language owns its spacing.
                  status:
                    workingCount > 0
                      ? t('sessions.archiveSubConversations.working', {
                          count: workingCount,
                          defaultValue:
                            '{{count}} are still working; archiving them stops that work.',
                        })
                      : t(
                          'sessions.archiveSubConversations.idle',
                          'None of them is working right now.'
                        ),
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
