import { describe, expect, it } from 'vitest';
import {
  formatExplicitSessionTabSearch,
  formatSessionTabSearch,
  parseSessionTabSearch,
  resolveActiveSessionTab,
} from '../src/lib/session-tab-url';

const parentSessionId = 'parent-session-id';

describe('parseSessionTabSearch', () => {
  it('returns missing when tab is absent', () => {
    expect(parseSessionTabSearch(undefined)).toEqual({ kind: 'missing' });
  });

  it('parses a child session tab', () => {
    expect(parseSessionTabSearch('session:child-session-id')).toEqual({
      kind: 'session',
      sessionId: 'child-session-id',
    });
  });

  it('parses a draft tab as its full draft tab id', () => {
    expect(parseSessionTabSearch('draft:draft-uuid')).toEqual({
      kind: 'draft',
      draftId: 'draft:draft-uuid',
    });
  });

  it('treats empty and malformed values as invalid', () => {
    expect(parseSessionTabSearch('')).toEqual({ kind: 'invalid' });
    expect(parseSessionTabSearch('session:')).toEqual({ kind: 'invalid' });
    expect(parseSessionTabSearch('draft:')).toEqual({ kind: 'invalid' });
    expect(parseSessionTabSearch('viewer:file:src/index.ts')).toEqual({ kind: 'invalid' });
  });
});

describe('formatSessionTabSearch', () => {
  it('omits the parent session tab so the route entry restoration can run', () => {
    expect(formatSessionTabSearch(parentSessionId, parentSessionId)).toBeUndefined();
  });

  it('formats a child session tab', () => {
    expect(formatSessionTabSearch('child-session-id', parentSessionId)).toBe(
      'session:child-session-id'
    );
  });

  it('keeps a draft tab id verbatim', () => {
    expect(formatSessionTabSearch('draft:draft-uuid', parentSessionId)).toBe('draft:draft-uuid');
  });

  it('round-trips through parseSessionTabSearch', () => {
    expect(parseSessionTabSearch(formatSessionTabSearch('child-id', parentSessionId))).toEqual({
      kind: 'session',
      sessionId: 'child-id',
    });
    expect(parseSessionTabSearch(formatSessionTabSearch('draft:d1', parentSessionId))).toEqual({
      kind: 'draft',
      draftId: 'draft:d1',
    });
    expect(parseSessionTabSearch(formatSessionTabSearch(parentSessionId, parentSessionId))).toEqual(
      { kind: 'missing' }
    );
  });
});

describe('formatExplicitSessionTabSearch', () => {
  it('encodes the parent explicitly so tab activation is never re-restored', () => {
    // In-session activation of the parent tab must stay distinguishable from
    // an external entry with no tab choice — the absent value would be filled
    // back in by the route's last-active restoration.
    expect(formatExplicitSessionTabSearch(parentSessionId)).toBe(`session:${parentSessionId}`);
    expect(parseSessionTabSearch(formatExplicitSessionTabSearch(parentSessionId))).toEqual({
      kind: 'session',
      sessionId: parentSessionId,
    });
  });

  it('encodes children and drafts like the shared format', () => {
    expect(formatExplicitSessionTabSearch('child-id')).toBe('session:child-id');
    expect(formatExplicitSessionTabSearch('draft:d1')).toBe('draft:d1');
  });
});

describe('resolveActiveSessionTab', () => {
  const context = {
    parentSessionId,
    childSessionIdsResolvedToParent: ['child-archived', 'side-chat-1'],
    draftTabIds: ['draft:d1'],
    promotedChildSessionIdsByDraftId: {},
  };

  it('resolves a missing tab to the parent (external navigation stripping ?tab converges)', () => {
    // #193: navigation that removes `?tab` while a child was active must
    // settle at the parent with no bounce-back write.
    expect(resolveActiveSessionTab({ kind: 'missing' }, context)).toBe(parentSessionId);
  });

  it('normalizes an explicit parent tab value', () => {
    expect(resolveActiveSessionTab({ kind: 'session', sessionId: parentSessionId }, context)).toBe(
      parentSessionId
    );
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

  it('activates a known draft tab', () => {
    expect(resolveActiveSessionTab({ kind: 'draft', draftId: 'draft:d1' }, context)).toBe(
      'draft:d1'
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
