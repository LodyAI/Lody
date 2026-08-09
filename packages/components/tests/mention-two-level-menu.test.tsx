// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Mention, MentionInput, useMentionContext } from '../src/ui/mention';
import type { Mention as MentionRange } from '../src/ui/mention/mention-root';
import { MentionTwoLevelMenuBody } from '../src/components/mentions/mention-two-level-menu';
import {
  selectMentionMenuView,
  toSkillCandidate,
  type MentionCandidate,
  type MentionCandidateDetail,
  type MentionCategory,
} from '../src/components/mentions/mention-registry';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const latest: {
  inputValue: string;
  mentions: readonly MentionRange[];
  onMentionAdd: ((value: string, triggerIndex: number) => void) | null;
} = { inputValue: '', mentions: [], onMentionAdd: null };

function Probe() {
  const context = useMentionContext('Probe');
  latest.inputValue = context.inputValue;
  latest.mentions = context.mentions;
  latest.onMentionAdd = context.onMentionAdd;
  return null;
}

function issueCandidate(number: number, title: string): MentionCandidate {
  return {
    value: `#${number}`,
    label: String(number),
    insertText: `#${number}`,
    kind: 'issue',
    icon: 'issue',
    title,
    trailing: `#${number}`,
  };
}

function makeCategories(): MentionCategory[] {
  return [
    {
      id: 'file',
      namespace: 'file',
      label: 'Files',
      icon: 'file',
      status: 'ready',
      getCandidates: (term) =>
        [
          {
            value: 'src/',
            label: 'src/',
            insertText: '@src',
            navigateText: '@src/',
            kind: 'dir' as const,
            icon: 'dir' as const,
            title: 'src/',
            mono: true,
          },
        ].filter((entry) => entry.value.includes(term)),
    },
    {
      id: 'issue',
      namespace: 'issue',
      label: 'Issues',
      icon: 'issue',
      status: 'ready',
      getCandidates: (term) =>
        [issueCandidate(3312, 'Broken menu'), issueCandidate(3298, 'Slow switch')].filter((entry) =>
          entry.label.includes(term)
        ),
    },
  ];
}

function Harness({
  initialValue,
  categories,
  detail,
}: {
  initialValue: string;
  categories: MentionCategory[];
  detail?: MentionCandidateDetail | null;
}) {
  const [value, setValue] = React.useState(initialValue);
  const [mentions, setMentions] = React.useState<MentionRange[]>([]);
  const [selected, setSelected] = React.useState<string[]>([]);
  const view = selectMentionMenuView(categories, value.slice(1));

  return (
    <Mention
      defaultOpen
      inputValue={value}
      onInputValueChange={setValue}
      mentions={mentions}
      onMentionsChange={setMentions}
      value={selected}
      onValueChange={setSelected}
      onFilter={(options) => options}
      autoCloseOnEmpty={false}
    >
      <Probe />
      <MentionInput value={value} onChange={() => {}} />
      <MentionTwoLevelMenuBody view={view} onBack={() => {}} showBack detail={detail} />
    </Mention>
  );
}

describe('MentionTwoLevelMenuBody', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let originalRequestAnimationFrame: typeof requestAnimationFrame | undefined;

  beforeEach(() => {
    originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((callback) => {
      callback(0);
      return 0;
    }) as typeof requestAnimationFrame;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = undefined;
    container?.remove();
    container = undefined;
    if (originalRequestAnimationFrame) {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    }
    originalRequestAnimationFrame = undefined;
  });

  function render(
    initialValue: string,
    categories = makeCategories(),
    detail?: MentionCandidateDetail | null
  ) {
    act(() => {
      root?.render(<Harness initialValue={initialValue} categories={categories} detail={detail} />);
    });
    const input = container?.querySelector('textarea');
    if (!input) throw new Error('Expected mention textarea to render');
    act(() => {
      input.setSelectionRange(initialValue.length, initialValue.length);
    });
    return input;
  }

  function rowTitles() {
    return Array.from(container?.querySelectorAll('[data-slot="mention-item"]') ?? []).map((node) =>
      (node.textContent ?? '').trim()
    );
  }

  it('lists one row per category at the first level', () => {
    render('@');

    const titles = rowTitles();
    expect(titles.some((title) => title.startsWith('Files'))).toBe(true);
    expect(titles.some((title) => title.startsWith('Issues'))).toBe(true);
  });

  it('descends into a category without recording a mention', () => {
    render('@');

    act(() => latest.onMentionAdd?.('category:issue', 0));

    expect(latest.inputValue).toBe('@issue:');
    expect(latest.mentions).toEqual([]);
  });

  it('shows that category rows carry the drill-down text, not a commit', () => {
    render('@issue:');

    // Second level lists the category's own candidates.
    expect(rowTitles()).toEqual(['Broken menu#3312', 'Slow switch#3298']);
  });

  it('commits a candidate with its own insert text', () => {
    render('@issue:');

    act(() => latest.onMentionAdd?.('#3312', 0));

    // Reaching the issue through `@` still writes the GitHub form.
    expect(latest.inputValue).toBe('#3312 ');
    expect(latest.mentions).toEqual([{ value: '#3312', start: 0, end: 5, kind: 'issue' }]);
  });

  it('groups results by category when a bare term is typed', () => {
    render('@3312');

    const titles = rowTitles();
    expect(titles).toContain('Broken menu#3312');
    // Only the issue category matched, so the file group is absent.
    expect(titles.some((title) => title.startsWith('src/'))).toBe(false);
  });

  it('renders a category message instead of rows when the source cannot answer', () => {
    const categories = makeCategories();
    const issue = categories.find((entry) => entry.id === 'issue');
    if (!issue) throw new Error('expected issue category');
    issue.status = 'error';
    issue.message = 'Failed to load issues and PRs.';
    issue.getCandidates = vi.fn(() => []);

    render('@issue:', categories);

    expect(container?.textContent).toContain('Failed to load issues and PRs.');
    expect(rowTitles()).toEqual([]);
  });

  it('renders the detail panel beside the rows when one is supplied', () => {
    render('@issue:', makeCategories(), {
      title: 'code-collab-debug',
      badges: ['project', 'v2'],
      description: 'Diagnose Code Collab diffs.',
      rows: [{ label: 'Path', value: '.claude/skills/x/SKILL.md', mono: true }],
    });

    const text = container?.textContent ?? '';
    expect(text).toContain('code-collab-debug');
    expect(text).toContain('project');
    expect(text).toContain('Diagnose Code Collab diffs.');
    expect(text).toContain('.claude/skills/x/SKILL.md');
    // The rows are still there beside it.
    expect(rowTitles()).toEqual(['Broken menu#3312', 'Slow switch#3298']);
  });

  it('omits the detail panel when the candidate has none', () => {
    render('@issue:', makeCategories(), null);

    expect(container?.querySelector('dl')).toBeNull();
  });
});

describe('skill candidate detail', () => {
  const labels = { author: 'Author', path: 'Path', linksTo: 'Links to', symlink: 'symlink' };

  it('carries the skill metadata the old two-pane menu showed', () => {
    const candidate = toSkillCandidate(
      {
        token: 'code-collab-debug',
        dir: '.claude/skills',
        scope: 'project',
        skill: {
          name: 'Code Collab Debug',
          description: 'Diagnose Code Collab diffs.',
          relativePath: '.claude/skills/code-collab-debug/SKILL.md',
          version: '2',
          author: 'zx',
          isSymlink: true,
          symlinkTarget: '../shared/skill',
        },
      } as Parameters<typeof toSkillCandidate>[0],
      labels
    );

    expect(candidate.insertText).toBe('$code-collab-debug');
    expect(candidate.detail?.title).toBe('Code Collab Debug');
    expect(candidate.detail?.badges).toEqual(['project', 'v2', 'symlink']);
    expect(candidate.detail?.rows).toEqual([
      { label: 'Author', value: 'zx' },
      { label: 'Path', value: '.claude/skills/code-collab-debug/SKILL.md', mono: true },
      { label: 'Links to', value: '../shared/skill', mono: true },
    ]);
  });

  it('omits rows the skill does not have', () => {
    const candidate = toSkillCandidate(
      {
        token: 'plain',
        dir: '.claude/skills',
        scope: 'global',
        skill: { name: 'Plain', relativePath: 'a/SKILL.md' },
      } as Parameters<typeof toSkillCandidate>[0],
      labels
    );

    expect(candidate.detail?.badges).toEqual(['global']);
    expect(candidate.detail?.rows).toEqual([{ label: 'Path', value: 'a/SKILL.md', mono: true }]);
  });
});
