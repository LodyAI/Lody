import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import type { LocalProjectId, MachineId } from '@lody/shared';

import {
  SessionInfoCard,
  SessionInfoHoverCard,
  type SessionInfoCardProps,
} from '@/components/session-info-hover-card';
import type { PrCiRun } from '@/components/sessions/session-info-chips';

const now = new Date('2026-07-13T21:00:00Z');
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
const hoursAgo = (h: number) => minutesAgo(h * 60);
const daysAgo = (d: number) => hoursAgo(d * 24);

const ciPassing: PrCiRun[] = [
  { name: 'build', status: 'success', durationMs: 46_000 },
  { name: 'test (unit)', status: 'success', durationMs: 132_000 },
  { name: 'lint', status: 'success', durationMs: 18_000 },
];

const ciRunning: PrCiRun[] = [
  { name: 'build', status: 'success', durationMs: 44_000 },
  { name: 'test (e2e)', status: 'running' },
  { name: 'deploy preview', status: 'queued' },
];

const ciFailing: PrCiRun[] = [
  { name: 'build', status: 'success', durationMs: 41_000 },
  { name: 'test (unit)', status: 'failure', durationMs: 87_000 },
  { name: 'lint', status: 'skipped' },
];

const meta = {
  title: 'Sessions/SessionInfoCard',
  component: SessionInfoCard,
  parameters: { layout: 'centered' },
  args: {
    title: 'Fix data persistence race',
    latestMessageAt: hoursAgo(2),
    now,
    onOpenPullRequest: fn(),
    standalone: true,
  },
} satisfies Meta<typeof SessionInfoCard>;

export default meta;
type Story = StoryObj<typeof meta>;

const githubArgs = {
  kind: 'github',
  isWorktree: true,
  repoFullName: 'loro-dev/lody',
  machineName: 'Studio Mac',
  branchName: 'feat/persistence-race',
  prStatus: 'open',
  prNumber: 128,
  prUrl: 'https://github.com/loro-dev/lody/pull/128',
  addedLines: 312,
  deletedLines: 47,
} satisfies Partial<SessionInfoCardProps>;

export const GithubOpenWithCiPassing: Story = {
  args: { ...githubArgs, prCiRuns: ciPassing },
};

export const GithubOpenWithCiRollup: Story = {
  args: { ...githubArgs, prCiState: 's' },
};

export const TeamWithAuthor: Story = {
  name: 'Team scope (with Author row)',
  args: {
    ...githubArgs,
    author: { name: 'Alex Rivera', image: null },
    prCiRuns: ciPassing,
    sharing: {
      visibility: 'team',
      canManage: true,
      machineId: 'machine-story' as MachineId,
      localProjectId: null,
      machineName: 'Studio Mac',
      projectName: null,
    },
  },
};

export const PrivateLocalProject: Story = {
  args: {
    kind: 'local',
    title: 'Fix team onboarding',
    folderName: 'lody',
    machineName: 'Studio Mac',
    sharing: {
      visibility: 'private',
      privateReason: 'machine-and-project',
      canManage: true,
      machineId: 'machine-story' as MachineId,
      localProjectId: 'project-story' as LocalProjectId,
      machineName: 'Studio Mac',
      projectName: 'lody',
    },
  },
};

export const TeamVisibleChat: Story = {
  args: {
    kind: 'chat',
    title: 'Plan the next release',
    machineName: 'Studio Mac',
    sharing: {
      visibility: 'team',
      canManage: true,
      machineId: 'machine-story' as MachineId,
      localProjectId: null,
      machineName: 'Studio Mac',
      projectName: null,
    },
  },
};

export const GithubMergedWithCiRunning: Story = {
  args: {
    ...githubArgs,
    title: 'Ship presence heartbeat',
    prStatus: 'merged',
    prNumber: 99,
    latestMessageAt: minutesAgo(8),
    prCiRuns: ciRunning,
  },
};

export const GithubClosedWithCiFailing: Story = {
  args: {
    ...githubArgs,
    title: 'Spike: fabric shader LOD',
    prStatus: 'closed',
    prNumber: 74,
    latestMessageAt: daysAgo(3),
    prCiRuns: ciFailing,
  },
};

export const GithubNoCiFeed: Story = {
  name: 'GitHub (no CI feed yet)',
  args: { ...githubArgs, prCiRuns: undefined },
};

export const LocalWorktree: Story = {
  args: {
    kind: 'local',
    title: 'Refactor persistence layer',
    isWorktree: true,
    folderName: 'lody',
    machineName: 'Studio Mac',
    branchName: 'feat/persistence-refactor',
    latestMessageAt: hoursAgo(5),
  },
};

export const LocalPlain: Story = {
  args: {
    kind: 'local',
    title: 'Tidy up logging output',
    isWorktree: false,
    folderName: 'loro',
    machineName: 'MacBook Pro',
    branchName: 'main',
    latestMessageAt: daysAgo(1),
  },
};

export const ChatMinimal: Story = {
  args: {
    kind: 'chat',
    title: 'Brainstorm onboarding copy',
    latestMessageAt: minutesAgo(30),
  },
};

export const LongBranchName: Story = {
  args: {
    ...githubArgs,
    branchName: 'feature/extremely-long-branch-name-that-should-truncate-inside-the-card',
    prCiRuns: ciPassing,
  },
};

/**
 * Interactive: hover the row to open the card, then move the cursor into the card —
 * it stays open (hoverable), and the branch is copyable / the PR is clickable.
 */
export const HoverInteraction: Story = {
  render: (args) => (
    <div className="w-64 rounded-lg border border-border p-2">
      <SessionInfoHoverCard {...args} {...githubArgs} prCiRuns={ciPassing} standalone={false}>
        <div
          role="button"
          tabIndex={0}
          className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-sidebar-hover"
        >
          <span className="h-2 w-2 shrink-0 rounded-full bg-primary" />
          <span className="min-w-0 flex-1 truncate">{args.title}</span>
          <span className="shrink-0 text-[11px] tabular-nums text-code-added">+312</span>
        </div>
      </SessionInfoHoverCard>
    </div>
  ),
};
