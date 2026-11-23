import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { OnboardingBackdrop, OnboardingLoadingView } from '@/components/onboarding';
const storyLayout = stylex.create({
  frame: {
    position: 'relative',
    'min-height': '640px',
    width: '100%',
  },
  row: {
    position: 'relative',
    'z-index': '10',
    display: 'flex',
    'min-height': '640px',
    'align-items': 'center',
    'justify-content': 'center',
    padding: 'calc(var(--spacing) * 8)',
  },
});

function LoadingPreviewWrapper({ children }: { children: React.ReactNode }) {
  return (
    <div {...stylex.props(storyLayout.frame)}>
      <OnboardingBackdrop />
      <div {...stylex.props(storyLayout.row)}>{children}</div>
    </div>
  );
}

const meta = {
  title: 'Onboarding/OnboardingLoading',
  component: OnboardingLoadingView,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <LoadingPreviewWrapper>
        <Story />
      </LoadingPreviewWrapper>
    ),
  ],
} satisfies Meta<typeof OnboardingLoadingView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Bootstrap: Story = {
  args: {
    phase: 'starting',
    stage: 'bootstrap',
  },
};

export const Auth: Story = {
  args: {
    phase: 'starting',
    stage: 'auth',
  },
};

export const SyncTime: Story = {
  args: {
    phase: 'starting',
    stage: 'sync-time',
  },
};

export const FleetStart: Story = {
  args: {
    phase: 'starting',
    stage: 'fleet-start',
  },
};

export const ReadyButNotRunning: Story = {
  args: {
    phase: 'starting',
    stage: 'ready',
  },
};

export const Running: Story = {
  args: {
    phase: 'running',
    stage: 'ready',
  },
};

export const BypassedAfterTimeout: Story = {
  args: {
    phase: 'starting',
    stage: 'fleet-start',
    bypassed: true,
  },
};
