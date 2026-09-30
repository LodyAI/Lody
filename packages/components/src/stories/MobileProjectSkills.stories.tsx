import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronLeft, X } from 'lucide-react';
import type { ProjectSkill, ProjectSkillScope } from '@lody/shared';
import {
  MobileProjectSkillsBody,
  type MobileProjectSkillsBodyProps,
} from '@/components/mobile/mobile-project-skills-sheet';
import { SkillDetailContent } from '@/components/settings/skill-detail';
import type { ProjectSkillResolvedGroup } from '@/hooks/use-project-skills';

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
          'Review the current diff for correctness bugs and reuse / simplification cleanups.',
        version: '1.2.0',
        author: 'loro-dev',
        relativePath: '.agents/skills/code-review',
        isSymlink: false,
        content: [
          '## When to use',
          'Run this before opening a PR.',
          '1. Diff the branch against `main`.',
          '2. Flag **correctness** issues first.',
        ].join('\n'),
      },
      {
        id: '.agents/skills/deep-research',
        name: 'deep-research',
        description: 'Fan-out web searches, fetch sources, then synthesize a cited report.',
        version: '0.4.1',
        author: 'gstack',
        relativePath: '.agents/skills/deep-research',
        isSymlink: true,
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
        description: 'Diagnose and fix Lody Code Collab diff and turn-history issues.',
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
    scope: 'project',
    dir: '.windsurf/skills',
    registration: 'found',
    truncated: false,
    skills: [
      {
        id: '.windsurf/skills/konsta-ui',
        name: 'konsta-ui',
        description:
          'Guide to using Konsta UI for pixel-perfect iOS and Material Design components.',
        author: 'windsurf-team',
        relativePath: '.windsurf/skills/konsta-ui',
        isSymlink: false,
      },
    ],
  },
];

/* Renders the body inside a phone-width sheet shell + the same in-sheet detail
   slide-over the real sheet uses, so the Info-tap → detail → back flow is
   screenshot-verifiable without standing up the SWR hook. */
function SheetFrame({ args }: { args: MobileProjectSkillsBodyProps }) {
  const [detail, setDetail] = useState<{ skill: ProjectSkill; scope: ProjectSkillScope } | null>(
    null
  );
  return (
    <div className="flex h-[760px] w-[390px] items-end justify-center bg-black/30">
      <div className="flex max-h-[88%] w-full flex-col overflow-hidden rounded-t-2xl border border-border/60 bg-background">
        <header className="relative flex shrink-0 items-center px-4 pb-2 pt-2">
          {detail ? (
            <button
              type="button"
              onClick={() => setDetail(null)}
              className="absolute left-2 top-1.5 inline-flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground"
            >
              <ChevronLeft className="h-5 w-5" strokeWidth={1.8} />
            </button>
          ) : null}
          <span className="mx-auto max-w-[68%] truncate text-[0.95rem] font-semibold tracking-tight">
            {detail ? detail.skill.name : 'Skills'}
          </span>
          <span className="absolute right-3 top-1.5 inline-flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground">
            <X className="h-5 w-5" strokeWidth={1.8} />
          </span>
        </header>
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="min-h-0 flex-1 overflow-y-auto pb-4">
            <MobileProjectSkillsBody
              {...args}
              onViewDetail={(skill, scope) => setDetail({ skill, scope })}
            />
          </div>
          <AnimatePresence>
            {detail ? (
              <motion.div
                key="detail"
                initial={{ x: '100%' }}
                animate={{ x: 0 }}
                exit={{ x: '100%' }}
                transition={{ duration: 0.25, ease: [0.32, 0.72, 0, 1] }}
                className="absolute inset-0 z-10 flex flex-col bg-background"
              >
                <div className="scrollbar-pro flex-1 overflow-y-auto px-4 pb-4 pt-1">
                  <SkillDetailContent skill={detail.skill} scope={detail.scope} />
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

const meta = {
  title: 'Mobile/MobileProjectSkills',
  component: MobileProjectSkillsBody,
  parameters: { layout: 'fullscreen' },
  render: (args: MobileProjectSkillsBodyProps) => <SheetFrame args={args} />,
} satisfies Meta<typeof MobileProjectSkillsBody>;

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
  args: { status: 'loading', groups: [], stale: false, onRefresh: noop },
};

export const Empty: Story = {
  args: { status: 'ready', groups: [], stale: false, fetchedAt: FETCHED_AT, onRefresh: noop },
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
