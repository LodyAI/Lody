import * as stylex from '@stylexjs/stylex';
import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import type {
  AgentConfigId,
  LocalProjectId,
  MachineId,
  MachineViewMeta,
  ProviderSetupTask,
} from '@lody/shared';
import {
  OnboardingBackdrop,
  ProjectsScreenView,
  ProvidersScreenView,
  SummaryScreen,
} from '@/components/onboarding';
const storyLayout = stylex.create({
  frame: {
    position: 'relative',
    'min-height': '760px',
    width: '100%',
  },
  frame2: {
    position: 'relative',
    'z-index': '10',
    'min-height': '760px',
  },
  overlay: {
    position: 'absolute',
    inset: 'calc(var(--spacing) * 0)',
    display: 'flex',
    'align-items': 'center',
    'justify-content': 'center',
    color: 'var(--color-slate-950)',
  },
});

type JourneyStep = 'providers' | 'projects' | 'summary' | 'complete';

const machineId = 'machine-onboarding' as MachineId;
const machine: MachineViewMeta = {
  id: machineId,
  name: 'My Mac',
  cliVersion: '0.76.0',
  os: 'darwin',
  sessions: [],
  raceLimits: {},
  protocolCapabilities: { providerSetup: 1 },
};
const pendingSetup: ProviderSetupTask = {
  v: 1,
  id: 'provider-setup-codex' as AgentConfigId,
  machineId,
  config: {
    id: 'provider-setup-codex' as AgentConfigId,
    machineId,
    name: 'Codex',
    description: undefined,
    cliType: 'builtin',
    agentType: 'codex',
    env: {},
  },
  status: 'preparing-runtime',
  attempt: 1,
  createdAt: 10,
  updatedAt: 20,
};

function JourneyPreviewWrapper({ children }: { children: React.ReactNode }) {
  return (
    <div {...stylex.props(storyLayout.frame)}>
      <OnboardingBackdrop />
      <div {...stylex.props(storyLayout.frame2)}>{children}</div>
    </div>
  );
}

function CompletionCheckpoint({ detail }: { detail: string }) {
  return (
    <div data-testid="onboarding-complete" {...stylex.props(storyLayout.overlay)}>
      <div className="rounded-2xl border border-slate-200/80 bg-white/85 px-10 py-8 text-center shadow-xl backdrop-blur-xl">
        <h1 className="text-3xl font-semibold tracking-tight">Onboarding complete</h1>
        <p className="mt-3 text-sm text-slate-600">{detail}</p>
      </div>
    </div>
  );
}

function ProviderSkipJourney() {
  const [step, setStep] = useState<JourneyStep>('providers');

  if (step === 'complete') {
    return (
      <CompletionCheckpoint detail="The user entered Lody and can connect an Agent later from Settings." />
    );
  }

  if (step === 'summary') {
    return (
      <SummaryScreen
        agentState="missing"
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

function PendingProviderJourney() {
  const [step, setStep] = useState<JourneyStep>('providers');

  if (step === 'complete') {
    return (
      <CompletionCheckpoint detail="The Agent runtime continues downloading in the background." />
    );
  }

  if (step === 'summary') {
    return (
      <SummaryScreen
        agentState="preparing"
        agentName="Codex"
        projectName="Lody"
        onBack={() => setStep('projects')}
        onComplete={() => setStep('complete')}
      />
    );
  }

  if (step === 'projects') {
    return (
      <ProjectsScreenView
        local={[
          {
            key: `${machineId}:lody`,
            machineId,
            localProjectId: 'local-project-lody' as LocalProjectId,
            name: 'Lody',
            detail: '/Users/me/Projects/lody',
          },
        ]}
        github={[]}
        importing={false}
        connectingGitHub={false}
        canImportLocal
        canConnectGitHub={false}
        loadingRepos={false}
        onAddLocal={fn()}
        onConnectGitHub={fn()}
        onBack={() => setStep('providers')}
        onSkip={() => setStep('summary')}
        onComplete={() => setStep('summary')}
      />
    );
  }

  return (
    <ProvidersScreenView
      configs={[]}
      setups={[pendingSetup]}
      testStatuses={{}}
      selectedProviderId={pendingSetup.id}
      noLocalMachine={false}
      localMachineId={machineId}
      localMachine={machine}
      onEdit={fn()}
      onTest={fn()}
      onDelete={fn()}
      onAdd={fn()}
      onBack={fn()}
      onSkip={fn()}
      onNext={(selection) => {
        if (selection.kind === 'providerSetup') setStep('projects');
      }}
    />
  );
}

const meta = {
  title: 'Onboarding/CompletionJourney',
  component: ProviderSkipJourney,
  parameters: { layout: 'fullscreen' },
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

export const ProviderPendingSetup: Story = {
  render: () => <PendingProviderJourney />,
};

export const ProviderSetupFailed: Story = {
  render: () => (
    <SummaryScreen
      agentState="failed"
      agentName="Codex"
      agentFailureCode="runtime-install-failed"
      projectName="Lody"
      onBack={fn()}
      onComplete={fn()}
      onRetryAgent={async () => undefined}
    />
  ),
};
