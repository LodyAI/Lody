import type { Meta, StoryObj } from '@storybook/react';
import { Mention, MentionInput } from '@/ui/mention';
import { MentionTwoLevelMenuBody } from '@/components/mentions/mention-two-level-menu';
import {
  selectMentionMenuView,
  toCommandCandidate,
  toFileCandidate,
  toIssuePrCandidate,
  toSkillCandidate,
  type MentionCandidate,
  type MentionCategory,
} from '@/components/mentions/mention-registry';

/* The menu body only renders inside a <Mention> root (its rows read the mention
   context). The harness mounts a forced-open root over a small textarea and
   renders the body directly, so every level and state is screenshot-verifiable
   without floating-ui placement noise or a live composer + project.

   Candidates come from the real registry mappers, so a story breaks if the
   insert-text or detail mapping drifts. */

const SKILL_LABELS = {
  author: 'Author',
  path: 'Path',
  linksTo: 'Links to',
  symlink: 'symlink',
};

const FILES: MentionCandidate[] = [
  toFileCandidate({
    kind: 'dir',
    path: 'src/components/mentions',
    token: 'src/components/mentions/',
    searchable: 'src/components/mentions/',
  }),
  toFileCandidate({
    kind: 'file',
    path: 'src/ui/mention/mention-root.tsx',
    token: 'src/ui/mention/mention-root.tsx',
    searchable: 'src/ui/mention/mention-root.tsx',
  }),
  toFileCandidate({
    kind: 'file',
    path: 'src/components/mentions/mention-registry.ts',
    token: 'src/components/mentions/mention-registry.ts',
    searchable: 'src/components/mentions/mention-registry.ts',
  }),
];

const ISSUES: MentionCandidate[] = [
  toIssuePrCandidate({
    number: 3312,
    title: 'Mention menu cannot be scrolled on mobile',
    type: 'issue',
    token: '#3312',
    label: '3312',
    searchableNumber: '3312',
    searchableTitle: 'mention menu cannot be scrolled on mobile',
  }),
  toIssuePrCandidate({
    number: 3298,
    title: 'Switching sessions janks the composer',
    type: 'issue',
    token: '#3298',
    label: '3298',
    searchableNumber: '3298',
    searchableTitle: 'switching sessions janks the composer',
  }),
];

const SKILLS: MentionCandidate[] = [
  toSkillCandidate(
    {
      token: 'code-collab-debug',
      dir: '.claude/skills',
      scope: 'project',
      skill: {
        id: 'a',
        name: 'Code Collab Debug',
        description:
          'Diagnose Code Collab diff, turn-history, All Changes, Loro frontiers and Streams bootstrap issues.',
        version: '1.2.0',
        author: 'loro-dev',
        relativePath: '.claude/skills/code-collab-debug/SKILL.md',
        isSymlink: false,
      },
    },
    SKILL_LABELS
  ),
  toSkillCandidate(
    {
      token: 'kill-ai-slop',
      dir: '~/.claude/skills',
      scope: 'global',
      skill: {
        id: 'b',
        name: 'Kill AI Slop',
        description: 'Find and remove the generic, machine-default tics of vibe-coded products.',
        relativePath: '~/.claude/skills/kill-ai-slop/SKILL.md',
        isSymlink: true,
        symlinkTarget: '~/dotfiles/skills/kill-ai-slop',
      },
    },
    SKILL_LABELS
  ),
];

const COMMANDS: MentionCandidate[] = [
  toCommandCandidate({ name: 'review', description: 'Review the changes on this branch' }),
  toCommandCandidate({ name: 'compact', description: 'Compact the conversation context' }),
];

function category(
  id: MentionCategory['id'],
  namespace: string,
  label: string,
  hint: string,
  icon: MentionCategory['icon'],
  candidates: MentionCandidate[],
  overrides?: Partial<MentionCategory>
): MentionCategory {
  return {
    id,
    namespace,
    label,
    hint,
    icon,
    status: 'ready',
    getCandidates: (term) =>
      candidates.filter((candidate) =>
        `${candidate.title} ${candidate.label}`.toLowerCase().includes(term.toLowerCase())
      ),
    ...overrides,
  };
}

const CATEGORIES: MentionCategory[] = [
  category('file', 'file', 'Files', 'Files and directories in this project', 'file', FILES),
  category('issue', 'issue', 'Issues', 'Open issues in this repository', 'issue', ISSUES),
  category('pr', 'pr', 'Pull Requests', 'Open pull requests in this repository', 'pr', []),
  category('skill', 'skill', 'Skills', 'Project and global skills for this agent', 'skill', SKILLS),
  category(
    'command',
    'cmd',
    'Commands',
    'Agent commands; replaces the whole prompt',
    'command',
    COMMANDS
  ),
];

type HarnessProps = {
  /** Text after `@`, exactly what the composer would hold. */
  search: string;
  categories?: MentionCategory[];
  /** Desktop shows a side panel for the highlighted candidate; mobile does not. */
  withDetail?: boolean;
};

function Harness({ search, categories = CATEGORIES, withDetail = true }: HarnessProps) {
  const view = selectMentionMenuView(categories, search);
  const candidates =
    view.level === 'category'
      ? view.candidates
      : view.level === 'aggregate'
        ? view.groups.flatMap((group) => group.candidates)
        : [];
  const detail = withDetail ? (candidates[0]?.detail ?? null) : null;
  const inputValue = `@${search}`;

  return (
    <div className="h-[460px] w-[760px] p-6">
      <Mention
        open
        triggers={['@']}
        trigger="@"
        inputValue={inputValue}
        onInputValueChange={() => {}}
        mentions={[]}
        onMentionsChange={() => {}}
        value={[]}
        onValueChange={() => {}}
        onFilter={(options) => options}
        autoCloseOnEmpty={false}
      >
        <MentionInput
          value={inputValue}
          onChange={() => {}}
          className="w-full rounded-md border border-input-border bg-input p-2"
          aria-label="composer"
        />
        <div className="mt-2 w-max max-w-full overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md">
          <MentionTwoLevelMenuBody view={view} onBack={() => {}} showBack detail={detail} />
        </div>
      </Mention>
    </div>
  );
}

const meta = {
  title: 'Mentions/MentionTwoLevelMenu',
  component: Harness,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Harness>;

export default meta;
type Story = StoryObj<typeof meta>;

/** `@` — the first level. */
export const Categories: Story = {
  args: { search: '' },
};

/** `@mention` — one query answered across every category, Files first. */
export const AggregateSearch: Story = {
  args: { search: 'mention' },
};

/** `@issue:` — the second level, scoped to one category. */
export const IssueCategory: Story = {
  args: { search: 'issue:' },
};

/** `@skill:` — the second level with the detail panel populated. */
export const SkillCategoryWithDetail: Story = {
  args: { search: 'skill:' },
};

/** The same level on mobile, where the docked strip stays list-only. */
export const SkillCategoryMobile: Story = {
  args: { search: 'skill:', withDetail: false },
};

/** `@cmd:` — commands, which replace the whole prompt when committed. */
export const CommandCategory: Story = {
  args: { search: 'cmd:' },
};

export const CategoryLoading: Story = {
  args: {
    search: 'issue:',
    categories: CATEGORIES.map((entry) =>
      entry.id === 'issue'
        ? { ...entry, status: 'loading' as const, getCandidates: () => [] }
        : entry
    ),
  },
};

export const CategoryError: Story = {
  args: {
    search: 'issue:',
    categories: CATEGORIES.map((entry) =>
      entry.id === 'issue'
        ? {
            ...entry,
            status: 'error' as const,
            message: 'Failed to load issues and PRs.',
            getCandidates: () => [],
          }
        : entry
    ),
  },
};

/** A very large repo: the file list is truncated and says so. */
export const FileCategoryTruncated: Story = {
  args: {
    search: 'file:',
    categories: CATEGORIES.map((entry) =>
      entry.id === 'file'
        ? {
            ...entry,
            notice: 'Repo is very large; GitHub returned a truncated file list.',
          }
        : entry
    ),
  },
};

/** Nothing matched anywhere. */
export const NoResults: Story = {
  args: { search: 'zzzz' },
};
