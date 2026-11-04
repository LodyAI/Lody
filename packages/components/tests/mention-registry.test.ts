import { describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';
import type { PromptShortcutIndexEntry } from '@lody/shared/prompt-shortcuts';

import {
  buildCommandCandidates,
  buildSkillCandidates,
  getMentionViewCandidates,
  selectMentionMenuView,
  selectMentionMenuViewForTrigger,
  type MentionCandidate,
  type MentionCategory,
} from '../src/components/mentions/mention-registry';

import { buildSkillMentionItems } from '../src/components/mentions/mention-skill-source';
import { rankSlashMatch } from '../src/lib/command-slash-search';
import { selectPromptShortcutCandidates } from '../src/components/mentions/mention-prompt-shortcut-source';

function makeCandidate(value: string): MentionCandidate {
  return {
    value,
    label: value,
    insertText: `@${value}`,
    kind: 'file',
    icon: 'file',
    title: value,
  };
}

function makeCategory(
  id: MentionCategory['id'],
  namespace: string,
  label: string,
  candidates: string[]
): MentionCategory & { getCandidates: ReturnType<typeof vi.fn> } {
  const getCandidates = vi.fn((term: string) =>
    candidates.filter((entry) => entry.includes(term)).map(makeCandidate)
  );
  return {
    id,
    namespace,
    label,
    icon: 'file',
    status: 'ready',
    getCandidates,
  };
}

function makeIssuePrSuggestion(number: number, type: 'issue' | 'pr', title: string) {
  return {
    number,
    title,
    type,
    token: `#${number}`,
    label: String(number),
    searchableNumber: String(number),
  };
}

describe('selectMentionMenuView', () => {
  it.each(['/', '、'])('routes %s to commands and shortcuts only', (trigger) => {
    const command = makeCategory('command', 'command', 'Commands', []);
    command.directTrigger = '/';
    command.getCandidates = vi.fn((term: string) =>
      buildCommandCandidates([{ name: 'review', description: 'Review' }], term)
    );
    const shortcut = makeCategory('prompt_shortcut', 'shortcut', 'Shortcuts', ['review-template']);
    shortcut.directTrigger = '/';
    const file = makeCategory('file', 'file', 'Files', ['review.ts']);

    const view = selectMentionMenuViewForTrigger([command, shortcut, file], trigger, 'rev');
    if (view?.level !== 'aggregate') throw new Error('expected aggregate');
    expect(view.groups.map((group) => group.category.id)).toEqual(['command', 'prompt_shortcut']);
    expect(
      view.groups.flatMap((group) => group.candidates.map((candidate) => candidate.insertText))
    ).toEqual(['/review', '@review-template']);
  });

  it.each(['/', '、'])('ranks typed %s results across command sources', (trigger) => {
    const shortcut: MentionCategory = {
      id: 'prompt_shortcut',
      namespace: 'shortcut',
      directTrigger: '/',
      label: 'Prompt Shortcuts',
      icon: 'prompt_shortcut',
      status: 'ready',
      getCandidates: () =>
        ['create-intro-video', 'videoer', 'video'].map((name) => ({
          value: `prompt-shortcut:${name}`,
          label: name,
          insertText: `/${name}`,
          kind: 'prompt_shortcut' as const,
          icon: 'prompt_shortcut' as const,
          title: `/${name}`,
          disabled: name === 'video',
          slashRank: rankSlashMatch({ token: name }, 'video')!,
        })),
    };
    const command: MentionCategory = {
      id: 'command',
      namespace: 'cmd',
      directTrigger: '/',
      label: 'Agent Commands',
      icon: 'command',
      status: 'ready',
      getCandidates: (term, limit) =>
        buildCommandCandidates([{ name: 'video', description: 'Record a video' }], term, limit),
    };

    const view = selectMentionMenuViewForTrigger([shortcut, command], trigger, 'video');
    if (view?.level !== 'aggregate') throw new Error('expected aggregate');
    expect(getMentionViewCandidates(view).map((candidate) => candidate.insertText)).toEqual([
      '/video',
      '/videoer',
      '/create-intro-video',
      '/video',
    ]);

    const bare = selectMentionMenuViewForTrigger([shortcut, command], trigger, '');
    if (bare?.level !== 'aggregate') throw new Error('expected aggregate');
    expect(bare.rankedCandidates).toBeUndefined();
    expect(bare.groups.map((group) => group.category.id)).toEqual(['prompt_shortcut', 'command']);
  });
});

describe('skill category filtering', () => {
  // A machine's system skills: every path runs through `~/.codex/skills/.system`.
  const items = buildSkillMentionItems([
    {
      scope: 'system',
      dir: '~/.codex/skills/.system',
      skills: [
        'imagegen',
        'openai-docs',
        'plugin-creator',
        'review-agent',
        'skill-creator',
        'skill-installer',
      ].map((name) => ({
        id: name,
        name,
        relativePath: `~/.codex/skills/.system/${name}/SKILL.md`,
        isSymlink: false,
      })),
    },
  ]);
  const labels = {
    author: 'Author',
    path: 'Path',
    linksTo: 'Links to',
    symlink: 'symlink',
    scope: { project: 'Project', global: 'Global', system: 'System' },
  };
  const skills: MentionCategory = {
    id: 'skill',
    namespace: 'skill',
    directTrigger: '$',
    label: 'Skills',
    icon: 'skill',
    status: 'ready',
    getCandidates: (term, limit) => buildSkillCandidates(items, term, null, labels, limit),
  };

  it('answers a term that names no skill with no rows, not the whole list', () => {
    // `sy` is in `.system`, which every one of these paths shares.
    for (const view of [
      selectMentionMenuView([skills], 'skill:sy'),
      selectMentionMenuViewForTrigger([skills], '$', 'sy'),
    ]) {
      if (view?.level !== 'category') throw new Error('expected the skill level');
      expect(view.candidates).toEqual([]);
    }
  });

  it('matches the skill, not the skills directory around it', () => {
    const view = selectMentionMenuView([skills], 'skill:skill');
    if (view.level !== 'category') throw new Error('expected the skill level');
    expect(view.candidates.map((candidate) => candidate.title)).toEqual([
      'skill-creator',
      'skill-installer',
    ]);
  });
});

describe('Prompt Shortcut discovery', () => {
  const translate = ((_: string, fallback: string) => fallback) as TFunction;
  const context = { workspaceId: 'workspace-1', userId: 'user-1', scope: {} };

  function shortcut(
    slug: string,
    overrides: Partial<PromptShortcutIndexEntry> = {}
  ): PromptShortcutIndexEntry {
    return {
      v: 1,
      id: slug,
      workspaceId: context.workspaceId,
      ownerUserId: context.userId,
      visibility: 'private',
      name: slug,
      slug,
      scope: {},
      revision: 'revision-1',
      createdAt: 0,
      updatedAt: 0,
      bodyDocId: `body-${slug}`,
      dependencySummary: [],
      ...overrides,
    };
  }

  it('ranks visible, executable shortcuts while retaining only an unavailable exact match', () => {
    const entries = [
      shortcut('create-intro-video'),
      shortcut('videoer'),
      shortcut('video', { scope: { machineId: 'another-machine' } }),
      shortcut('video-remote', { scope: { machineId: 'another-machine' } }),
      shortcut('video-private', { ownerUserId: 'another-user' }),
      shortcut('video-foreign', { workspaceId: 'another-workspace' }),
    ];

    const candidates = selectPromptShortcutCandidates({ entries, context }, 'VIDEO', translate);

    expect(candidates.map((candidate) => candidate.insertText)).toEqual([
      '/videoer',
      '/create-intro-video',
      '/video',
    ]);
    expect(candidates.map((candidate) => candidate.disabled)).toEqual([false, false, true]);
    expect(candidates[2]?.disabledReason).toBe('Requires a different machine.');
  });
});

it('keeps pending and failed sources visible in aggregate search without stale candidates', () => {
  const file = makeCategory('file', 'file', 'Files', []);
  for (const status of ['loading', 'error'] as const) {
    file.status = status;
    const view = selectMentionMenuView([file], 'composer');
    expect(view.level).toBe('aggregate');
    if (view.level !== 'aggregate') throw new Error('Expected aggregate search');
    expect(view.groups).toEqual([{ category: file, candidates: [] }]);
  }
  file.status = 'ready';
  const view = selectMentionMenuView([file], 'composer');
  expect(view.level === 'aggregate' && view.groups).toEqual([]);
});
