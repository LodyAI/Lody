import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import type { ReactNode } from 'react';
import { Provider } from 'jotai';
import { useHydrateAtoms } from 'jotai/utils';
import {
  getMachineRoomId,
  type AgentConfigId,
  type MachineId,
  type MachineMeta,
  type WorkspaceId,
} from '@lody/shared';
import { currentWorkspaceIdAtom } from '@/atoms/workspace-context';
import { machineMetaCacheAtom } from '@/atoms/doc-meta';
import { runtimeAtom, type WorkspaceRuntime } from '@/atoms/runtime';
import { AcpAuthenticationPanel } from '@/components/settings/acp-authentication-panel';

const authFrame = stylex.create({
  frame: {
    width: '560px',
    maxWidth: 'calc(100vw - 2rem)',
    backgroundColor: 'hsl(var(--background) / 1)',
    padding: 'calc(var(--spacing) * 6)',
  },
});

const workspaceId = 'settings-story-workspace' as WorkspaceId;
const machineId = 'settings-story-machine' as MachineId;
const configId = 'settings-story-lody-agent' as AgentConfigId;

const authMethods = [
  {
    id: 'sorbet:anthropic:oauth',
    type: 'agent' as const,
    name: 'Anthropic',
    description: 'Sign in with a Claude subscription',
  },
  {
    id: 'sorbet:openai:oauth',
    type: 'agent' as const,
    name: 'ChatGPT',
    description: 'Use a ChatGPT plan',
  },
  {
    id: 'sorbet:openrouter:api-key',
    type: 'agent' as const,
    name: 'OpenRouter',
    description: 'Paste an API key',
  },
];

const capabilityEntry = {
  cacheVersion: 12,
  cliType: 'builtin',
  agentType: 'sorbet',
  sourceVersion: 'builtin-sorbet:@sorbetai/acp@0.1.0-alpha.5',
  modes: [],
  models: [],
  authMethods,
};

function machineMeta(withAdvertisedMethods: boolean): MachineMeta {
  return {
    id: machineId,
    name: 'Workstation',
    ownerUserId: 'settings-story-user',
    os: 'macOS',
    cliVersion: '0.60.0',
    sessions: [],
    protocolCapabilities: {
      providerSetup: 1,
      sorbetCredentials: 1,
      sorbetProviders: 1,
      acpProtocolAuthentication: 2,
      acpAuthenticationInteractions: 2,
      acpAuthenticationMethodSelection: 1,
    },
    acpCapabilities: withAdvertisedMethods ? { [configId]: capabilityEntry } : {},
  } as unknown as MachineMeta;
}

/** Never answers, so the panel stays in its waiting state for the screenshot. */
const waitingRuntime = {
  workspaceId,
  workspaceSlug: 'lody',
  contentMode: 'ordinary',
  accountId: 'settings-story-user',
  sendControl: () => {},
  subscribeMachineAcpAuthenticationProgress: () => () => {},
  waitForMachineAcpAuthenticateResponse: () => new Promise(() => {}),
} as unknown as WorkspaceRuntime;

function Hydrate({
  children,
  withMethods = true,
  withRuntime = false,
}: {
  children: ReactNode;
  withMethods?: boolean;
  withRuntime?: boolean;
}) {
  useHydrateAtoms([
    [machineMetaCacheAtom, { [getMachineRoomId(machineId)]: machineMeta(withMethods) }],
    ...(withRuntime
      ? [
          [currentWorkspaceIdAtom, workspaceId],
          [runtimeAtom, waitingRuntime],
        ]
      : []),
  ] as never);
  return <>{children}</>;
}

function Fixture(props: { children: ReactNode; withMethods?: boolean; withRuntime?: boolean }) {
  return (
    <Provider>
      <Hydrate {...props} />
    </Provider>
  );
}

const meta = {
  title: 'Settings/ACP authentication panel',
  component: AcpAuthenticationPanel,
  decorators: [
    (Story) => (
      <div {...stylex.props(authFrame.frame)}>
        <Story />
      </div>
    ),
  ],
  parameters: { layout: 'centered' },
  args: {
    machineId,
    configId,
    cliType: 'builtin',
    agentType: 'sorbet',
    providerName: 'Lody Agent',
    compact: true,
  },
} satisfies Meta<typeof AcpAuthenticationPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Methods the probe recorded are rows; each row is its own sign-in action. */
export const AdvertisedMethods: Story = {
  args: { layout: 'rows' },
  render: (args) => (
    <Fixture>
      <AcpAuthenticationPanel {...args} />
    </Fixture>
  ),
};

/** The older single sign-in, for a Provider with no recorded methods yet. */
export const SingleSignIn: Story = {
  args: { layout: 'default' },
  render: (args) => (
    <Fixture withMethods={false}>
      <AcpAuthenticationPanel {...args} />
    </Fixture>
  ),
};

/**
 * Row layout while a sign-in runs on the target machine: the chosen row becomes the
 * wait, names the step, shows the time spent, and keeps Cancel beside it.
 */
export const WaitingOnSignIn: Story = {
  args: { layout: 'rows' },
  render: (args) => (
    <Fixture withRuntime>
      <AcpAuthenticationPanel {...args} />
    </Fixture>
  ),
  play: async ({ canvasElement }) => {
    const { within, userEvent } = await import('storybook/test');
    const canvas = within(canvasElement);
    const buttons = await canvas.findAllByRole('button', { name: 'Sign in' });
    await userEvent.click(buttons[0]!);
  },
};
