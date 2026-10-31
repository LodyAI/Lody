import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import {
  SESSION_GOAL_COMMANDS,
  type ProjectMemberId,
  type SessionGoalCommand,
  type SessionGoalMessage,
  type SessionPullRequestCiState,
} from '@lody/shared';
import { SessionGoalBanner } from '@/components/sessions/session-goal-banner';
import { SessionInfoBar } from '@/components/sessions/session-info-bar';
import { SessionProjectMembersChip } from '@/components/sessions/session-project-members-chip';
import type { SessionProjectMemberRow } from '@/lib/session-project-members';

const goal: SessionGoalMessage = {
  type: 'goal',
  threadId: 'goal-ink-fixture',
  objective: 'Review the synthetic migration and preserve action feedback.',
  status: 'paused',
  tokensUsed: 1200,
  tokenBudget: 4000,
  timeUsedSeconds: 32,
};

function GoalFixture({
  reader,
  pending = null,
  active = false,
}: {
  reader: 'banner' | 'bar';
  pending?: SessionGoalCommand | null;
  active?: boolean;
}) {
  const [currentPending, setPending] = useState(pending);
  const [events, setEvents] = useState<string[]>([]);
  const currentGoal = active ? { ...goal, status: 'active' as const } : goal;
  const onGoalCommand = (command: SessionGoalCommand) => {
    setEvents((previous) => [...previous, command]);
    setPending(command);
  };
  return (
    <div data-owned-goal-ink={reader} style={{ width: 'min(760px, 100%)' }}>
      {reader === 'bar' ? <div style={{ height: 360 }} aria-hidden="true" /> : null}
      {reader === 'banner' ? (
        <SessionGoalBanner
          goal={currentGoal}
          commands={SESSION_GOAL_COMMANDS}
          pendingCommand={currentPending}
          onGoalCommand={onGoalCommand}
        />
      ) : (
        <SessionInfoBar
          status={null}
          goal={currentGoal}
          goalCommands={SESSION_GOAL_COMMANDS}
          goalPendingCommand={currentPending}
          onGoalCommand={onGoalCommand}
          initialStage="goal"
        />
      )}
      <output data-owned-goal-events>{events.join(',') || 'Ready'}</output>
      <output data-owned-goal-pending>{currentPending ?? 'none'}</output>
    </div>
  );
}

const states: (SessionPullRequestCiState | undefined)[] = [
  's',
  'f',
  'e',
  'p',
  'x',
  undefined,
  undefined,
  undefined,
];
const rows: SessionProjectMemberRow[] = states.map((ciState, index) => ({
  id: `ci-fixture-${index}` as ProjectMemberId,
  path: `repo-${index}`,
  kind: 'github',
  isSubmodule: false,
  depth: index === 2 ? 1 : 0,
  repoFullName: `synthetic/repo-${index}`,
  branch: 'migration-ink',
  pr: {
    url: `https://github.com/synthetic/repo-${index}/pull/${730 + index}`,
    number: 730 + index,
    status: index === 5 ? 'closed' : index === 6 ? 'merged' : index === 7 ? 'draft' : 'open',
    ...(ciState ? { ciState } : {}),
  },
}));

function ProjectFixture({ readOnly = false }: { readOnly?: boolean }) {
  const [events, setEvents] = useState<string[]>([]);
  return (
    <div data-owned-project-ink style={{ width: 'min(760px, 100%)' }}>
      <div style={{ height: 480 }} aria-hidden="true" />
      <SessionInfoBar
        status={null}
        projectMembers={
          <SessionProjectMembersChip
            groupName="Synthetic CI colors"
            rows={rows}
            selectedMemberId={'ci-fixture-2' as ProjectMemberId}
            defaultOpen
            onSelectMember={
              readOnly ? undefined : (id) => setEvents((previous) => [...previous, `select:${id}`])
            }
            onOpenPullRequest={(url) => setEvents((previous) => [...previous, `open:${url}`])}
          />
        }
      />
      <output data-owned-project-events>{events.join('|') || 'Ready'}</output>
    </div>
  );
}

const meta = {
  title: 'Migration/OwnedGoalAndProjectInk',
  parameters: { layout: 'padded' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const BannerPaused: Story = { render: () => <GoalFixture reader="banner" /> };
export const BannerActive: Story = { render: () => <GoalFixture reader="banner" active /> };
export const BannerResumePending: Story = {
  render: () => <GoalFixture reader="banner" pending="resume" />,
};
export const BannerClearPending: Story = {
  render: () => <GoalFixture reader="banner" pending="clear" />,
};
export const BarPaused: Story = { render: () => <GoalFixture reader="bar" /> };
export const BarActive: Story = { render: () => <GoalFixture reader="bar" active /> };
export const BarResumePending: Story = {
  render: () => <GoalFixture reader="bar" pending="resume" />,
};
export const BarClearPending: Story = {
  render: () => <GoalFixture reader="bar" pending="clear" />,
};
export const ProjectCiStates: Story = { render: () => <ProjectFixture /> };
export const ProjectReadOnly: Story = { render: () => <ProjectFixture readOnly /> };
