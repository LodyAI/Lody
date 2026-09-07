// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import { applyTextRewrites, type SessionMeta } from '@lody/shared';

import {
  buildSessionMentionItems,
  buildSessionMentionSlug,
  buildSessionMentionRewrites,
  filterSessionMentionItemsByProject,
  getMentionSourceProjectKey,
  getSessionMentionProjectKey,
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

  it('matches titles as ordered subsequences across words and punctuation', () => {
    const items = buildSessionMentionItems(
      [
        session({ id: 'match', title: 'File generated-name investigation', lastMessageAt: 10 }),
        session({ id: 'miss', title: 'Unrelated conversation', lastMessageAt: 20 }),
      ],
      null
    );

    expect(selectSessionMentionCandidates(items, 'filename').map((item) => item.sessionId)).toEqual(
      ['match']
    );
  });
});

describe('session mention project scope', () => {
  it('includes the machine in a local project identity', () => {
    const first = session({
      id: 'first',
      machineId: 'machine-a',
      project: { kind: 'local', localProjectId: 'project-1' },
    });
    const second = session({
      id: 'second',
      machineId: 'machine-b',
      project: { kind: 'local', localProjectId: 'project-1' },
    });

    expect(getSessionMentionProjectKey(first)).toBe('local:machine-a:project-1');
    expect(getSessionMentionProjectKey(second)).toBe('local:machine-b:project-1');
    expect(
      getMentionSourceProjectKey({
        kind: 'local',
        machineId: 'machine-a',
        workspaceId: 'workspace-1',
        localProjectId: 'project-1',
      })
    ).toBe('local:machine-a:project-1');
    expect(
      getMentionSourceProjectKey({
        kind: 'provider',
        localProject: { machineId: 'machine-a', localProjectId: 'project-1' },
        githubRepoFullName: 'lodyai/lody',
      })
    ).toBe('local:machine-a:project-1');
  });

  it('normalizes GitHub repos and prefers the structured project', () => {
    expect(
      getSessionMentionProjectKey(
        session({
          id: 'structured',
          project: { kind: 'github', repoFullName: ' LodyAI/Lody ', branch: 'main' },
          repoFullName: 'legacy/wrong',
        })
      )
    ).toBe('github:lodyai/lody');
    expect(getMentionSourceProjectKey({ kind: 'github', repoFullName: ' lodyai/LODY ' })).toBe(
      'github:lodyai/lody'
    );
  });

  it('falls back to the legacy repo and groups projectless chats together', () => {
    expect(getSessionMentionProjectKey(session({ id: 'legacy', repoFullName: ' Org/Repo ' }))).toBe(
      'github:org/repo'
    );
    expect(getSessionMentionProjectKey(session({ id: 'chat' }))).toBe('chat');
    expect(getMentionSourceProjectKey(undefined)).toBe('chat');
  });

  it('filters only current-project candidates and keeps all scope recency order', () => {
    const items = buildSessionMentionItems(
      [
        session({
          id: 'local-a',
          machineId: 'm1',
          lastMessageAt: 40,
          project: { kind: 'local', localProjectId: 'p1' },
        }),
        session({
          id: 'local-other-machine',
          machineId: 'm2',
          lastMessageAt: 30,
          project: { kind: 'local', localProjectId: 'p1' },
        }),
        session({ id: 'github', lastMessageAt: 20, repoFullName: 'org/repo' }),
        session({ id: 'chat', lastMessageAt: 10 }),
      ],
      null
    );

    expect(
      filterSessionMentionItemsByProject(items, 'local:m1:p1', 'current').map(
        (item) => item.sessionId
      )
    ).toEqual(['local-a']);
    expect(
      filterSessionMentionItemsByProject(items, 'local:m1:p1', 'all').map((item) => item.sessionId)
    ).toEqual(['local-a', 'local-other-machine', 'github', 'chat']);
    expect(
      filterSessionMentionItemsByProject(items, 'chat', 'current').map((item) => item.sessionId)
    ).toEqual(['chat']);
  });
});

describe('buildSessionMentionRewrites', () => {
  const range = (start: number, end: number, value = 'ses_7f3ac91b') => ({
    start,
    end,
    kind: 'session',
    value,
  });
  const expand = (text: string, mentions: Parameters<typeof buildSessionMentionRewrites>[1]) =>
    applyTextRewrites(text, buildSessionMentionRewrites(text, mentions)).text;

  it('replaces the range with an id-bearing instruction', () => {
    const text = 'look at @fix-ci please';
    expect(expand(text, [range(8, 15)])).toBe(
      'look at use lody mcp to query session[id: ses_7f3ac91b] history please'
    );
  });

  it('keeps the slug as the span label so the transcript can show it back', () => {
    const text = 'look at @fix-ci please';
    const [rewrite] = buildSessionMentionRewrites(text, [range(8, 15)]);
    // The label is what the user typed; the replacement is what the agent gets.
    expect(rewrite?.span).toEqual({ kind: 'session', label: 'fix-ci', target: 'ses_7f3ac91b' });
  });

  it('ignores ranges of other kinds', () => {
    const text = 'look at @src/a.ts';
    expect(
      buildSessionMentionRewrites(text, [{ start: 8, end: 17, kind: 'file', value: 'a' }])
    ).toEqual([]);
  });

  it('expands every range', () => {
    const text = '@fix-ci and @fix-ci';
    expect(expand(text, [range(0, 7), range(12, 19)])).toBe(
      'use lody mcp to query session[id: ses_7f3ac91b] history and use lody mcp to query session[id: ses_7f3ac91b] history'
    );
  });

  it('drops a range with no session id rather than emitting a broken instruction', () => {
    const text = 'look at @fix-ci';
    expect(buildSessionMentionRewrites(text, [range(8, 15, '')])).toEqual([]);
  });
});

describe('hydrateSessionMentionsFromText', () => {
  const ids = new Map([['fix-ci', 'ses_7f3ac91b']]);

  it('rebuilds ranges carrying the session id, not the slug', () => {
    const hydrated = hydrateSessionMentionsFromText('see @fix-ci now', ids);

    expect(hydrated.mentions).toEqual([
      { value: 'ses_7f3ac91b', start: 4, end: 11, kind: 'session' },
    ]);
    expect(hydrated.values).toEqual(['ses_7f3ac91b']);
  });

  it('ignores tokens it cannot resolve', () => {
    expect(hydrateSessionMentionsFromText('@unknown', new Map()).mentions).toEqual([]);
  });

  it('leaves a token the file source also claims to the file hydrator', () => {
    // Without the old `@session:` marker a slug and a path are the same shape,
    // so a collision has to resolve somewhere. Paths win.
    expect(
      hydrateSessionMentionsFromText('see @fix-ci now', ids, new Set(['fix-ci'])).mentions
    ).toEqual([]);
  });

  it('still hydrates a slug the file source does not know', () => {
    expect(
      hydrateSessionMentionsFromText('see @fix-ci now', ids, new Set(['src/a.ts'])).mentions
    ).toEqual([{ value: 'ses_7f3ac91b', start: 4, end: 11, kind: 'session' }]);
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

describe('hydration records the kind', () => {
  // Ranges are not persisted with a draft, so returning to a composer rebuilds
  // them from text. A rebuilt range with no `kind` is not merely missing its
  // icon: `buildSessionMentionRewrites` dispatches on `kind`, so a session
  // mention would silently stop expanding on the way to the agent.
  it('marks a rebuilt session range as a session', () => {
    const hydrated = hydrateSessionMentionsFromText(
      'see @fix-ci now',
      new Map([['fix-ci', 'ses_7f3ac91b']])
    );
    expect(hydrated.mentions).toEqual([
      { value: 'ses_7f3ac91b', start: 4, end: 11, kind: 'session' },
    ]);
  });

  it('still expands a rebuilt range, which a kindless one would not', () => {
    const text = 'see @fix-ci now';
    const { mentions } = hydrateSessionMentionsFromText(
      text,
      new Map([['fix-ci', 'ses_7f3ac91b']])
    );
    expect(applyTextRewrites(text, buildSessionMentionRewrites(text, mentions)).text).toBe(
      'see use lody mcp to query session[id: ses_7f3ac91b] history now'
    );
  });
});
