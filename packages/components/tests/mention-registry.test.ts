import { describe, expect, it, vi } from 'vitest';

import {
  buildCommandCandidates,
  buildIssuePrCandidates,
  getCategoryNavigateText,
  selectMentionMenuView,
  selectMentionMenuViewForTrigger,
  selectMentionViewActivations,
  toFileCandidate,
  toIssuePrCandidate,
  type MentionCandidate,
  type MentionCategory,
} from '../src/components/mentions/mention-registry';

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
    searchableTitle: title.toLowerCase(),
  };
}

describe('selectMentionMenuView', () => {
  it('keeps disabled categories visible without ranking or activating them through any trigger', () => {
    const skill = makeCategory('skill', 'skill', 'Skills', ['review']);
    skill.status = 'disabled';
    skill.message = 'Select a project and agent first';
    skill.directTrigger = '$';
    skill.activation = { sourceKey: 'skill', activate: vi.fn() };
    const index = selectMentionMenuView([skill], '');
    expect(index).toMatchObject({ level: 'categories', categories: [skill] });
    for (const view of [
      selectMentionMenuView([skill], 'review'),
      selectMentionMenuView([skill], 'skill:review'),
      selectMentionMenuViewForTrigger([skill], '$', 'review'),
    ]) {
      expect(selectMentionViewActivations(view, [skill])).toEqual([]);
      if (view?.level === 'aggregate') expect(view.groups).toEqual([]);
      if (view?.level === 'category') expect(view.candidates).toEqual([]);
    }
    expect(skill.getCandidates).not.toHaveBeenCalled();
  });
  it('shows the category list when nothing is typed after the trigger', () => {
    const file = makeCategory('file', 'file', 'Files', ['a.ts']);
    const issue = makeCategory('issue', 'issue', 'Issues', ['#1']);

    const view = selectMentionMenuView([file, issue], '');

    expect(view.level).toBe('categories');
    if (view.level !== 'categories') throw new Error('expected categories');
    expect(view.categories.map((entry) => entry.id)).toEqual(['file', 'issue']);
    // No ranking work is done for a menu that only lists categories.
    expect(file.getCandidates).not.toHaveBeenCalled();
    expect(issue.getCandidates).not.toHaveBeenCalled();
  });

  it('scopes to one category behind its namespace prefix', () => {
    const file = makeCategory('file', 'file', 'Files', ['a.ts']);
    const issue = makeCategory('issue', 'issue', 'Issues', ['3312', '3298']);

    const view = selectMentionMenuView([file, issue], 'issue:32');

    expect(view.level).toBe('category');
    if (view.level !== 'category') throw new Error('expected category');
    expect(view.category.id).toBe('issue');
    expect(view.term).toBe('32');
    expect(view.candidates.map((entry) => entry.value)).toEqual(['3298']);
    // Ranking the file index is the expensive one; a scoped query must not pay it.
    expect(file.getCandidates).not.toHaveBeenCalled();
  });

  it('treats an empty namespace prefix as the category with no term', () => {
    const issue = makeCategory('issue', 'issue', 'Issues', ['3312', '3298']);

    const view = selectMentionMenuView([issue], 'issue:');

    if (view.level !== 'category') throw new Error('expected category');
    expect(view.term).toBe('');
    expect(view.candidates).toHaveLength(2);
  });

  it('falls back to aggregate search for an unknown namespace', () => {
    const file = makeCategory('file', 'file', 'Files', ['nope:1']);

    const view = selectMentionMenuView([file], 'nope:1');

    expect(view.level).toBe('aggregate');
  });

  it('answers a bare term across every category and caps each group', () => {
    const file = makeCategory('file', 'file', 'Files', ['a1', 'a2', 'a3', 'a4', 'a5']);
    const issue = makeCategory('issue', 'issue', 'Issues', ['a9', 'b1']);

    const view = selectMentionMenuView([file, issue], 'a', { aggregateLimitPerCategory: 3 });

    if (view.level !== 'aggregate') throw new Error('expected aggregate');
    expect(view.term).toBe('a');
    expect(view.groups.map((group) => group.category.id)).toEqual(['file', 'issue']);
    expect(view.groups[0]?.candidates).toHaveLength(3);
    expect(view.groups[1]?.candidates.map((entry) => entry.value)).toEqual(['a9']);
  });

  it('offers categories whose own name matches the term', () => {
    const file = makeCategory('file', 'file', 'Files', []);
    const issue = makeCategory('issue', 'issue', 'Issues', []);

    const view = selectMentionMenuView([file, issue], 'iss');

    if (view.level !== 'aggregate') throw new Error('expected aggregate');
    expect(view.categories.map((entry) => entry.id)).toEqual(['issue']);
    // Nothing matched inside the categories, so there are no result groups.
    expect(view.groups).toEqual([]);
  });

  it('builds the drill-down text a category row inserts', () => {
    expect(getCategoryNavigateText({ namespace: 'issue' })).toBe('@issue:');
  });

  it('opens skills directly from the retained $ trigger', () => {
    const skill = makeCategory('skill', 'skill', 'Skills', ['review']);
    skill.directTrigger = '$';

    const view = selectMentionMenuViewForTrigger([skill], '$', 'rev');

    expect(view?.level).toBe('category');
    if (view?.level !== 'category') throw new Error('expected category');
    expect(view.category.id).toBe('skill');
    expect(view.candidates.map((entry) => entry.value)).toEqual(['review']);
  });
});

describe('candidate insertion semantics', () => {
  it('lets a directory descend but commits it without the trailing slash', () => {
    const candidate = toFileCandidate({
      kind: 'dir',
      path: 'src/components',
      token: 'src/components/',
      searchable: 'src/components/',
    });

    expect(candidate.navigateText).toBe('@src/components/');
    expect(candidate.insertText).toBe('@src/components');
    expect(candidate.kind).toBe('dir');
  });

  it('commits a file with no navigation step', () => {
    const candidate = toFileCandidate({
      kind: 'file',
      path: 'src/a.ts',
      token: 'src/a.ts',
      searchable: 'src/a.ts',
    });

    expect(candidate.navigateText).toBeUndefined();
    expect(candidate.insertText).toBe('@src/a.ts');
    expect(candidate.kind).toBe('file');
  });

  it('keeps the GitHub number form for issues and PRs', () => {
    const candidate = toIssuePrCandidate(makeIssuePrSuggestion(3312, 'issue', 'Broken menu'));

    // The prompt an agent receives is unchanged by the `@` entry point.
    expect(candidate.insertText).toBe('#3312');
    expect(candidate.label).toBe('3312');
    expect(candidate.title).toBe('Broken menu');
  });

  it('keeps the slash form for commands', () => {
    const [candidate] = buildCommandCandidates([{ name: 'review', description: 'Review' }], '');

    expect(candidate?.insertText).toBe('/review');
  });
});

describe('buildIssuePrCandidates', () => {
  it('ranks each type over its own slice so neither starves the other', () => {
    // The shared ranking caps its result set, so ranking the merged list first
    // would let a long issue list push every PR out of the PR category.
    const suggestions = [
      ...Array.from({ length: 60 }, (_, index) =>
        makeIssuePrSuggestion(index + 1, 'issue', `issue ${index + 1}`)
      ),
      makeIssuePrSuggestion(900, 'pr', 'first pr'),
      makeIssuePrSuggestion(901, 'pr', 'second pr'),
    ];

    const scopedTo = (type: 'issue' | 'pr') => suggestions.filter((item) => item.type === type);
    const prs = buildIssuePrCandidates(scopedTo('pr'), '', null);
    const issues = buildIssuePrCandidates(scopedTo('issue'), '', null);

    expect(prs.map((entry) => entry.value)).toEqual(['#900', '#901']);
    expect(issues.every((entry) => entry.kind === 'issue')).toBe(true);
    expect(issues.length).toBeGreaterThan(0);
  });
});
