import { describe, expect, it } from 'vitest';
import {
  closeConversationPane,
  createConversationSplit,
  openInConversationPane,
  openInNewConversationPane,
  splitConversationRight,
} from '../src/components/sessions/conversation-split';

const sessions = (state: ReturnType<typeof createConversationSplit>) =>
  state.panes.map((pane) => pane.sessionId);

describe('conversation split', () => {
  it('opens an empty, focused column to the right of the one split', () => {
    const split = splitConversationRight(createConversationSplit('a'), 'pane-1');
    expect(sessions(split)).toEqual(['a', null]);
    expect(split.focusedPaneId).toBe(split.panes[1]!.id);
  });

  it('stops at three columns', () => {
    let state = createConversationSplit('a');
    state = splitConversationRight(state, 'pane-1');
    state = splitConversationRight(state, state.focusedPaneId);
    expect(splitConversationRight(state, state.focusedPaneId)).toBe(state);
    expect(state.panes).toHaveLength(3);
  });

  it('never shows one session in two columns: opening it again focuses its column', () => {
    let state = splitConversationRight(createConversationSplit('a'), 'pane-1');
    state = openInConversationPane(state, state.focusedPaneId, 'a');
    expect(sessions(state)).toEqual(['a', null]);
    expect(state.focusedPaneId).toBe('pane-1');
  });

  it('opens beside the focused column, and when full replaces its neighbour, not it', () => {
    let state = createConversationSplit('a');
    state = openInNewConversationPane(state, 'b');
    state = openInNewConversationPane(state, 'c');
    expect(sessions(state)).toEqual(['a', 'b', 'c']);
    state = { ...state, focusedPaneId: state.panes[1]!.id };
    state = openInNewConversationPane(state, 'd');
    expect(sessions(state)).toEqual(['a', 'b', 'd']);
    expect(state.focusedPaneId).toBe(state.panes[2]!.id);
  });

  it('closing the focused column hands focus to the column it was split from', () => {
    let state = createConversationSplit('a');
    state = openInNewConversationPane(state, 'b');
    const closed = closeConversationPane(state, state.focusedPaneId);
    expect(sessions(closed)).toEqual(['a']);
    expect(closed.focusedPaneId).toBe('pane-1');
    expect(closeConversationPane(closed, 'pane-1')).toBe(closed);
  });
});
