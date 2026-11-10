// @vitest-environment jsdom

// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Mention, MentionInput, useMentionContext } from '../src/ui/mention';

import type { Mention as MentionRange } from '../src/ui/mention/mention-root';
import {
  MentionTwoLevelMenuBody,
  useMentionCategoryActivation,
} from '../src/components/mentions/mention-two-level-menu';
import {
  getMentionViewCandidates,
  selectMentionMenuViewForTrigger,
  type MentionCandidate,
  type MentionCandidateDetail,
  type MentionCategory,
  type MentionMenuView,
} from '../src/components/mentions/mention-registry';
import { initI18n } from '../src/i18n';
import { composerIn } from './composer-test-utils';

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
  followHighlight = false,
}: {
  initialValue: string;
  categories: MentionCategory[];
  detail?: MentionCandidateDetail | null;
  followHighlight?: boolean;
}) {
  const [value, setValue] = React.useState(initialValue);
  const [mentions, setMentions] = React.useState<MentionRange[]>([]);
  const [selected, setSelected] = React.useState<string[]>([]);
  const view = selectMentionMenuViewForTrigger(categories, value[0] ?? '@', value.slice(1));

  return (
    <Mention
      trigger={value[0] === '/' || value[0] === '、' ? value[0] : '@'}
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
      {view ? <MenuBody view={view} detail={detail} followHighlight={followHighlight} /> : null}
    </Mention>
  );
}

function MenuBody({
  view,
  detail,
  followHighlight,
}: {
  view: MentionMenuView;
  detail?: MentionCandidateDetail | null;
  followHighlight: boolean;
}) {
  const { highlightedItem } = useMentionContext('MenuBody');
  const candidates = getMentionViewCandidates(view);
  const highlighted =
    candidates.find((candidate) => candidate.value === highlightedItem?.value) ?? candidates[0];
  return (
    <MentionTwoLevelMenuBody
      view={view}
      onBack={() => {}}
      showBack
      onCategoryNavigate={(category) => category.activation?.activate()}
      detail={followHighlight ? highlighted?.detail : detail}
    />
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
    const input = composerIn(container!);
    input.setSelectionRange(initialValue.length, initialValue.length);
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

  it('descends into a category without recording a mention', () => {
    render('@');

    act(() => latest.onMentionAdd?.('category:issue', 0));

    expect(latest.inputValue).toBe('@issue:');
    expect(latest.mentions).toEqual([]);
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

  it('renders a typed slash query as ranked rows with their sources', () => {
    const shortcuts: MentionCategory = {
      id: 'prompt_shortcut',
      namespace: 'shortcut',
      directTrigger: '/',
      label: 'Prompt Shortcuts',
      icon: 'prompt_shortcut',
      status: 'ready',
      getCandidates: () =>
        ['create-intro-video', 'videoer'].map((name) => ({
          value: `prompt-shortcut:${name}`,
          label: name,
          insertText: `/${name}`,
          kind: 'prompt_shortcut' as const,
          icon: 'prompt_shortcut' as const,
          title: `/${name}`,
        })),
    };
    const command: MentionCategory = {
      id: 'command',
      namespace: 'cmd',
      directTrigger: '/',
      label: 'Agent Commands',
      icon: 'command',
      status: 'ready',
      getCandidates: () => [
        {
          value: 'acp-command:video',
          label: 'video',
          insertText: '/video',
          kind: 'command',
          icon: 'command',
          title: '/video',
        },
      ],
    };

    render('/video', [shortcuts, command]);
    expect(rowTitles()).toEqual([
      '/videoAgent Commands',
      '/videoerPrompt Shortcuts',
      '/create-intro-videoPrompt Shortcuts',
    ]);

    const rows = container?.querySelectorAll<HTMLElement>('[data-slot="mention-item"]');
    act(() => rows?.[1]?.click());
    expect(latest.inputValue).toBe('/videoer ');
    expect(latest.mentions).toEqual([
      { value: 'prompt-shortcut:videoer', start: 0, end: 8, kind: 'prompt_shortcut' },
    ]);
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

  it.each(['click', 'Enter'] as const)(
    'keeps a scrolled Role reachable as hover opens and closes its detail, then selects by %s',
    (action) => {
      const categories: MentionCategory[] = [
        {
          id: 'issue',
          namespace: 'issue',
          label: 'Issues',
          icon: 'issue',
          status: 'ready',
          getCandidates: () =>
            Array.from({ length: 4 }, (_, index) => issueCandidate(index + 1, `Review ${index}`)),
        },
        {
          id: 'agent_role',
          namespace: 'role',
          label: 'Agent Roles',
          icon: 'agent_role',
          status: 'ready',
          getCandidates: () => [
            {
              value: 'reviewer-role',
              label: 'Reviewer',
              title: 'Reviewer',
              insertText: '@Reviewer',
              kind: 'agent_role',
              icon: 'agent_role',
              detail: { title: 'Reviewer', description: 'Review the changes.' },
            },
          ],
        },
      ];
      act(() =>
        root?.render(<Harness initialValue="@review" categories={categories} followHighlight />)
      );
      const input = container ? composerIn(container) : null;
      const rows = container?.querySelectorAll<HTMLElement>('[data-slot="mention-item"]');
      const issue = rows?.[3];
      const role = rows?.[4];
      if (!input || !issue || !role) throw new Error('Expected issue and Role candidates');
      const scroller = role.parentElement;
      if (!scroller) throw new Error('Expected candidate scroller');
      scroller.scrollTop = 240;
      input.setSelectionRange(7, 7);

      for (const row of [role, issue, role]) {
        act(() => {
          row.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
        });
        const currentRole = container?.querySelectorAll('[data-slot="mention-item"]')[4];
        expect(currentRole?.parentElement?.scrollTop).toBe(240);
        expect(currentRole).toBe(role);
        expect(row.hasAttribute('data-highlighted')).toBe(true);
        expect(Boolean(container?.querySelector('[data-mention-detail]'))).toBe(row === role);
      }

      act(() => {
        if (action === 'click') role.click();
        else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      expect(latest.inputValue).toBe('@Reviewer ');
      expect(latest.mentions).toEqual([
        { value: 'reviewer-role', start: 0, end: 9, kind: 'agent_role' },
      ]);
    }
  );

  it('says nothing matched instead of keeping the list', () => {
    render('@issue:zzz');

    expect(rowTitles()).toEqual([]);
    expect(container?.textContent).toContain('Nothing matches “zzz”');
  });
});
