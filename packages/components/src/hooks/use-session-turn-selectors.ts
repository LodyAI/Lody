import { useEffect, useState } from 'react';
import { resolveActiveAssistantTurnId, type SessionHistory } from '@lody/shared';
import type { SessionDocState } from '@/atoms/runtime';
import {
  findSystemNotice,
  resolveActiveAssistantTurnIdFromView,
  type ConversationView,
  type SystemNoticeSearch,
} from '@/lib/conversation-view';
import { useConversationViewSelector, useViewFallback } from './use-conversation-view-selector';

type SessionDocSource = {
  doc: SessionDocState;
  conversationView?: ConversationView | null;
};

/**
 * The open assistant turn's id (see `resolveActiveAssistantTurnId`), from
 * index rows on the view path and from `doc.history` on the rollback path.
 */
export function useActiveAssistantTurnId(source: SessionDocSource): string | undefined {
  const view = source.conversationView ?? null;
  const fallback = useViewFallback(
    view,
    () => resolveActiveAssistantTurnId(source.doc.history),
    [source.doc]
  );
  return useConversationViewSelector(view, resolveActiveAssistantTurnIdFromView, fallback);
}

const NOT_FOUND: SystemNoticeSearch = { found: false, unhydratedSystemTurnIndex: null };
const FOUND: SystemNoticeSearch = { found: true };

const hasSystemNoticeInHistory = (history: readonly SessionHistory[], name: string): boolean =>
  history.some((entry) =>
    (entry.items ?? []).some((item) => item.type === 'system_notice' && item.name === name)
  );

const searchEqual = (left: SystemNoticeSearch, right: SystemNoticeSearch): boolean =>
  left.found === right.found &&
  (left.found || right.found || left.unhydratedSystemTurnIndex === right.unhydratedSystemTurnIndex);

/**
 * Whether the session carries the `system_notice` named `name`. Only system
 * turns are inspected; one that is not hydrated is hydrated on its own
 * (one `toJSON`, no version bump) and the search re-runs.
 */
export function useSessionSystemNotice(source: SessionDocSource, name: string): boolean {
  const view = source.conversationView ?? null;
  const fallback = useViewFallback(
    view,
    () =>
      hasSystemNoticeInHistory(source.doc.history as readonly SessionHistory[], name)
        ? FOUND
        : NOT_FOUND,
    [source.doc, name]
  );
  const [hydrationRevision, setHydrationRevision] = useState(0);
  const search = useConversationViewSelector(
    view,
    (current) => findSystemNotice(current, name),
    fallback ?? NOT_FOUND,
    { isEqual: searchEqual, revision: hydrationRevision }
  );
  const pendingIndex = search.found ? null : search.unhydratedSystemTurnIndex;
  useEffect(() => {
    if (!view || pendingIndex === null) return undefined;
    let cancelled = false;
    void view.ensureRange(pendingIndex, pendingIndex + 1).then(() => {
      if (!cancelled) setHydrationRevision((revision) => revision + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [pendingIndex, view]);
  return search.found;
}
