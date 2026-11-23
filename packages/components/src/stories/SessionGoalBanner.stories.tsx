import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';

import { SESSION_GOAL_COMMANDS, type SessionGoalMessage } from '@lody/shared';
import { SessionGoalBanner } from '@/components/sessions/session-goal-banner';
const migrationStyles = stylex.create({
  conversationPlaceholder: {
    height: 'calc(var(--spacing) * 32)',
    backgroundColor: {
      default: 'color-mix(in oklab, hsl(var(--muted) / 1) 20%, transparent)',
      ':where(.dark, .dark *, .dark-scope, .dark-scope *):not(:where(.light-scope, .light-scope *))':
        'color-mix(in oklab, var(--color-black) 20%, transparent)',
    },
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--text-xs--line-height)',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
});

const storyLayout = stylex.create({
  frame: {
    width: '760px',
    borderRadius: 'var(--radius-lg)',
    borderStyle: 'solid',
    borderWidth: '1px',
    borderColor: 'hsl(var(--border) / 1)',
    backgroundColor: 'hsl(var(--background) / 1)',
  },
  row: {
    display: 'flex',
    height: 'calc(var(--spacing) * 9)',
    alignItems: 'center',
    borderBottomStyle: 'solid',
    borderBottomWidth: '1px',
    borderColor: 'hsl(var(--border) / 1)',
    backgroundColor: 'color-mix(in oklab, hsl(var(--muted) / 1) 30%, transparent)',
    paddingInline: 'calc(var(--spacing) * 4)',
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--text-xs--line-height)',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
});

const baseGoal: SessionGoalMessage = {
  type: 'goal',
  threadId: 'thread-1',
  turnId: 'turn-1',
  objective: 'Integrate Codex goal status into the session message UI',
  status: 'active',
  tokenBudget: 50_000,
  tokensUsed: 12_400,
  timeUsedSeconds: 382,
  createdAt: 1_000,
  updatedAt: 1_500,
};

const sparseGoal: SessionGoalMessage = {
  type: 'goal',
  threadId: 'thread-1',
  objective: 'Integrate Codex goal status into the session message UI',
  status: 'active',
  tokenBudget: null,
};

const longObjective =
  'Refactor the entire authentication module so it uses JWT tokens with refresh-token rotation, ' +
  'replace the legacy cookie-based session middleware, update the login/logout endpoints, the ' +
  'password reset flow, the email-verification flow, the test suite, and the API documentation, ' +
  'then update the frontend auth context + hooks to handle automatic token refresh, and add rate ' +
  'limiting on the auth endpoints before we ship.';

const meta = {
  title: 'Sessions/SessionGoalBanner',
  component: SessionGoalBanner,
  args: {
    commands: SESSION_GOAL_COMMANDS,
  },
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div {...stylex.props(storyLayout.frame)}>
        <div {...stylex.props(storyLayout.row)}>Tab Bar (simulated)</div>
        <Story />
        <div {...stylex.props(migrationStyles.conversationPlaceholder)}>Chat area</div>
      </div>
    ),
  ],
} satisfies Meta<typeof SessionGoalBanner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ActiveWithBudget: Story = {
  args: {
    goal: baseGoal,
    pendingCommand: null,
    onGoalCommand: fn(),
    onDismiss: fn(),
  },
};

export const ActiveNoBudget: Story = {
  args: {
    goal: { ...baseGoal, tokenBudget: null, tokensUsed: 8_900, timeUsedSeconds: 1_209 },
    pendingCommand: null,
    onGoalCommand: fn(),
    onDismiss: fn(),
  },
};

export const ActiveLongObjectiveCollapsed: Story = {
  args: {
    goal: { ...baseGoal, objective: longObjective },
    pendingCommand: null,
    onGoalCommand: fn(),
    onDismiss: fn(),
  },
};

export const Paused: Story = {
  args: {
    goal: {
      ...baseGoal,
      status: 'paused',
      tokensUsed: 24_000,
      timeUsedSeconds: 65,
    },
    pendingCommand: null,
    onGoalCommand: fn(),
    onDismiss: fn(),
  },
};

export const BudgetLimited: Story = {
  args: {
    goal: {
      ...baseGoal,
      status: 'budgetLimited',
      tokensUsed: 50_000,
      timeUsedSeconds: 7_245,
      objective:
        'Finish the unusually-long-goal-objective that should wrap cleanly without overflowing the toolbar',
    },
    pendingCommand: null,
    onGoalCommand: fn(),
    onDismiss: fn(),
  },
};

export const Complete: Story = {
  args: {
    goal: {
      ...baseGoal,
      status: 'complete',
      tokenBudget: null,
      tokensUsed: 8_900,
      timeUsedSeconds: 1_209,
      objective: 'Complete the release checklist',
    },
    pendingCommand: null,
    onGoalCommand: fn(),
    onDismiss: fn(),
  },
};

export const Cleared: Story = {
  args: {
    goal: {
      ...baseGoal,
      status: 'cleared',
      tokensUsed: 12_400,
      timeUsedSeconds: 382,
    },
    pendingCommand: null,
    onGoalCommand: fn(),
    onDismiss: fn(),
  },
};

export const PendingPause: Story = {
  args: {
    goal: baseGoal,
    pendingCommand: 'pause',
    onGoalCommand: fn(),
    onDismiss: fn(),
  },
};

export const NoMetricsYet: Story = {
  args: {
    goal: sparseGoal,
    pendingCommand: null,
    onGoalCommand: fn(),
    onDismiss: fn(),
  },
};
