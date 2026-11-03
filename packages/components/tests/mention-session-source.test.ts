// @vitest-environment jsdom

// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { applyTextRewrites, type SessionMeta } from '@lody/shared';

import {
  buildSessionMentionItems,
  buildSessionMentionRewrites,
  filterSessionMentionItemsByProject,
  getMentionSourceProjectKey,
  getSessionMentionProjectKey,
  hydrateSessionMentionsFromText,
  rememberSessionMentionSlugs,
  resolveSessionMentionIds,
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

describe('buildSessionMentionItems', () => {
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
});

describe('session mention project scope', () => {
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

  it('prefers the human title in the link label when supplied', () => {
    const text = 'look at @fix-ci please';
    const result = applyTextRewrites(
      text,
      buildSessionMentionRewrites(text, [range(8, 15)], {
        workspaceId: 'ws_1',
        items: [{ sessionId: 'ses_7f3ac91b', title: 'Fix CI' }],
      })
    ).text;
    expect(result).toBe('look at [@Fix CI](lody://session/ses_7f3ac91b?workspace=ws_1) please');
  });

  it('keeps the slug as the span label so the transcript can show it back', () => {
    const text = 'look at @fix-ci please';
    const [rewrite] = buildSessionMentionRewrites(text, [range(8, 15)]);
    // The label is what the user typed; the replacement is what the agent gets.
    expect(rewrite?.span).toEqual({ kind: 'session', label: 'fix-ci', target: 'ses_7f3ac91b' });
  });
});

describe('hydrateSessionMentionsFromText', () => {
  const ids = new Map([['fix-ci', 'ses_7f3ac91b']]);

  it('leaves a token the file source also claims to the file hydrator', () => {
    // Without the old `@session:` marker a slug and a path are the same shape,
    // so a collision has to resolve somewhere. Paths win.
    expect(
      hydrateSessionMentionsFromText('see @fix-ci now', ids, new Set(['fix-ci'])).mentions
    ).toEqual([]);
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
  it('still expands a rebuilt range, which a kindless one would not', () => {
    const text = 'see @fix-ci now';
    const { mentions } = hydrateSessionMentionsFromText(
      text,
      new Map([['fix-ci', 'ses_7f3ac91b']])
    );
    expect(applyTextRewrites(text, buildSessionMentionRewrites(text, mentions)).text).toBe(
      'see [@fix-ci](lody://session/ses_7f3ac91b) now'
    );
  });
});
