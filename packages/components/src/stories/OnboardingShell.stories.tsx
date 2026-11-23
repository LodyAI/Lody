import type { Meta, StoryObj } from '@storybook/react';
import { Button } from '@lody/ui/button';
import { OnboardingBackdrop, OnboardingShell } from '@/components/onboarding';

/**
 * Wraps the shell in the same backdrop the overlay uses so stories preview
 * the production look-and-feel rather than the bare card.
 */
function OnboardingShellPreviewWrapper({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-[640px] w-full">
      <OnboardingBackdrop />
      <div className="relative z-10 flex min-h-[640px] items-center justify-center p-8">
        {children}
      </div>
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

export const NarrowSingleAction: Story = {
  args: {
    stepKey: 'language',
    title: 'Choose your language',
    description: 'You can switch this anytime from settings.',
    primaryAction: <Button size="large">Next</Button>,
    children: (
      <div className="rounded-md border border-dashed border-border/60 p-8 text-center text-sm text-muted-foreground">
        Body slot
      </div>
    ),
  },
};

export const WideWithBackAndNext: Story = {
  args: {
    stepKey: 'providers',
    size: 'wide',
    title: 'Connect a coding agent',
    description: 'Test at least one provider so we know your credentials work.',
    secondaryAction: (
      <Button variant="ghost" size="large">
        Back
      </Button>
    ),
    primaryAction: <Button size="large">Next</Button>,
    children: (
      <div className="rounded-md border border-dashed border-border/60 p-8 text-center text-sm text-muted-foreground">
        Body slot — wide
      </div>
    ),
  },
};

export const ProjectsStep: Story = {
  args: {
    stepKey: 'projects',
    size: 'wide',
    title: 'Pick a project to start with',
    description: 'Add at least one project so Lody knows where to work.',
    secondaryAction: (
      <Button variant="ghost" size="large">
        Back
      </Button>
    ),
    primaryAction: <Button size="large">Finish</Button>,
    children: (
      <div className="rounded-md border border-dashed border-border/60 p-8 text-center text-sm text-muted-foreground">
        Body slot
      </div>
    ),
  },
};
