import type { Meta, StoryObj } from '@storybook/react';
import { useState, type ComponentProps } from 'react';

import {
  WorkdirModeSelector,
  WorktreeCheckboxPill,
  type WorkdirMode,
} from '@/components/shared/workdir-mode-selector';

const meta = {
  title: 'Components/WorkdirModeSelector',
  component: WorkdirModeSelector,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof WorkdirModeSelector>;

export default meta;
type Story = StoryObj<typeof meta>;
type WorkdirModeSelectorProps = ComponentProps<typeof WorkdirModeSelector>;

function InteractiveSelector(args: WorkdirModeSelectorProps) {
  const [mode, setMode] = useState<WorkdirMode>(args.mode);
  return <WorkdirModeSelector {...args} mode={mode} onModeChange={setMode} />;
}

export const WorkLocally: Story = {
  args: {
    tone: 'light',
    mode: 'local',
    worktreeAvailable: true,
  },
  render: (args) => <InteractiveSelector {...args} />,
};

export const NewWorktree: Story = {
  args: {
    tone: 'light',
    mode: 'worktree',
    worktreeAvailable: true,
  },
  render: (args) => <InteractiveSelector {...args} />,
};

export const WorktreeUnavailable: Story = {
  args: {
    tone: 'light',
    mode: 'local',
    worktreeAvailable: false,
    worktreeUnavailableReason: 'This local project is not a git repository.',
  },
  render: (args) => <InteractiveSelector {...args} />,
};

export const ReadOnly: Story = {
  args: {
    tone: 'light',
    mode: 'worktree',
    worktreeAvailable: true,
  },
};

export const CheckboxPill: Story = {
  args: {
    tone: 'light',
    mode: 'local',
    worktreeAvailable: true,
  },
  render: () => <WorktreeCheckboxPill checked onCheckedChange={() => undefined} />,
};

export const CheckboxPillRequired: Story = {
  args: {
    tone: 'light',
    mode: 'worktree',
    worktreeAvailable: true,
  },
  render: () => (
    <WorktreeCheckboxPill
      checked
      disabled
      disabledReason="GitHub projects always run in an isolated worktree."
    />
  ),
};

export const ContextPill: Story = {
  args: CheckboxPill.args,
  render: () => (
    <WorktreeCheckboxPill
      checked
      onCheckedChange={() => undefined}
      surface="context"
    />
  ),
};

export const ContextPillRequired: Story = {
  args: CheckboxPillRequired.args,
  render: () => (
    <WorktreeCheckboxPill
      checked
      disabled
      disabledReason="GitHub projects always run in an isolated worktree."
      surface="context"
    />
  ),
};
