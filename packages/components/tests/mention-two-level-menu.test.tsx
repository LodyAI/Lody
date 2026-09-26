// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Mention, MentionContent, MentionInput, useMentionContext } from '../src/ui/mention';
import type { Mention as MentionRange } from '../src/ui/mention/mention-root';
import {
  matchedRuns,
  MentionTwoLevelMenuBody,
  splitPathTail,
  useMentionCategoryActivation,
} from '../src/components/mentions/mention-two-level-menu';
import {
  selectMentionMenuView,
  selectMentionMenuViewForTrigger,
  toSkillCandidate,
  type MentionCandidate,
  type MentionCandidateDetail,
  type MentionCategory,
} from '../src/components/mentions/mention-registry';
import { initI18n } from '../src/i18n';

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
      <MentionTwoLevelMenuBody
        view={view}
        onBack={() => {}}
        showBack
        onCategoryNavigate={(category) => category.activation?.activate()}
        detail={detail}
      />
    </Mention>
  );
}

function ActivationHarness({
  open,
  search,
  categories,
  navigateTo,
}: {
  open: boolean;
  search: string;
  categories: MentionCategory[];
  navigateTo?: string;
}) {
  // Derived exactly as MentionTwoLevelMenu does, so the harness cannot pass on
  // a view the real menu would never produce.
  const view = open ? selectMentionMenuViewForTrigger(categories, '@', search) : null;
  const activateCategory = useMentionCategoryActivation(open, view, categories);
  React.useEffect(() => {
    if (!navigateTo) return;
    const category = categories.find((entry) => entry.id === navigateTo);
    if (category) activateCategory(category);
  }, [activateCategory, categories, navigateTo]);
  return null;
}

/** The shared-source pair the menu must activate once: Issues and PRs. */
function makeIssuePrActivationCategories() {
  const activate = vi.fn();
  const activation = { sourceKey: 'issuePr' as const, activate };
  const categories = makeCategories();
  const issue = categories.find((category) => category.id === 'issue');
  if (!issue) throw new Error('makeCategories must include the issue category');
  issue.activation = activation;
  categories.push({
    id: 'pr',
    namespace: 'pr',
    label: 'Pull Requests',
    icon: 'pr',
    status: 'ready',
    activation,
    getCandidates: () => [],
  });
  return { categories, activate };
}

describe('MentionTwoLevelMenuBody', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let originalRequestAnimationFrame: typeof requestAnimationFrame | undefined;

  beforeEach(async () => {
    // The menu's copy interpolates (a typed term, a category name).
    await initI18n('en');
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

  function renderActivation(
    open: boolean,
    search: string,
    categories: MentionCategory[],
    navigateTo?: string
  ) {
    act(() => {
      root?.render(
        <ActivationHarness
          open={open}
          search={search}
          categories={categories}
          navigateTo={navigateTo}
        />
      );
    });
  }

  function rowTitles() {
    return Array.from(container?.querySelectorAll('[data-slot="mention-item"]') ?? []).map((node) =>
      (node.textContent ?? '').trim()
    );
  }

  it.each(['click', 'Enter', 'Tab', 'direct'] as const)(
    'shows disabled role reasons and blocks %s selection',
    (action) => {
      const candidate: MentionCandidate = {
        value: 'offline-role',
        label: 'Offline',
        insertText: '@Offline',
        kind: 'agent_role',
        icon: 'agent_role',
        title: 'Offline Reviewer',
        disabled: true,
        subtitle: 'Unavailable: its machine is offline',
      };
      const categories: MentionCategory[] = [
        {
          id: 'agent_role',
          namespace: 'role',
          label: 'Agent Roles',
          icon: 'agent_role',
          status: 'ready',
          getCandidates: () => [candidate],
        },
      ];
      const input = render('@Offline', categories);
      const row = container?.querySelector<HTMLElement>('[data-disabled]');
      expect(row?.textContent).toContain('Unavailable: its machine is offline');
      expect(row?.getAttribute('aria-disabled')).toBe('true');
      act(() => {
        if (action === 'click') row?.click();
        else if (action === 'direct') latest.onMentionAdd?.('offline-role', 0);
        else input.dispatchEvent(new KeyboardEvent('keydown', { key: action, bubbles: true }));
      });
      expect(latest.mentions).toEqual([]);
      expect(latest.inputValue).toBe('@Offline');
    }
  );

  it('keeps a wrapped disabled reason inside its row', () => {
    const candidate: MentionCandidate = {
      value: 'remote-role',
      label: 'Remote Reviewer',
      insertText: '@Remote-Reviewer',
      kind: 'agent_role',
      icon: 'agent_role',
      title: 'Remote Reviewer',
      disabled: true,
      subtitle: 'Unavailable: this workspace requires a role on the same machine',
    };
    const categories: MentionCategory[] = [
      {
        id: 'agent_role',
        namespace: 'role',
        label: 'Agent Roles',
        icon: 'agent_role',
        status: 'ready',
        getCandidates: () => [candidate],
      },
    ];

    render('@Remote', categories);

    const row = container?.querySelector<HTMLElement>('[data-disabled]');
    expect(row).not.toBeNull();
    expect(getComputedStyle(row!).flexShrink).toBe('0');
  });

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

  it('activates a lazy source while navigating into its category', () => {
    const { categories, activate } = makeIssuePrActivationCategories();
    render('@', categories);
    const issuesRow = Array.from(
      container?.querySelectorAll<HTMLElement>('[data-slot="mention-item"]') ?? []
    ).find((item) => item.textContent?.includes('Issues'));
    if (!issuesRow) throw new Error('Issues category row missing');

    act(() => issuesRow.click());

    expect(activate).toHaveBeenCalledOnce();
    expect(latest.inputValue).toBe('@issue:');
    expect(latest.mentions).toEqual([]);
  });

  it('shows that category rows carry the drill-down text, not a commit', () => {
    render('@issue:');

    // Second level lists the category's own candidates.
    expect(rowTitles()).toEqual(['Broken menu#3312', 'Slow switch#3298']);
  });

  it('groups category scope options separately from back navigation', () => {
    const selectAll = vi.fn();
    const categories = makeCategories();
    const issue = categories.find((entry) => entry.id === 'issue');
    if (!issue) throw new Error('expected issue category');
    issue.header = {
      ariaLabel: 'Session project scope',
      options: [
        { label: 'Current project', selected: true, onSelect: vi.fn() },
        { label: 'All projects', selected: false, onSelect: selectAll },
      ],
    };

    render('@issue:', categories);

    const scope = container?.querySelector('[role="group"][aria-label="Session project scope"]');
    const buttons = Array.from(scope?.querySelectorAll('button') ?? []);
    expect(buttons.map((button) => button.textContent)).toEqual([
      'Current project',
      'All projects',
    ]);
    expect(buttons[0]?.getAttribute('aria-pressed')).toBe('true');
    expect(buttons[1]?.getAttribute('aria-pressed')).toBe('false');

    act(() => buttons[1]?.click());
    expect(selectAll).toHaveBeenCalledOnce();
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
      meta: ['project', 'v2'],
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
    // The pane is beside the rows, not one of them: it cannot be highlighted or picked.
    const pane = container?.querySelector('[data-mention-detail]');
    expect(pane?.textContent).toContain('Diagnose Code Collab diffs.');
    expect(pane?.closest('[data-slot="mention-item"]')).toBeNull();
  });

  it('states when a session was last active', () => {
    const categories = makeCategories();
    categories.push({
      id: 'session',
      namespace: 'session',
      label: 'Sessions',
      icon: 'session',
      status: 'ready',
      getCandidates: () => [
        {
          value: 'session-1',
          label: 'parser-work',
          insertText: '@parser-work',
          kind: 'session',
          icon: 'session',
          title: 'Parser work',
          // Half an hour clear of the boundary, so the label cannot tick over.
          activityAt: Date.now() - 150 * 60_000,
        },
      ],
    });

    render('@session:', categories);
    expect(rowTitles()).toEqual(['Parser work2h']);
  });

  it('marks a folder as a row that opens', () => {
    render('@file:');
    const folder = container?.querySelector('[data-slot="mention-item"]');
    expect(folder?.querySelector('.lucide-chevron-right')).not.toBeNull();
  });

  it('gives a row that inserts no opening mark', () => {
    render('@issue:');
    const issue = container?.querySelector('[data-slot="mention-item"]');
    expect(issue?.querySelector('.lucide-chevron-right')).toBeNull();
  });

  it('says nothing matched instead of keeping the list', () => {
    render('@issue:zzz');

    expect(rowTitles()).toEqual([]);
    expect(container?.textContent).toContain('Nothing matches “zzz”');
  });

  it("drops a row's glyph when it only repeats the level's heading", () => {
    // Every issue row would print the Issues glyph under "Issues".
    render('@issue:');
    const issue = container?.querySelector('[data-slot="mention-item"]');
    expect(issue?.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it('keeps a glyph that says something about its own row', () => {
    // A folder is not a file: the Files level keeps the row's mark.
    render('@file:');
    const folder = container?.querySelector('[data-slot="mention-item"]');
    expect(folder?.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it('omits the detail panel when the candidate has none', () => {
    render('@issue:', makeCategories(), null);

    expect(container?.querySelector('dl')).toBeNull();
  });

  it('does not activate lazy sources from the first-level category index', () => {
    const { categories, activate } = makeIssuePrActivationCategories();

    renderActivation(true, '', categories);

    expect(activate).not.toHaveBeenCalled();
  });

  it('activates the source for a scoped category', () => {
    const { categories, activate } = makeIssuePrActivationCategories();

    renderActivation(true, 'issue:', categories);

    expect(activate).toHaveBeenCalledOnce();
  });

  it('activates a shared source only once per menu-open cycle', () => {
    const { categories, activate } = makeIssuePrActivationCategories();

    renderActivation(true, 'issue:', categories);
    renderActivation(true, 'pr:', categories);

    expect(activate).toHaveBeenCalledOnce();

    renderActivation(false, '', categories);
    renderActivation(true, 'pr:', categories);
    expect(activate).toHaveBeenCalledTimes(2);
  });

  it('deduplicates synchronous navigation and the destination-view fallback', () => {
    const { categories, activate } = makeIssuePrActivationCategories();

    renderActivation(true, '', categories, 'issue');
    renderActivation(true, 'issue:', categories);

    expect(activate).toHaveBeenCalledOnce();
  });

  it('activates a source whose callback identity changed, keyed by its source', () => {
    const { categories } = makeIssuePrActivationCategories();
    const rebuilt = vi.fn();
    // `refresh` is a `useCallback`; a new identity for the same source must not
    // look like a second source to activate.
    for (const category of categories) {
      if (category.activation) category.activation = { sourceKey: 'issuePr', activate: rebuilt };
    }

    renderActivation(true, 'issue:', categories);
    for (const category of categories) {
      if (category.activation) category.activation = { sourceKey: 'issuePr', activate: rebuilt };
    }
    renderActivation(true, 'pr:', categories);

    expect(rebuilt).toHaveBeenCalledOnce();
  });
});

describe('skill candidate detail', () => {
  const labels = {
    author: 'Author',
    path: 'Path',
    linksTo: 'Links to',
    symlink: 'symlink',
    scope: { project: 'Project', global: 'Global', system: 'System' },
  };

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
    expect(candidate.detail?.meta).toEqual(['Project', 'v2', 'symlink']);
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

    expect(candidate.detail?.meta).toEqual(['Global']);
    expect(candidate.detail?.rows).toEqual([{ label: 'Path', value: 'a/SKILL.md', mono: true }]);
  });
});

describe('splitPathTail', () => {
  it('keeps the file and its folder whole, and lets the folders before give way', () => {
    expect(splitPathTail('~/.codex/skills/.system/imagegen/SKILL.md')).toEqual({
      head: '~/.codex/skills/.system/',
      tail: 'imagegen/SKILL.md',
    });
  });

  it('keeps only the file when its folder would make the tail too long', () => {
    expect(splitPathTail('.claude/skills/a-very-long-skill-folder-name-indeed/SKILL.md')).toEqual({
      head: '.claude/skills/a-very-long-skill-folder-name-indeed/',
      tail: 'SKILL.md',
    });
  });

  it('leaves a bare name alone', () => {
    expect(splitPathTail('SKILL.md')).toEqual({ head: '', tail: 'SKILL.md' });
  });
});

describe('matchedRuns', () => {
  it('lights the letters the term matched, in order', () => {
    expect(matchedRuns('mention-root.tsx', 'mroot')).toEqual([
      { text: 'm', matched: true },
      { text: 'ention-', matched: false },
      { text: 'root', matched: true },
      { text: '.tsx', matched: false },
    ]);
  });

  it('matches a path term by its last segment, since a file row shows the name', () => {
    expect(matchedRuns('registry.ts', 'mentions/reg')?.[0]).toEqual({
      text: 'reg',
      matched: true,
    });
  });

  it('claims nothing when the title is not where the term matched', () => {
    // An issue found by its number keeps its title whole.
    expect(matchedRuns('Broken menu', '3312')).toBeNull();
    expect(matchedRuns('Broken menu', '')).toBeNull();
  });
});

describe('composer placement', () => {
  // jsdom lays nothing out, so the composer's frame states where it is. The
  // window is jsdom's 1024x768.
  let frameTop = 0;
  const FRAME_HEIGHT = 100;
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let restoreRect: (() => void) | undefined;

  beforeEach(() => {
    const original = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (this.hasAttribute('data-mention-frame')) {
        return DOMRect.fromRect({ x: 200, y: frameTop, width: 600, height: FRAME_HEIGHT });
      }
      return original.call(this);
    };
    restoreRect = () => {
      HTMLElement.prototype.getBoundingClientRect = original;
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = undefined;
    container?.remove();
    container = undefined;
    restoreRect?.();
  });

  function Composer({
    open,
    rows,
    side,
  }: {
    open: boolean;
    rows: number;
    side?: 'top' | 'bottom';
  }) {
    return (
      <div data-mention-frame="">
        <Mention
          open={open}
          inputValue="@"
          onInputValueChange={() => {}}
          mentions={[]}
          onMentionsChange={() => {}}
          value={[]}
          onValueChange={() => {}}
          onFilter={(options) => options}
          autoCloseOnEmpty={false}
        >
          <MentionInput value="@" onChange={() => {}} />
          <MentionContent positionAnchor="composer" side={side} sideOffset={8}>
            {Array.from({ length: rows }, (_, index) => (
              <div key={index}>row {index}</div>
            ))}
          </MentionContent>
        </Mention>
      </div>
    );
  }

  function show(open: boolean, rows = 2, side?: 'top' | 'bottom') {
    act(() => root?.render(<Composer open={open} rows={rows} side={side} />));
  }

  /** The popup's height cap: the room on the side it chose, less the gap. */
  function cap() {
    return document.querySelector<HTMLElement>('[data-slot="mention-content"]')?.style.maxHeight;
  }

  it('opens above a composer with room there, capped to that room', () => {
    frameTop = 600;
    show(true);
    // 600 above the frame, less the 16px window margin and the 8px gap.
    expect(cap()).toBe('576px');
  });

  it('keeps its side through a level change and a moved composer', async () => {
    frameTop = 600;
    show(true, 2);
    show(true, 9);
    expect(cap()).toBe('576px');

    // The composer rises to the top; the open menu stays above it rather than
    // flipping, and only its cap follows the room left there.
    frameTop = 40;
    await act(() => window.dispatchEvent(new Event('resize')));
    expect(cap()).toBe('16px');
  });

  it('opens below only when there is no room above, choosing again on each open', () => {
    frameTop = 600;
    show(true);
    show(false);

    frameTop = 40;
    show(true);
    // 768 - 140 below the frame, less the window margin and the gap.
    expect(cap()).toBe('604px');
  });

  it('keeps an explicit side even when the room below is larger', () => {
    // 24px above the frame, 612px below: the room pick would open it below.
    frameTop = 40;
    show(true, 2, 'top');
    // Pinned above, capped to the 24px room there less the gap.
    expect(cap()).toBe('16px');
  });
});
