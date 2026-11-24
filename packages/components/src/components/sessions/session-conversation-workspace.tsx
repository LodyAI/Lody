import { useCallback, useMemo, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import type { SessionId } from '@lody/shared';
import { sessionListAtom } from '@/atoms/doc-meta';
import { readStoredLastActiveTabState } from '@/lib/session-draft-tabs';
import { formatSessionTabSearch } from '@/lib/session-tab-url';
import { ChatLanding } from '../chat/chat-landing';
import SessionDetail from './session-detail';
import {
  ConversationPaneContext,
  type ConversationPaneController,
  type ConversationPaneSearch,
} from './conversation-pane-context';
import {
  closeConversationPane,
  createConversationSplit,
  focusConversationPane,
  openInConversationPane,
  splitConversationRight,
  type ConversationSplitState,
} from './conversation-split';
import {
  SplitConversationLayout,
  SplitPaneActions,
  SplitPaneEmptyState,
} from './split-conversation-layout';

type PaneSearch = ConversationPaneSearch;
type WorkspaceState = {
  routeKey: string;
  split: ConversationSplitState;
  searches: Record<string, PaneSearch>;
  newChatPaneId: string | null;
};
type SearchOptions = { push?: boolean };
type UpdatePaneSearch = (
  paneId: string,
  sessionId: SessionId,
  patch: PaneSearch,
  options?: SearchOptions
) => void;

const noopSearch: ConversationPaneController['setSearch'] = () => {};
const noopTab: ConversationPaneController['setTab'] = () => {};

function initialSearch(sessionId: string): PaneSearch {
  const tab = readStoredLastActiveTabState(sessionId as SessionId)?.sessionTabId;
  return { tab: tab ? formatSessionTabSearch(tab, sessionId) : undefined };
}

/** The URL addresses the focused column; background columns retain their exact tab selections. */
export function SessionConversationWorkspace({
  workspaceSlug,
  sessionId,
  search,
}: {
  workspaceSlug: string;
  sessionId: SessionId;
  search: PaneSearch;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const sessions = useAtomValue(sessionListAtom);
  const routeKey = JSON.stringify([sessionId, search]);
  const [state, setState] = useState<WorkspaceState>(() => ({
    routeKey,
    split: createConversationSplit(sessionId),
    searches: { [sessionId]: search },
    newChatPaneId: null,
  }));
  let current = state;
  if (state.routeKey !== routeKey) {
    current = {
      ...state,
      routeKey,
      split: openInConversationPane(state.split, state.split.focusedPaneId, sessionId),
      searches: { ...state.searches, [sessionId]: search },
      newChatPaneId: null,
    };
    setState(current);
  }
  const stateRef = useRef(current);
  stateRef.current = current;
  const commit = useCallback((next: WorkspaceState) => {
    stateRef.current = next;
    setState(next);
  }, []);
  const visit = useCallback(
    (next: WorkspaceState, push = false) => {
      const pane = next.split.panes.find((item) => item.id === next.split.focusedPaneId);
      if (!pane?.sessionId) return;
      void navigate({
        to: '/$workspaceName/sessions/$sessionId',
        params: { workspaceName: workspaceSlug, sessionId: pane.sessionId },
        search: next.searches[pane.sessionId] ?? initialSearch(pane.sessionId),
        replace: !push,
      });
    },
    [navigate, workspaceSlug]
  );
  const focus = useCallback(
    (paneId: string) => {
      const before = stateRef.current;
      if (before.split.focusedPaneId === paneId) return;
      const next = { ...before, split: focusConversationPane(before.split, paneId) };
      commit(next);
      visit(next);
    },
    [commit, visit]
  );
  const open = useCallback(
    (paneId: string, id: string) => {
      const before = stateRef.current;
      const next = {
        ...before,
        split: openInConversationPane(before.split, paneId, id),
        searches: { ...before.searches, [id]: before.searches[id] ?? initialSearch(id) },
        newChatPaneId: null,
      };
      commit(next);
      visit(next, true);
    },
    [commit, visit]
  );
  const splitRight = useCallback(
    (paneId: string) => {
      const before = stateRef.current;
      commit({ ...before, split: splitConversationRight(before.split, paneId) });
    },
    [commit]
  );
  const closePane = useCallback(
    (paneId: string) => {
      const before = stateRef.current;
      const next = { ...before, split: closeConversationPane(before.split, paneId) };
      commit(next);
      visit(next);
    },
    [commit, visit]
  );
  const updateSearch = useCallback<UpdatePaneSearch>(
    (paneId, paneSessionId, patch, options) => {
      const before = stateRef.current;
      if (
        !before.split.panes.some((item) => item.id === paneId && item.sessionId === paneSessionId)
      )
        return;
      if (
        Object.entries(patch).every(
          ([key, value]) => before.searches[paneSessionId]?.[key as keyof PaneSearch] === value
        )
      )
        return;
      const next = {
        ...before,
        searches: {
          ...before.searches,
          [paneSessionId]: { ...before.searches[paneSessionId], ...patch },
        },
      };
      commit(next);
      if (next.split.focusedPaneId === paneId) visit(next, options?.push);
    },
    [commit, visit]
  );

  return (
    <SplitConversationLayout
      focusedPaneId={current.split.focusedPaneId}
      onFocusPane={focus}
      autoSaveId={`conversation-columns:${workspaceSlug}:${current.split.panes.map((pane) => pane.id).join(',')}`}
      panes={current.split.panes.map((pane) => ({
        id: pane.id,
        topBar: (context) =>
          pane.sessionId ? null : (
            <SplitPaneActions
              {...context}
              onSplit={() => splitRight(pane.id)}
              onClose={() => closePane(pane.id)}
            />
          ),
        body: (context) => {
          if (pane.sessionId) {
            return (
              <ConversationPane
                key={pane.sessionId}
                paneId={pane.id}
                sessionId={pane.sessionId as SessionId}
                search={current.searches[pane.sessionId] ?? {}}
                focused={pane.id === current.split.focusedPaneId}
                onSearch={updateSearch}
                onSplit={splitRight}
                onClose={closePane}
                canClose={context.canClose}
                canSplit={context.canSplit}
              />
            );
          }
          if (current.newChatPaneId === pane.id) {
            return (
              <ConversationDraftPane
                paneId={pane.id}
                focused={current.split.focusedPaneId === pane.id}
                workspaceSlug={workspaceSlug}
                onSessionCreated={(id) => {
                  if (
                    stateRef.current.split.panes.some(
                      (item) => item.id === pane.id && item.sessionId === null
                    )
                  )
                    open(pane.id, id);
                }}
              />
            );
          }
          return (
            <SplitPaneEmptyState
              recent={[...sessions]
                .sort(
                  (a, b) =>
                    new Date(b.lastMessageAt ?? b.createdAt ?? 0).getTime() -
                    new Date(a.lastMessageAt ?? a.createdAt ?? 0).getTime()
                )
                .slice(0, 20)
                .map((session) => ({
                  id: session.id,
                  title: session.title || t('sessions.untitled', 'Untitled session'),
                  detail: session.branchName,
                  open: current.split.panes.some((item) => item.sessionId === session.id),
                }))}
              onOpen={(id) => open(pane.id, id)}
              onNewChat={() => {
                const before = stateRef.current;
                commit({
                  ...before,
                  split: focusConversationPane(before.split, pane.id),
                  newChatPaneId: pane.id,
                });
              }}
            />
          );
        },
      }))}
    />
  );
}

function ConversationDraftPane({
  paneId,
  focused,
  workspaceSlug,
  onSessionCreated,
}: {
  paneId: string;
  focused: boolean;
  workspaceSlug: string;
  onSessionCreated: (sessionId: string) => void;
}) {
  const pane = useMemo(
    () => ({
      scopeId: paneId,
      focused,
      actions: null,
      setTab: noopTab,
      setSearch: noopSearch,
    }),
    [focused, paneId]
  );
  return (
    <ConversationPaneContext.Provider value={pane}>
      <ChatLanding workspaceSlug={workspaceSlug} onSessionCreated={onSessionCreated} />
    </ConversationPaneContext.Provider>
  );
}

function ConversationPane({
  paneId,
  sessionId,
  search,
  focused,
  onSearch,
  onSplit,
  onClose,
  canClose,
  canSplit,
}: {
  paneId: string;
  sessionId: SessionId;
  search: PaneSearch;
  focused: boolean;
  onSearch: UpdatePaneSearch;
  onSplit: (paneId: string) => void;
  onClose: (paneId: string) => void;
  canClose: boolean;
  canSplit: boolean;
}) {
  const updateSearch = useCallback(
    (patch: PaneSearch, options?: SearchOptions) => onSearch(paneId, sessionId, patch, options),
    [onSearch, paneId, sessionId]
  );
  const setTab = useCallback(
    (tab: string | undefined, options?: SearchOptions) => updateSearch({ tab }, options),
    [updateSearch]
  );
  const actions = useMemo(
    () => (
      <SplitPaneActions
        canClose={canClose}
        canSplit={canSplit}
        onSplit={() => onSplit(paneId)}
        onClose={() => onClose(paneId)}
      />
    ),
    [canClose, canSplit, onClose, onSplit, paneId]
  );
  const value = useMemo(
    () => ({
      scopeId: canClose ? paneId : undefined,
      focused,
      actions,
      setTab,
      setSearch: updateSearch,
    }),
    [actions, canClose, focused, paneId, setTab, updateSearch]
  );

  return (
    <ConversationPaneContext.Provider value={value}>
      <SessionDetail
        sessionId={sessionId}
        urlTab={search.tab}
        urlPrNumber={search.pr}
        urlBrowser={search.browser}
        urlSimulator={search.simulator}
      />
    </ConversationPaneContext.Provider>
  );
}
