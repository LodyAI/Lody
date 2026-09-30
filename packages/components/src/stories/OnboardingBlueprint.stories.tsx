import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import {
  BlueprintOnboarding,
  type BlueprintAgent,
  type BlueprintOnboardingProps,
  type BlueprintProject,
} from '@/components/onboarding/blueprint/blueprint-onboarding';
import { TestCloudPlatformProvider } from '../../tests/test-platform';

const AGENTS: BlueprintAgent[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    cliType: 'builtin',
    agentType: 'claude',
    origin: 'detected',
    status: 'ready',
  },
  {
    id: 'codex',
    name: 'Codex',
    cliType: 'builtin',
    agentType: 'codex',
    origin: 'managed',
    status: 'installing',
    percent: 42,
  },
  {
    id: 'kimi',
    name: 'Kimi Code',
    cliType: 'builtin',
    agentType: 'kimi',
    origin: 'managed',
    status: 'available',
  },
];

const PROJECTS: BlueprintProject[] = [
  { id: 'lody', name: 'lody', path: '~/Code/lody', kind: 'local' },
  { id: 'loro', name: 'loro', path: '~/Code/loro', kind: 'local' },
];

const SUGGESTIONS = [
  'Explain how this project is organised',
  'Find a flaky test and make it deterministic',
  'Review my uncommitted changes',
];

/**
 * Stands in for the machine: managed runtimes the onboarding prefetches keep
 * arriving, and picking one Lody has not fetched starts it. The component
 * only renders what it is given.
 */
function WithArrivingRuntimes(props: BlueprintOnboardingProps) {
  const [agents, setAgents] = useState(props.agents);
  useEffect(() => {
    const timer = window.setInterval(() => {
      setAgents((current) =>
        current.map((agent) => {
          if (agent.status !== 'installing') return agent;
          const percent = Math.min(100, (agent.percent ?? 0) + 1.2);
          return percent >= 100
            ? { ...agent, status: 'ready', percent: 100 }
            : { ...agent, percent };
        })
      );
    }, 160);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <BlueprintOnboarding
      {...props}
      agents={agents}
      onInstallAgent={(id) =>
        setAgents((current) =>
          current.map((agent) =>
            agent.id === id && agent.status === 'available'
              ? { ...agent, status: 'installing', percent: 0 }
              : agent
          )
        )
      }
    />
  );
}

const meta = {
  title: 'Onboarding/Blueprint',
  component: BlueprintOnboarding,
  parameters: { layout: 'fullscreen' },
  args: {
    agents: AGENTS,
    projects: PROJECTS,
    suggestions: SUGGESTIONS,
    onFinish: fn(),
    onAddAgent: fn(),
    onChooseFolder: fn(),
    onRetryAgent: fn(),
    onSignInAgent: fn(),
  },
  render: (args) => <WithArrivingRuntimes {...args} />,
  decorators: [
    (Story) => (
      <TestCloudPlatformProvider>
        <div style={{ position: 'fixed', inset: 0 }}>
          <Story />
        </div>
      </TestCloudPlatformProvider>
    ),
  ],
} satisfies Meta<typeof BlueprintOnboarding>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Opening: Story = {};

export const Agent: Story = { args: { initialPhase: 'agent' } };

export const AgentFailedAndSignIn: Story = {
  args: {
    initialPhase: 'agent',
    agents: [
      { ...AGENTS[0]!, status: 'needs-sign-in' },
      {
        ...AGENTS[1]!,
        status: 'failed',
        detail: 'Download stopped — retry',
      },
      AGENTS[2]!,
    ],
  },
};

export const Project: Story = {
  args: { initialPhase: 'project', initialAgentId: 'claude' },
};

export const FirstTask: Story = {
  args: { initialPhase: 'task', initialAgentId: 'claude', initialProjectId: 'lody' },
};

export const FirstTaskAgentStillArriving: Story = {
  args: { initialPhase: 'task', initialAgentId: 'codex', initialProjectId: 'lody' },
};

export const Handoff: Story = {
  args: {
    initialPhase: 'handoff',
    initialAgentId: 'claude',
    initialProjectId: 'lody',
    initialPrompt: 'Find a flaky test and make it deterministic',
  },
};
