// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionMeta } from '@lody/shared';

import {
  buildSessionMentionItems,
  buildSessionMentionSlug,
  expandSessionMentionsInText,
  hydrateSessionMentionsFromText,
  rememberSessionMentionSlugs,
  resolveSessionMentionIds,
  selectSessionMentionCandidates,
} from '../src/components/mentions/mention-session-source';

function session(over: Partial<SessionMeta> & { id: string }): SessionMeta {
  return {
    machineId: 'm1',
    createdAt: '2026-01-01T00:00:00.000Z',
    userId: 'u1',
    cliType: 'claude',
    agentType: 'claude',
    ...over,
  } as SessionMeta;
}

describe('buildSessionMentionSlug', () => {
  it('replaces whitespace so the token survives trigger scanning', () => {
    expect(buildSessionMentionSlug('fix ci submodule init', 'ses_abcd1234')).toBe(
      'fix-ci-submodule-init'
    );
  });

  it('keeps CJK, which no trigger scan breaks on', () => {
    expect(buildSessionMentionSlug('mention 重设计', 'ses_abcd1234')).toBe('mention-重设计');
  });

  it('truncates by characters, not code units', () => {
    const slug = buildSessionMentionSlug('五'.repeat(80), 'ses_abcd1234');
    expect(Array.from(slug)).toHaveLength(40);
  });

  it('falls back to a short id when the session has no title yet', () => {
    expect(buildSessionMentionSlug(undefined, 'ses_abcd1234')).toBe('ses_');
    expect(buildSessionMentionSlug('   ', 'ses_abcd1234')).toBe('ses_');
  });
});

describe('buildSessionMentionItems', () => {
  it('orders by recency, drops the current session and archived ones', () => {
    const items = buildSessionMentionItems(
      [
        session({ id: 'a', title: 'older', lastMessageAt: 10 }),
        session({ id: 'b', title: 'newer', lastMessageAt: 20 }),
        session({ id: 'self', title: 'this one', lastMessageAt: 30 }),
        session({ id: 'c', title: 'archived', lastMessageAt: 40, isArchived: true }),
      ],
      'self'
    );

    expect(items.map((item) => item.sessionId)).toEqual(['b', 'a']);
  });

  it('disambiguates a duplicate title and leaves the most recent one clean', () => {
    const items = buildSessionMentionItems(
      [
        session({ id: 'older-id', title: 'same title', lastMessageAt: 10 }),
        session({ id: 'newer-id', title: 'same title', lastMessageAt: 20 }),
      ],
      null
    );

    // The most recent holder keeps the clean slug, so re-typing it stays stable.
    expect(items[0]?.slug).toBe('same-title');
    expect(items[1]?.slug).toBe('same-title~olde');
  });

  it('ranks a prefix match above a substring match', () => {
    const items = buildSessionMentionItems(
      [
        session({ id: 'a', title: 'redesign mention', lastMessageAt: 10 }),
        session({ id: 'b', title: 'mention redesign', lastMessageAt: 5 }),
      ],
      null
    );

    expect(selectSessionMentionCandidates(items, 'mention').map((item) => item.sessionId)).toEqual([
      'b',
      'a',
    ]);
  });
});

describe('expandSessionMentionsInText', () => {
  const ids = new Map([['fix-ci', 'ses_7f3ac91b']]);

  it('replaces the token with an id-bearing instruction', () => {
    expect(expandSessionMentionsInText('look at @session:fix-ci please', ids)).toBe(
      'look at use lody mcp to query session[id: ses_7f3ac91b] history please'
    );
  });

  it('is idempotent because expansion consumes its own anchor', () => {
    const once = expandSessionMentionsInText('@session:fix-ci', ids);
    expect(expandSessionMentionsInText(once, ids)).toBe(once);
  });

  it('leaves an unresolvable slug untouched rather than guessing an id', () => {
    // A renamed session we never cached: a stale token the agent can ignore is
    // better than a confidently wrong session id.
    expect(expandSessionMentionsInText('@session:renamed-away', ids)).toBe('@session:renamed-away');
  });

  it('expands every occurrence', () => {
    expect(expandSessionMentionsInText('@session:fix-ci and @session:fix-ci', ids)).toBe(
      'use lody mcp to query session[id: ses_7f3ac91b] history and use lody mcp to query session[id: ses_7f3ac91b] history'
    );
  });
});

describe('hydrateSessionMentionsFromText', () => {
  it('rebuilds ranges carrying the session id, not the slug', () => {
    const hydrated = hydrateSessionMentionsFromText(
      'see @session:fix-ci now',
      new Map([['fix-ci', 'ses_7f3ac91b']])
    );

    expect(hydrated.mentions).toEqual([{ value: 'ses_7f3ac91b', start: 4, end: 19 }]);
    expect(hydrated.values).toEqual(['ses_7f3ac91b']);
  });

  it('ignores tokens it cannot resolve', () => {
    expect(hydrateSessionMentionsFromText('@session:unknown', new Map()).mentions).toEqual([]);
  });
});

describe('slug cache', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('resolves a slug whose session has since been renamed', () => {
    const items = buildSessionMentionItems([session({ id: 'ses_1', title: 'old name' })], null);
    rememberSessionMentionSlugs(items);

    // The session is renamed, so the live list no longer produces `old-name`.
    const renamed = buildSessionMentionItems([session({ id: 'ses_1', title: 'new name' })], null);
    const resolved = resolveSessionMentionIds(renamed);

    expect(resolved.get('old-name')).toBe('ses_1');
    expect(resolved.get('new-name')).toBe('ses_1');
  });

  it('lets the live list win over a stale cache entry', () => {
    localStorage.setItem('lody:session-mention-slugs', JSON.stringify({ dup: 'stale' }));
    const items = buildSessionMentionItems([session({ id: 'fresh', title: 'dup' })], null);

    expect(resolveSessionMentionIds(items).get('dup')).toBe('fresh');
  });
});
