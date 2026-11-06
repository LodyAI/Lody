import type { Meta, StoryObj } from '@storybook/react';
import type { ReactNode } from 'react';
import { Provider } from 'jotai';
import { useHydrateAtoms } from 'jotai/utils';
import {
  getAgentConfigRoomId,
  getMachineRoomId,
  type AgentConfigId,
  type AgentConfigMeta,
  type MachineId,
  type MachineMeta,
  type WorkspaceId,
} from '@lody/shared';
import { userAtom } from '@/atoms';
import { agentConfigMetaCacheAtom, machineMetaCacheAtom } from '@/atoms/doc-meta';
import { runtimeAtom, type WorkspaceRuntime } from '@/atoms/runtime';
import { developerModeEnabledAtom, lodyAgentBetaEnabledAtom } from '@/atoms/settings';
import { currentWorkspaceIdAtom } from '@/atoms/workspace-context';
import { LodyAgentSetting } from '@/components/settings/lody-agent-setting';
import { RoutedStory, SettingsStoryProviders } from './settings-story-shell';

const workspaceId = 'settings-story-workspace' as WorkspaceId;
const machineId = 'settings-story-machine' as MachineId;
const configId = 'settings-story-lody-agent' as AgentConfigId;
const userId = 'settings-story-user';

const authMethods = [
  { id: 'sorbet:prov_gateway:api_key', type: 'agent' as const, name: 'Acme Gateway API key' },
  { id: 'sorbet:prov_local:api_key', type: 'agent' as const, name: 'Local gateway API key' },
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
];

const machine = (supported: boolean): MachineMeta =>
  ({
    id: machineId,
    name: 'Zixuan’s MacBook Pro',
    ownerUserId: userId,
    os: 'macOS',
    cliVersion: '0.60.0',
    sessions: [],
    protocolCapabilities: supported
      ? {
          providerSetup: 1,
          sorbetCredentials: 1,
          sorbetProviders: 1,
          acpProtocolAuthentication: 2,
          acpAuthenticationInteractions: 2,
          acpAuthenticationMethodSelection: 1,
        }
      : {},
    acpCapabilities: supported
      ? {
          [configId]: {
            cacheVersion: 12,
            cliType: 'builtin',
            agentType: 'sorbet',
            sourceVersion: 'builtin-sorbet:@sorbetai/acp@0.1.0-alpha.5',
            modes: [],
            models: [],
            authMethods,
          },
        }
      : {},
  }) as unknown as MachineMeta;

const config: AgentConfigMeta = {
  id: configId,
  machineId,
  name: 'Lody Agent',
  cliType: 'builtin',
  agentType: 'sorbet',
  env: {},
} as AgentConfigMeta;

const storyRuntime = {
  workspaceId,
  workspaceSlug: 'lody',
  contentMode: 'ordinary',
  accountId: userId,
  sendControl: () => {},
  subscribeMachineAcpAuthenticationProgress: () => () => {},
  waitForMachineAcpAuthenticateResponse: () => new Promise(() => {}),
  requestLocalSorbetCredentials: async () => ({
    type: 'sorbet/credentials-list',
    credentials: [
      { providerId: 'anthropic', type: 'oauth' },
      { providerId: 'openai', type: 'oauth' },
    ],
  }),
  requestLocalSorbetProviders: async () => ({
    type: 'sorbet/providers-list',
    providers: [
      {
        id: 'prov_gateway',
        name: 'Acme Gateway',
        protocol: 'openai-completions',
        baseUrl: 'https://gateway.acme.dev/v1',
        models: [{ id: 'acme-large' }, { id: 'acme-small' }],
      },
      {
        id: 'prov_local',
        name: 'Local gateway',
        protocol: 'anthropic-messages',
        baseUrl: 'http://127.0.0.1:8787',
        models: [{ id: 'lody-large' }],
      },
    ],
  }),
  requestMachineAcpCapabilitiesRefresh: async () => ({
    success: true,
    machineId,
    configId,
    cliType: 'builtin',
    agentType: 'sorbet',
  }),
  repo: {
    openFlockDoc: async () => ({
      flock: { scan: () => [], subscribe: () => () => {} },
      joinRoom: async () => ({
        unsubscribe: () => {},
        firstSyncedWithRemote: Promise.resolve(),
      }),
    }),
  },
} as unknown as WorkspaceRuntime;

function Hydrate({
  children,
  supported,
  configured,
}: {
  children: ReactNode;
  supported: boolean;
  configured: boolean;
}) {
  useHydrateAtoms([
    [developerModeEnabledAtom, true],
    [lodyAgentBetaEnabledAtom, true],
    [userAtom, { id: userId, name: 'Zixuan Chen', email: 'zixuan@example.com' }],
    [machineMetaCacheAtom, { [getMachineRoomId(machineId)]: machine(supported) }],
    [
      agentConfigMetaCacheAtom,
      configured ? { [getAgentConfigRoomId(configId)]: config as never } : {},
    ],
    [currentWorkspaceIdAtom, workspaceId],
    [runtimeAtom, storyRuntime],
  ] as never);
  return <>{children}</>;
}

function PageStory({ supported, configured }: { supported: boolean; configured: boolean }) {
  return (
    <SettingsStoryProviders>
      <RoutedStory>
        <Provider>
          <Hydrate supported={supported} configured={configured}>
            <div className="p-6">
              <LodyAgentSetting />
            </div>
          </Hydrate>
        </Provider>
      </RoutedStory>
    </SettingsStoryProviders>
  );
}

const meta = {
  title: 'Settings/Lody Agent page',
  component: LodyAgentSetting,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof LodyAgentSetting>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The page after setup: saved sign-ins, custom endpoints, and the agent's methods. */
export const Connected: Story = {
  render: () => <PageStory supported configured />,
};

/** A machine that supports Lody Agent but has not set it up yet. */
export const NotSetUp: Story = {
  render: () => <PageStory supported configured={false} />,
};

/** A daemon that predates provider setup: the page says to update instead. */
export const UnsupportedMachine: Story = {
  render: () => <PageStory supported={false} configured={false} />,
};
