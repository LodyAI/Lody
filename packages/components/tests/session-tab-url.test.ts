import { describe, expect, it } from 'vitest';
import {
  resolveActiveSessionTab,
  getSessionTabFallback,
  isSessionTabClosed,
} from '../src/lib/session-tab-url';

const parentSessionId = 'parent-session-id';

describe('shared tab closure', () => {
  it('retains the requested tab until the replica can establish its open neighbour', () => {
    expect(getSessionTabFallback('parent', ['parent'], [], false)).toBe('parent');
    expect(getSessionTabFallback('parent', ['parent', 'child'], ['child'], false)).toBe('parent');
    expect(getSessionTabFallback('parent', ['parent', 'child'], ['child'], true)).toBe('child');
    expect(getSessionTabFallback('parent', ['parent'], [], true)).toBe('empty');
  });
  it('keeps tab closure independent of archive', () => {
    const liveWorkspace = false;
    const archivedWorkspace = true;
    expect(isSessionTabClosed({}, liveWorkspace)).toBe(false);
    expect(isSessionTabClosed({ isTabClosed: true }, liveWorkspace)).toBe(true);
    // Reviewing an archived workspace shows every tab it had open.
    expect(isSessionTabClosed({ isArchived: true }, archivedWorkspace)).toBe(false);
    expect(isSessionTabClosed({ isArchived: true, isTabClosed: true }, archivedWorkspace)).toBe(
      true
    );
    // A live workspace keeps archived children out of its strip.
    expect(isSessionTabClosed({ isArchived: true, isTabClosed: false }, liveWorkspace)).toBe(true);
    expect(isSessionTabClosed({ isArchived: false, isTabClosed: false }, liveWorkspace)).toBe(
      false
    );
  });
  it('chooses the right open neighbour, then the left, then empty', () => {
    const order = ['parent', 'a', 'b', 'c'];
    expect(getSessionTabFallback('a', order, ['parent', 'c'])).toBe('c');
    expect(getSessionTabFallback('c', order, ['parent', 'a'])).toBe('a');
    expect(getSessionTabFallback('parent', order, [])).toBe('empty');
    expect(getSessionTabFallback('absent', order, ['a'])).toBe('a');
  });
});

describe('resolveActiveSessionTab', () => {
  const context = {
    parentSessionId,
    childSessionIdsResolvedToParent: ['child-archived', 'side-chat-1'],
    draftTabIds: ['draft:d1'],
    promotedChildSessionIdsByDraftId: {},
  };
  it('keeps an explicitly empty surface empty when new tabs arrive', () => {
    expect(resolveActiveSessionTab({ kind: 'empty' }, context)).toBe('empty');
  });

  it('resolves a missing tab to the parent (external navigation stripping ?tab converges)', () => {
    // #193: navigation that removes `?tab` while a child was active must
    // settle at the parent with no bounce-back write.
    expect(resolveActiveSessionTab({ kind: 'missing' }, context)).toBe(parentSessionId);
  });

  it('takes the URL at its word for a child the replica has not delivered yet', () => {
    // A just-promoted draft or a tab syncing from another device: the tab
    // stays ACTIVE (the caller renders a pending surface) instead of bouncing
    // back to the parent conversation. Treating a transient replica gap as
    // "this tab does not exist" is the bug this rule replaces.
    expect(resolveActiveSessionTab({ kind: 'session', sessionId: 'child-syncing' }, context)).toBe(
      'child-syncing'
    );
  });

  it('resolves an archived or side-panel child to the parent (positive evidence only)', () => {
    expect(resolveActiveSessionTab({ kind: 'session', sessionId: 'child-archived' }, context)).toBe(
      parentSessionId
    );
    // A side chat renders in the right panel and never owns a top tab, so a
    // URL addressing one (an opened-by link) must not hold a pending surface.
    expect(resolveActiveSessionTab({ kind: 'session', sessionId: 'side-chat-1' }, context)).toBe(
      parentSessionId
    );
  });

  it('follows a promotion alias when the draft is gone', () => {
    // The send instant: the draft leaves local state before the router commits
    // `session:<child>`. The alias keeps the new conversation active through
    // that window with zero frames on the parent.
    expect(
      resolveActiveSessionTab(
        { kind: 'draft', draftId: 'draft:sent' },
        { ...context, promotedChildSessionIdsByDraftId: { 'draft:sent': 'child-new' } }
      )
    ).toBe('child-new');
  });

  it('prefers a live draft over its promotion alias', () => {
    // A failed send keeps the draft; retrying reuses the same ids. The live
    // draft must win so the user stays on the composer, not a dead child.
    expect(
      resolveActiveSessionTab(
        { kind: 'draft', draftId: 'draft:d1' },
        { ...context, promotedChildSessionIdsByDraftId: { 'draft:d1': 'child-new' } }
      )
    ).toBe('draft:d1');
  });

  it('resolves an unknown draft and invalid values to the parent', () => {
    // Drafts are device-local, so absence (with no alias) is positive
    // evidence, unlike a session id.
    expect(resolveActiveSessionTab({ kind: 'draft', draftId: 'draft:gone' }, context)).toBe(
      parentSessionId
    );
    expect(resolveActiveSessionTab({ kind: 'invalid' }, context)).toBe(parentSessionId);
  });
});
