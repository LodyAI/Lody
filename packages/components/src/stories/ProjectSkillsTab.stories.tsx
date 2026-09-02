import type { Meta, StoryObj } from '@storybook/react';
import {
  ProjectSkillsView,
  type ProjectSkillsViewProps,
} from '@/components/settings/project-skills-tab';
import type { ProjectSkillResolvedGroup } from '@/hooks/use-project-skills';

/* Fixed timestamp so the "updated … ago" relative label is deterministic
   across screenshots (Date.now() is intentionally avoided). */
const FETCHED_AT = new Date('2026-06-17T11:30:00Z').getTime() - 2 * 60 * 1000;

const LOADED_GROUPS: ProjectSkillResolvedGroup[] = [
  {
    scope: 'project',
    dir: '.agents/skills',
    registration: 'registered',
    truncated: false,
    skippedExternalSymlinks: 1,
    skills: [
      {
        id: '.agents/skills/code-review',
        name: 'code-review',
        description:
          'Review the current diff for correctness bugs and reuse / simplification / efficiency cleanups at the given effort level.',
        version: '1.2.0',
        author: 'loro-dev',
        relativePath: '.agents/skills/code-review',
        isSymlink: false,
        content: [
          '## When to use',
          'Run this before opening a PR to catch correctness bugs and tidy up.',
          '### Steps',
          '1. Diff the branch against `main`.',
          '2. Flag **correctness** issues first, then reuse/simplification.',
          '3. Suggest concrete fixes with `code` snippets.',
          '> Tip: keep findings high-signal — no nitpicks.',
        ].join('\n'),
      },
      {
        id: '.agents/skills/deep-research',
        name: 'deep-research',
        description:
          'Fan-out web searches, fetch sources, adversarially verify claims, then synthesize a cited report.',
        version: '0.4.1',
        author: 'gstack',
        relativePath: '.agents/skills/deep-research',
        isSymlink: true,
      },
      {
        id: '.agents/skills/browse',
        name: 'browse',
        description: 'Fast headless browser for QA testing and site dogfooding.',
        relativePath: '.agents/skills/browse',
        isSymlink: false,
      },
    ],
  },
  {
    scope: 'project',
    dir: '.claude/skills',
    registration: 'registered',
    truncated: false,
    skills: [
      {
        id: '.claude/skills/code-collab-debug',
        name: 'code-collab-debug',
        description:
          'Diagnose and fix Lody Code Collab diff, turn-history, and All Changes issues.',
        version: '2.0.0',
        relativePath: '.claude/skills/code-collab-debug',
        isSymlink: true,
        symlinkTarget: '.agents/skills/code-collab-debug',
      },
    ],
  },
  {
    scope: 'global',
    dir: '~/.codex/skills',
    registration: 'registered',
    truncated: false,
    skills: [
      {
        id: '~/.codex/skills/pr-writer',
        name: 'pr-writer',
        description: 'Draft pull request summaries using the local user skill installed for Codex.',
        author: 'local-user',
        relativePath: '~/.codex/skills/pr-writer/SKILL.md',
        isSymlink: false,
      },
    ],
  },
  {
    scope: 'system',
    dir: '~/.codex/skills/.system',
    registration: 'registered',
    truncated: false,
    skills: [
      {
        id: '~/.codex/skills/.system/imagegen',
        name: 'imagegen',
        description: "Codex's built-in image generation skill.",
        author: 'codex',
        relativePath: '~/.codex/skills/.system/imagegen/SKILL.md',
        isSymlink: false,
      },
      {
        id: '~/.codex/skills/.system/skill-creator',
        name: 'skill-creator',
        description: 'Guide for creating effective skills.',
        author: 'codex',
        relativePath: '~/.codex/skills/.system/skill-creator/SKILL.md',
        isSymlink: false,
      },
    ],
  },
  {
    scope: 'project',
    dir: '.windsurf/skills',
    registration: 'found',
    truncated: false,
    skills: [
      {
        id: '.windsurf/skills/konsta-ui',
        name: 'konsta-ui',
        description:
          'Guide to using Konsta UI for pixel-perfect iOS and Material Design components in Capacitor apps.',
        author: 'windsurf-team',
        relativePath: '.windsurf/skills/konsta-ui',
        isSymlink: false,
      },
    ],
  },
];

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="w-[720px] max-w-full bg-background p-4">{children}</div>;
}

const meta = {
  title: 'Settings/ProjectSkillsTab',
  component: ProjectSkillsView,
  parameters: { layout: 'centered' },
  render: (args: ProjectSkillsViewProps) => (
    <Frame>
      <ProjectSkillsView {...args} />
    </Frame>
  ),
} satisfies Meta<typeof ProjectSkillsView>;

export default meta;
type Story = StoryObj<typeof meta>;

const noop = () => {};

export const Loaded: Story = {
  args: {
    status: 'ready',
    groups: LOADED_GROUPS,
    stale: false,
    fetchedAt: FETCHED_AT,
    onRefresh: noop,
  },
};

export const Refreshing: Story = {
  args: {
    status: 'refreshing',
    groups: LOADED_GROUPS,
    stale: false,
    fetchedAt: FETCHED_AT,
    onRefresh: noop,
  },
};

export const StaleAfterFailedRefresh: Story = {
  args: {
    status: 'error',
    groups: LOADED_GROUPS,
    stale: true,
    error: 'The host machine is offline.',
    fetchedAt: FETCHED_AT,
    onRefresh: noop,
  },
};

export const Loading: Story = {
  args: {
    status: 'loading',
    groups: [],
    stale: false,
    onRefresh: noop,
  },
};

export const Empty: Story = {
  args: {
    status: 'ready',
    groups: [],
    stale: false,
    fetchedAt: FETCHED_AT,
    onRefresh: noop,
  },
};

export const ErrorNoData: Story = {
  args: {
    status: 'error',
    groups: [],
    stale: false,
    error: 'Failed to reach the GitHub API (rate limited).',
    onRefresh: noop,
  },
};

export const GroupError: Story = {
  args: {
    status: 'ready',
    stale: false,
    fetchedAt: FETCHED_AT,
    onRefresh: noop,
    groups: [
      LOADED_GROUPS[0]!,
      {
        scope: 'project',
        dir: '.qwen/skills',
        registration: 'found',
        truncated: false,
        skills: [],
        error: 'Permission denied while reading this directory.',
      },
    ],
  },
};
