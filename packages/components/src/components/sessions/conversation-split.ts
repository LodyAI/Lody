/**
 * Split conversation: the desktop conversation area shown as up to three columns, side by
 * side. Each column is a whole session page of its own (its tab row, its `?tab`-style
 * selection, its composer), so the tab mechanism is unchanged inside a column; this module
 * only decides which columns exist, in what order, and which one has focus.
 *
 * A column holds a root session, and one root session is open in at most one column. Two live
 * copies of one conversation would show two composers writing one draft and report the same
 * read twice, so opening a session that is already shown focuses its column instead.
 *
 * A column may also be empty (just split, nothing chosen yet). Pure state; the host persists it.
 */
export const MAX_CONVERSATION_SPLIT_PANES = 3;

export type ConversationSplitPane = {
  id: string;
  sessionId: string | null;
};

export type ConversationSplitState = {
  panes: readonly ConversationSplitPane[];
  focusedPaneId: string;
};

export function createConversationSplit(sessionId: string | null): ConversationSplitState {
  const pane = { id: 'pane-1', sessionId };
  return { panes: [pane], focusedPaneId: pane.id };
}

function nextPaneId(state: ConversationSplitState): string {
  let index = state.panes.length + 1;
  const taken = new Set(state.panes.map((pane) => pane.id));
  while (taken.has(`pane-${index}`)) index += 1;
  return `pane-${index}`;
}

export function canSplitConversation(state: ConversationSplitState): boolean {
  return state.panes.length < MAX_CONVERSATION_SPLIT_PANES;
}

/**
 * Opens an empty column to the right of `paneId` and focuses it. A full split is returned
 * unchanged: the host disables the action rather than replacing someone's column.
 */
export function splitConversationRight(
  state: ConversationSplitState,
  paneId: string
): ConversationSplitState {
  if (!canSplitConversation(state)) return state;
  const index = state.panes.findIndex((pane) => pane.id === paneId);
  if (index === -1) return state;
  const pane = { id: nextPaneId(state), sessionId: null };
  const panes = [...state.panes];
  panes.splice(index + 1, 0, pane);
  return { panes, focusedPaneId: pane.id };
}

/**
 * Shows `sessionId` in `paneId` (the column's own navigation: sidebar click while it has focus,
 * the empty column's picker). If another column already shows the session, that column is
 * focused instead and nothing moves.
 */
export function openInConversationPane(
  state: ConversationSplitState,
  paneId: string,
  sessionId: string
): ConversationSplitState {
  const existing = state.panes.find((pane) => pane.sessionId === sessionId);
  if (existing) return focusConversationPane(state, existing.id);
  if (!state.panes.some((pane) => pane.id === paneId)) return state;
  return {
    panes: state.panes.map((pane) => (pane.id === paneId ? { ...pane, sessionId } : pane)),
    focusedPaneId: paneId,
  };
}

/**
 * Opens `sessionId` in a new column beside the focused one (the "Open in split" entry points).
 * Already shown: focus it. Full: the focused column's right neighbour (or, for the last column,
 * its left one) takes it, so the column the person is working in never changes under them.
 */
export function openInNewConversationPane(
  state: ConversationSplitState,
  sessionId: string
): ConversationSplitState {
  const existing = state.panes.find((pane) => pane.sessionId === sessionId);
  if (existing) return focusConversationPane(state, existing.id);
  if (canSplitConversation(state)) {
    const split = splitConversationRight(state, state.focusedPaneId);
    return openInConversationPane(split, split.focusedPaneId, sessionId);
  }
  const index = state.panes.findIndex((pane) => pane.id === state.focusedPaneId);
  const target = state.panes[index + 1] ?? state.panes[index - 1];
  return target ? openInConversationPane(state, target.id, sessionId) : state;
}

/**
 * Closes a column. The last column cannot be closed. Focus moves to the left neighbour (the
 * column the split came from), or the right one when the first column closes.
 */
export function closeConversationPane(
  state: ConversationSplitState,
  paneId: string
): ConversationSplitState {
  if (state.panes.length <= 1) return state;
  const index = state.panes.findIndex((pane) => pane.id === paneId);
  if (index === -1) return state;
  const panes = state.panes.filter((pane) => pane.id !== paneId);
  if (state.focusedPaneId !== paneId) return { panes, focusedPaneId: state.focusedPaneId };
  const neighbour = panes[Math.max(0, index - 1)]!;
  return { panes, focusedPaneId: neighbour.id };
}

export function focusConversationPane(
  state: ConversationSplitState,
  paneId: string
): ConversationSplitState {
  if (state.focusedPaneId === paneId || !state.panes.some((pane) => pane.id === paneId)) {
    return state;
  }
  return { ...state, focusedPaneId: paneId };
}
