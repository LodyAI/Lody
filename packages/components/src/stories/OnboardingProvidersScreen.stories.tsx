import type { Meta, StoryObj } from '@storybook/react';
import { useCallback, useState } from 'react';
import { fn } from 'storybook/test';
import type { AgentConfigId, AgentConfigMeta, MachineId } from '@lody/shared';
import {
  OnboardingBackdrop,
  ProvidersScreenView,
  type ProviderTestActivity,
  type ProviderTestStatus,
} from '@/components/onboarding';

function ProvidersPreviewWrapper({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-[760px] w-full">
      <OnboardingBackdrop />
      <div className="relative z-10 flex min-h-[760px] items-center justify-center p-8">
        {children}
      </div>
    </div>
  );
}

const machineId = 'machine-story' as MachineId;

const claudeConfig: AgentConfigMeta = {
  id: 'cfg-claude' as AgentConfigId,
  machineId,
  name: 'Claude Code',
  description: undefined,
  cliType: 'builtin',
  agentType: 'claude',
  env: { ANTHROPIC_API_KEY: 'sk-test' },
};

const codexConfig: AgentConfigMeta = {
  id: 'cfg-codex' as AgentConfigId,
  machineId,
  name: 'Codex',
  description: undefined,
  cliType: 'builtin',
  agentType: 'codex',
  env: { OPENAI_API_KEY: 'sk-codex' },
};

const kimiConfig: AgentConfigMeta = {
  id: 'cfg-kimi' as AgentConfigId,
  machineId,
  name: 'Kimi Code',
  description: undefined,
  cliType: 'builtin',
  agentType: 'kimi',
  env: {},
};

const augmentConfig: AgentConfigMeta = {
  id: 'cfg-auggie' as AgentConfigId,
  machineId,
  name: 'Auggie CLI',
  description: undefined,
  cliType: 'registry',
  agentType: 'auggie',
  env: {},
};

/**
 * Simulates a request-scoped runtime download followed by a provider probe.
 */
function InteractiveProvidersScreen({
  initialConfigs,
  initialStatuses,
  forceFailure = false,
}: {
  initialConfigs: AgentConfigMeta[];
  initialStatuses?: Record<string, ProviderTestStatus>;
  forceFailure?: boolean;
}) {
  const [configs, setConfigs] = useState(initialConfigs);
  const [statuses, setStatuses] = useState<Record<string, ProviderTestStatus>>(
    initialStatuses ?? {}
  );
  const [activities, setActivities] = useState<Record<string, ProviderTestActivity>>({});
  const [failureReasons, setFailureReasons] = useState<Record<string, string>>({});

  const handleTest = useCallback(
    (config: AgentConfigMeta) => {
      setActivities((prev) => ({
        ...prev,
        [config.id]: { phase: 'downloading-runtime', percent: 38 },
      }));
      window.setTimeout(() => {
        setActivities((prev) => ({
          ...prev,
          [config.id]: { phase: 'probing-provider' },
        }));
      }, 650);
      window.setTimeout(() => {
        setActivities((prev) => {
          const { [config.id]: _, ...rest } = prev;
          return rest;
        });
        setStatuses((prev) => ({
          ...prev,
          [config.id]: forceFailure ? 'failed' : 'passed',
        }));
        setFailureReasons((prev) => {
          if (forceFailure) {
            return { ...prev, [config.id]: 'The provider rejected the configured credentials.' };
          }
          const { [config.id]: _, ...rest } = prev;
          return rest;
        });
      }, 1_300);
    },
    [forceFailure]
  );

  const handleDelete = useCallback((config: AgentConfigMeta) => {
    setConfigs((prev) => prev.filter((c) => c.id !== config.id));
    setStatuses((prev) => {
      const { [config.id]: _, ...rest } = prev;
      return rest;
    });
    setActivities((prev) => {
      const { [config.id]: _, ...rest } = prev;
      return rest;
    });
    setFailureReasons((prev) => {
      const { [config.id]: _, ...rest } = prev;
      return rest;
    });
  }, []);

  return (
    <ProvidersScreenView
      configs={configs}
      testStatuses={statuses}
      testActivities={activities}
      failureReasons={failureReasons}
      noLocalMachine={false}
      onEdit={fn()}
      onTest={handleTest}
      onDelete={handleDelete}
      onAdd={fn()}
      onBack={fn()}
      onSkip={fn()}
      onNext={fn()}
    />
  );
}

const meta = {
  title: 'Onboarding/ProvidersScreen',
  component: ProvidersScreenView,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
  args: {
    onEdit: fn(),
    onTest: fn(),
    onDelete: fn(),
    onAdd: fn(),
    onBack: fn(),
    onSkip: fn(),
    onNext: fn(),
  },
  decorators: [
    (Story) => (
      <ProvidersPreviewWrapper>
        <Story />
      </ProvidersPreviewWrapper>
    ),
  ],
} satisfies Meta<typeof ProvidersScreenView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  args: {
    configs: [],
    testStatuses: {},
    noLocalMachine: false,
  },
};

export const WaitingForLocalMachine: Story = {
  args: {
    configs: [],
    testStatuses: {},
    noLocalMachine: true,
  },
};

export const Untested: Story = {
  args: {
    configs: [claudeConfig, codexConfig],
    testStatuses: {},
    noLocalMachine: false,
  },
};

export const CheckingProvider: Story = {
  args: {
    configs: [claudeConfig, codexConfig],
    testStatuses: {},
    testActivities: {
      [claudeConfig.id]: { phase: 'probing-provider' },
    },
    noLocalMachine: false,
  },
};

export const DownloadingRuntime: Story = {
  args: {
    configs: [claudeConfig, codexConfig, kimiConfig],
    testStatuses: {
      [claudeConfig.id]: 'passed',
    },
    testActivities: {
      [codexConfig.id]: { phase: 'downloading-runtime', percent: 64 },
      [kimiConfig.id]: { phase: 'extracting-runtime' },
    },
    selectedProviderId: codexConfig.id,
    noLocalMachine: false,
  },
};

export const RecheckingVerified: Story = {
  args: {
    configs: [claudeConfig, codexConfig],
    testStatuses: {
      [claudeConfig.id]: 'passed',
      [codexConfig.id]: 'passed',
    },
    testActivities: {
      [claudeConfig.id]: { phase: 'probing-provider' },
    },
    selectedProviderId: claudeConfig.id,
    noLocalMachine: false,
  },
};

export const AuthenticationRequired: Story = {
  args: {
    configs: [{ ...claudeConfig, env: {} }, { ...codexConfig, env: {} }, kimiConfig],
    testStatuses: {
      [claudeConfig.id]: 'needs-auth',
      [codexConfig.id]: 'needs-auth',
      [kimiConfig.id]: 'needs-auth',
    },
    noLocalMachine: false,
    localMachineId: machineId,
  },
};

export const OnePassed: Story = {
  args: {
    configs: [claudeConfig, codexConfig, augmentConfig],
    testStatuses: {
      [claudeConfig.id]: 'passed',
    },
    noLocalMachine: false,
  },
};

const manyConfigs: AgentConfigMeta[] = Array.from({ length: 8 }, (_, i) => ({
  id: `cfg-many-${i}` as AgentConfigId,
  machineId,
  name: i % 2 === 0 ? `Claude Profile ${i}` : `Codex Profile ${i}`,
  description: undefined,
  cliType: 'builtin',
  agentType: i % 2 === 0 ? 'claude' : 'codex',
  env: {},
}));

export const ScrollsWhenLong: Story = {
  args: {
    configs: manyConfigs,
    testStatuses: {
      [manyConfigs[0]!.id]: 'passed',
      [manyConfigs[3]!.id]: 'failed',
    },
    noLocalMachine: false,
  },
};

/**
 * Mirrors the production flow where the local machine already has cached
 * capabilities for both built-in agents — every row should arrive in the
 * `Verified` state and the Next button should be enabled.
 */
export const PreVerifiedFromCache: Story = {
  args: {
    configs: [claudeConfig, codexConfig],
    testStatuses: {
      [claudeConfig.id]: 'passed',
      [codexConfig.id]: 'passed',
    },
    noLocalMachine: false,
  },
};

export const MixedStatuses: Story = {
  args: {
    configs: [claudeConfig, codexConfig, augmentConfig],
    testStatuses: {
      [claudeConfig.id]: 'passed',
      [codexConfig.id]: 'failed',
      [augmentConfig.id]: 'untested',
    },
    failureReasons: {
      [codexConfig.id]: 'The OPENAI_API_KEY was rejected by the provider.',
    },
    noLocalMachine: false,
  },
};

export const InteractiveSuccess: Story = {
  args: {
    configs: [claudeConfig, codexConfig],
    testStatuses: {},
    noLocalMachine: false,
  },
  render: () => <InteractiveProvidersScreen initialConfigs={[claudeConfig, codexConfig]} />,
};

export const InteractiveFailure: Story = {
  args: {
    configs: [claudeConfig, codexConfig],
    testStatuses: {},
    noLocalMachine: false,
  },
  render: () => (
    <InteractiveProvidersScreen initialConfigs={[claudeConfig, codexConfig]} forceFailure />
  ),
};
