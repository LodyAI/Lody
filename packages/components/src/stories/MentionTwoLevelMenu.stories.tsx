import * as React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Mention, MentionInput } from '@/ui/mention';
import { MentionTwoLevelMenuBody } from '@/components/mentions/mention-two-level-menu';
import {
  getMentionViewCandidates,
  selectMentionMenuView,
  toAgentRoleCandidate,
  toCommandCandidate,
  toFileCandidate,
  toIssuePrCandidate,
  toSkillCandidate,
  type MentionCandidate,
  type MentionCategory,
} from '@/components/mentions/mention-registry';
import {
  AGENT_ROLE_VERSION,
  type AgentConfigId,
  type AgentRole,
  type AgentRoleId,
  type MachineId,
} from '@lody/shared';

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
  scope: { project: 'Project', global: 'Global', system: 'System' },
};

const FILES: MentionCandidate[] = [
  toFileCandidate({
    kind: 'dir',
    path: 'src/components/mentions',
    token: 'src/components/mentions/',
  }),
  toFileCandidate({
    kind: 'file',
    path: 'src/ui/mention/mention-root.tsx',
    token: 'src/ui/mention/mention-root.tsx',
  }),
  toFileCandidate({
    kind: 'file',
    path: 'src/components/mentions/mention-registry.ts',
    token: 'src/components/mentions/mention-registry.ts',
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
  }),
  toIssuePrCandidate({
    number: 3298,
    title: 'Switching sessions janks the composer',
    type: 'issue',
    token: '#3298',
    label: '3298',
    searchableNumber: '3298',
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

const ROLE_MACHINE = { name: 'Studio' };

const ROLE_AGENT_CONFIG = {
  cliType: 'builtin',
  agentType: 'codex',
  env: {},
  name: 'Codex',
} as const;

const agentRole = (overrides: Partial<AgentRole>): AgentRole => ({
  v: AGENT_ROLE_VERSION,
  id: 'role-1' as AgentRoleId,
  ownerUserId: 'user-1',
  visibility: 'workspace',
  name: 'Code Reviewer',
  emoji: '🔍',
  machineId: 'machine-1' as MachineId,
  agentConfigId: 'config-1' as AgentConfigId,
  runConfig: { modelId: 'gpt-5.6-sol', configOptionValues: { reasoning_effort: 'high' } },
  revision: 2,
  createdAt: 1,
  updatedAt: 2,
  ...overrides,
});

const AGENT_ROLES: MentionCandidate[] = [
  toAgentRoleCandidate({
    slug: 'Code-Reviewer',
    role: agentRole({
      // Long on purpose: the instruction scrolls inside its own block so the
      // pinned-value rows stay on screen.
      promptPrefix: [
        'Review the diff for correctness before style.',
        'Name the failure a reader could hit, with the input that triggers it.',
        'Prefer one concrete repro over three hedged observations.',
        'If the change is fine, say so in one line and stop.',
      ].join('\n'),
    }),
    machine: ROLE_MACHINE,
    agentConfig: ROLE_AGENT_CONFIG,
  }),
  toAgentRoleCandidate({
    slug: 'Release-Notes',
    role: agentRole({
      id: 'role-2' as AgentRoleId,
      name: 'Release Notes',
      emoji: '📝',
      visibility: 'private',
      runConfig: { modelId: 'gpt-5.6-luna' },
    }),
    machine: ROLE_MACHINE,
    agentConfig: ROLE_AGENT_CONFIG,
  }),
];

const COMMANDS: MentionCandidate[] = [
  toCommandCandidate({ name: 'review', description: 'Review the changes on this branch' }),
  toCommandCandidate({ name: 'compact', description: 'Compact the conversation context' }),
];

function category(
  id: MentionCategory['id'],
  namespace: string,
  label: string,
  icon: MentionCategory['icon'],
  candidates: MentionCandidate[],
  overrides?: Partial<MentionCategory>
): MentionCategory {
  return {
    id,
    namespace,
    label,
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
  category('file', 'file', 'Files', 'file', FILES),
  category('issue', 'issue', 'Issues', 'issue', ISSUES),
  category('pr', 'pr', 'Pull Requests', 'pr', []),
  category('skill', 'skill', 'Skills', 'skill', SKILLS),
  category('agent_role', 'role', 'Agent Roles', 'agent_role', AGENT_ROLES),
  category('command', 'cmd', 'Commands', 'command', COMMANDS),
];

type HarnessProps = {
  /** Text after `@`, exactly what the composer would hold. */
  search: string;
  categories?: MentionCategory[];
  /** Desktop shows a side panel for the highlighted candidate; mobile does not. */
  withDetail?: boolean;
  /** Constrains the menu to a mobile-composer-sized surface. */
  narrow?: boolean;
};

function Harness({ search, categories = CATEGORIES, withDetail = true, narrow }: HarnessProps) {
  const view = selectMentionMenuView(categories, search);
  const candidates = getMentionViewCandidates(view);
  const detail = withDetail ? (candidates[0]?.detail ?? null) : null;
  const inputValue = `@${search}`;

  return (
    <div className={narrow ? 'h-[460px] w-[320px] p-3' : 'h-[460px] w-[760px] p-6'}>
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

const SESSION_CANDIDATES: MentionCandidate[] = [
  {
    value: 'session-current',
    label: 'current-parser-work',
    insertText: '@current-parser-work',
    kind: 'session',
    icon: 'session',
    title: 'Current parser work',
  },
  {
    value: 'session-other',
    label: 'other-project-work',
    insertText: '@other-project-work',
    kind: 'session',
    icon: 'session',
    title: 'Other project work',
  },
];

function SessionScopeHarness({
  initialScope,
  currentProjectEmpty = false,
  narrow = false,
}: {
  initialScope: 'current' | 'all';
  currentProjectEmpty?: boolean;
  narrow?: boolean;
}) {
  const [scope, setScope] = React.useState(initialScope);
  const candidates =
    scope === 'all'
      ? currentProjectEmpty
        ? SESSION_CANDIDATES.slice(1)
        : SESSION_CANDIDATES
      : currentProjectEmpty
        ? []
        : SESSION_CANDIDATES.slice(0, 1);
  const sessionCategory = category('session', 'session', 'Sessions', 'session', candidates, {
    header: {
      ariaLabel: 'Session project scope',
      options: [
        {
          label: 'Current project',
          selected: scope === 'current',
          onSelect: () => setScope('current'),
        },
        {
          label: 'All projects',
          selected: scope === 'all',
          onSelect: () => setScope('all'),
        },
      ],
    },
    emptyState:
      scope === 'current' && currentProjectEmpty
        ? {
            message: 'There are no other sessions in the current project.',
            action: {
              label: 'View all projects',
              ariaLabel: 'Show sessions from all projects',
              onAction: () => setScope('all'),
            },
          }
        : undefined,
  });

  return (
    <Harness search="session:" categories={[sessionCategory]} withDetail={false} narrow={narrow} />
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

export const SessionCurrentProject: Story = {
  args: { search: 'session:' },
  render: () => <SessionScopeHarness initialScope="current" />,
};

export const SessionAllProjects: Story = {
  args: { search: 'session:' },
  render: () => <SessionScopeHarness initialScope="all" />,
};

export const SessionCurrentProjectEmpty: Story = {
  args: { search: 'session:' },
  render: () => <SessionScopeHarness initialScope="current" currentProjectEmpty />,
};

export const SessionScopeNarrow: Story = {
  args: { search: 'session:' },
  render: () => <SessionScopeHarness initialScope="current" narrow />,
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
/** `@role:` — the instruction is shown, capped and scrollable, above the rows. */
export const AgentRoleCategoryWithDetail: Story = {
  args: { search: 'role:', withDetail: true },
};

/** A Role with no instruction: the pane is rows only, no empty block. */
export const AgentRoleWithoutPrompt: Story = {
  args: { search: 'role:Release', withDetail: true },
};

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
