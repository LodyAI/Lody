import { useCallback, useRef } from 'react';
import { atom, useAtomValue, useStore } from 'jotai';
import { useTranslation } from 'react-i18next';
import type { SessionId } from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { lodyPresenceNowMsAtom, lodyPresenceStatesAtom } from '@/atoms/presence';
import { Button } from '@lody/ui/button';
import { AlertDialog } from '@/ui/dialog';
import {
  isSessionWorking,
  summarizeOpenedSubConversations,
  type OpenedSubConversationSummary,
} from './session-archive-confirmation';

/**
 * Settle with an explicit choice about opened sub-conversations.
 *
 * Settle itself writes only the target Session: an opened Session is
 * independent work. When the conversation has opened active
 * sub-conversations, the user decides whether they are marked completed too;
 * the dialog says how many there are and how many are still working. Unlike
 * Archive there is no plain-confirm variant: settling one conversation is
 * reversible and needs no warning of its own.
 */

export type SettleChoice = 'tree' | 'session' | null;

const NO_SUB_CONVERSATIONS: OpenedSubConversationSummary = { count: 0, workingCount: 0 };

type PendingSettleConfirmation = OpenedSubConversationSummary & {
  resolve: (choice: SettleChoice) => void;
};

const pendingSettleConfirmationAtom = atom<PendingSettleConfirmation | null>(null);

/** Opens the shared dialog; `null` means cancelled. */
export function useSettleConfirmationRequest(): (
  summary: OpenedSubConversationSummary
) => Promise<SettleChoice> {
  const store = useStore();
  return useCallback(
    (summary) =>
      new Promise<SettleChoice>((resolve) => {
        // A newer request supersedes an unanswered one.
        store.get(pendingSettleConfirmationAtom)?.resolve(null);
        store.set(pendingSettleConfirmationAtom, { ...summary, resolve });
      }),
    [store]
  );
}

/**
 * Resolves `true` once settled, `false` when the user cancelled. Without opened
 * active sub-conversations it settles directly.
 */
export function useSettleSessionWithConfirmation(
  settleSession: (
    sessionId: SessionId,
    options?: { includeOpenedSessions?: boolean }
  ) => Promise<void>
): (sessionId: SessionId) => Promise<boolean> {
  const store = useStore();
  const requestConfirmation = useSettleConfirmationRequest();
  return useCallback(
    async (sessionId: SessionId) => {
      const runtime = store.get(activeWorkspaceRuntimeAtom);
      // A held creation has no metadata yet, so nothing can have been opened from it.
      const summary =
        !runtime || runtime.pendingSends?.hasPendingCreation(sessionId)
          ? NO_SUB_CONVERSATIONS
          : summarizeOpenedSubConversations(
              await runtime.readSessionOperationTargets(sessionId, 'archive-tree'),
              isSessionWorking(store.get(lodyPresenceStatesAtom), store.get(lodyPresenceNowMsAtom))
            );
      if (summary.count === 0) {
        await settleSession(sessionId);
        return true;
      }
      const choice = await requestConfirmation(summary);
      if (choice === null) return false;
      await settleSession(sessionId, { includeOpenedSessions: choice === 'tree' });
      return true;
    },
    [settleSession, requestConfirmation, store]
  );
}

/** Mounted once per workspace; renders only while a request is pending. */
export function SessionSettleConfirmationDialog() {
  const pending = useAtomValue(pendingSettleConfirmationAtom);
  const store = useStore();
  const answer = useCallback(
    (choice: SettleChoice) => {
      const current = store.get(pendingSettleConfirmationAtom);
      if (!current) return;
      store.set(pendingSettleConfirmationAtom, null);
      current.resolve(choice);
    },
    [store]
  );
  return <SessionSettleConfirmationView summary={pending} onAnswer={answer} />;
}

export function SessionSettleConfirmationView({
  summary,
  onAnswer,
}: {
  summary: OpenedSubConversationSummary | null;
  onAnswer: (choice: SettleChoice) => void;
}) {
  const { t } = useTranslation();
  // Keep the last counts while the dialog animates out.
  const shown = useRef(summary);
  if (summary) shown.current = summary;
  const count = shown.current?.count ?? 0;
  const workingCount = shown.current?.workingCount ?? 0;
  return (
    <AlertDialog.Root
      open={summary !== null}
      onOpenChange={(open) => {
        if (!open) onAnswer(null);
      }}
    >
      <AlertDialog.Content>
        <AlertDialog.Header>
          <AlertDialog.Title>
            {t('sessions.settleSubConversations.title', 'Mark sub-conversations as completed too?')}
          </AlertDialog.Title>
          <AlertDialog.Description>
            {t('sessions.settleSubConversations.description', {
              count,
              // The status sentence is interpolated so each language owns its spacing.
              status:
                workingCount > 0
                  ? t('sessions.settleSubConversations.working', {
                      count: workingCount,
                      defaultValue: '{{count}} are still working.',
                    })
                  : t(
                      'sessions.settleSubConversations.idle',
                      'None of them is working right now.'
                    ),
              defaultValue:
                'This conversation opened {{count}} active sub-conversations. {{status}}',
            })}
          </AlertDialog.Description>
        </AlertDialog.Header>
        {/* Plain buttons: an answer must settle before the close counts as Cancel. */}
        <AlertDialog.Footer>
          <Button variant="secondary" onClick={() => onAnswer(null)}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button variant="secondary" onClick={() => onAnswer('session')}>
            {t('sessions.settleSubConversations.onlyThis', 'Mark this only')}
          </Button>
          <Button onClick={() => onAnswer('tree')}>
            {t('sessions.settleSubConversations.all', 'Mark all as completed')}
          </Button>
        </AlertDialog.Footer>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}
