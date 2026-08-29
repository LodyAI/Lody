import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { OnboardingBackdrop, ProvidersScreenView, SummaryScreen } from '@/components/onboarding';

type JourneyStep = 'providers' | 'summary' | 'complete';

function JourneyPreviewWrapper({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-[760px] w-full">
      <OnboardingBackdrop />
      <div className="relative z-10 min-h-[760px]">{children}</div>
    </div>
  );
}

function ProviderSkipJourney() {
  const [step, setStep] = useState<JourneyStep>('providers');

  if (step === 'complete') {
    return (
      <div
        data-testid="onboarding-complete"
        className="absolute inset-0 flex items-center justify-center text-slate-950"
      >
        <div className="rounded-2xl border border-slate-200/80 bg-white/85 px-10 py-8 text-center shadow-xl backdrop-blur-xl">
          <h1 className="text-3xl font-semibold tracking-tight">Onboarding complete</h1>
          <p className="mt-3 text-sm text-slate-600">
            The user entered Lody and can connect an Agent later from Settings.
          </p>
        </div>
      </div>
    );
  }

  if (step === 'summary') {
    return (
      <SummaryScreen
        hasAgent={false}
        onBack={() => setStep('providers')}
        onComplete={() => setStep('complete')}
      />
    );
  }

  return (
    <ProvidersScreenView
      configs={[]}
      testStatuses={{}}
      noLocalMachine={false}
      onEdit={fn()}
      onTest={fn()}
      onDelete={fn()}
      onAdd={fn()}
      onBack={fn()}
      onSkip={() => setStep('summary')}
      onNext={fn()}
    />
  );
}

const meta = {
  title: 'Onboarding/CompletionJourney',
  component: ProviderSkipJourney,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <JourneyPreviewWrapper>
        <Story />
      </JourneyPreviewWrapper>
    ),
  ],
} satisfies Meta<typeof ProviderSkipJourney>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ProviderSkip: Story = {};
