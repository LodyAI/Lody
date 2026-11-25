import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { Button } from '@lody/ui/button';
import { OnboardingBackdrop, OnboardingShell } from '@/components/onboarding';

const storyLayoutStyles = stylex.create({
  canvas: {
    borderRadius: 'var(--radius-md)',
    padding: 'calc(var(--spacing) * 8)',
    textAlign: 'center',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
});

const storyLayout = stylex.create({
  frame: {
    position: 'relative',
    minHeight: '640px',
    width: '100%',
  },
  row: {
    position: 'relative',
    zIndex: '10',
    display: 'flex',
    minHeight: '640px',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 'calc(var(--spacing) * 8)',
  },
});

function OnboardingShellPreviewWrapper({ children }: { children: React.ReactNode }) {
  return (
    <div {...stylex.props(storyLayout.frame)}>
      <OnboardingBackdrop />
      <div {...stylex.props(storyLayout.row)}>{children}</div>
    </div>
  );
}

const meta = {
  title: 'Onboarding/OnboardingShell',
  component: OnboardingShell,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <OnboardingShellPreviewWrapper>
        <Story />
      </OnboardingShellPreviewWrapper>
    ),
  ],
} satisfies Meta<typeof OnboardingShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AccountStep: Story = {
  args: {
    stepKey: 'account',
    title: 'Ready to set off',
    description: 'Once signed in, your tasks keep running across every device.',
    primaryAction: <Button size="large">Continue</Button>,
    children: <div {...stylex.props(storyLayoutStyles.canvas)}>Body slot</div>,
  },
};

export const ModelStep: Story = {
  args: {
    stepKey: 'model',
    size: 'wide',
    title: 'Connect a model',
    description: 'Lody Agent thinks with it. Pick one way — only needed once.',
    secondaryAction: (
      <Button variant="ghost" size="large">
        Later
      </Button>
    ),
    primaryAction: <Button size="large">Continue</Button>,
    children: <div {...stylex.props(storyLayoutStyles.canvas)}>Body slot — wide</div>,
  },
};

export const StartStep: Story = {
  args: {
    stepKey: 'start',
    size: 'wide',
    title: 'Where should we start?',
    description: 'Start with or without a project.',
    primaryAction: <Button size="large">Start</Button>,
    children: <div {...stylex.props(storyLayoutStyles.canvas)}>Body slot</div>,
  },
};
