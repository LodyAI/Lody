import { useMemo, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Provider, createStore } from 'jotai';
import { createLocalPlatformProvider, createStaticStore } from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import {
  getAgentConfigRoomId,
  type AgentConfigId,
  type AgentConfigMeta,
  type LocalProjectId,
  type MachineId,
  type WorkspaceId,
} from '@lody/shared';
import { userAtom } from '@/atoms';
import { agentConfigMetaCacheAtom } from '@/atoms/doc-meta';
import { runtimeAtom } from '@/atoms/runtime';
import { currentWorkspaceSlugAtom } from '@/atoms/workspace-context';
import { FirstTaskScreen } from '@/components/onboarding';

const workspaceId = 'workspace-onboarding-first-task' as WorkspaceId;
const machineId = 'machine-onboarding-first-task' as MachineId;
const project = {
  kind: 'local' as const,
  machineId,
  localProjectId: 'project-lody' as LocalProjectId,
  name: 'Lody',
};
const configs: AgentConfigMeta[] = [
  {
    id: 'provider-claude' as AgentConfigId,
    machineId,
    name: 'Claude Code',
    description: undefined,
    cliType: 'builtin',
    agentType: 'claude',
    env: {},
  },
  {
    id: 'provider-kimi' as AgentConfigId,
    machineId,
    name: 'Kimi',
    description: undefined,
    cliType: 'builtin',
    agentType: 'kimi',
    env: {},
  },
];

const storyPlatform = createLocalPlatformProvider({
  session: createStaticStore({
    status: 'authenticated',
    user: { id: 'user-onboarding-first-task', name: 'Wibus' },
  }),
  workspaces: createStaticStore({
    status: 'ready',
    workspaces: [
      {
        id: workspaceId,
        name: 'Lody',
        slug: 'lody',
        role: 'owner',
      },
    ],
    activeWorkspaceId: workspaceId,
  }),
});

function MultipleProvidersStory() {
  const [selectedAgentConfigId, setSelectedAgentConfigId] = useState(configs[0]!.id);
  const [completed, setCompleted] = useState(false);
  const store = useMemo(() => {
    const next = createStore();
    next.set(userAtom, {
      id: 'user-onboarding-first-task',
      name: 'Wibus',
      email: 'wibus@example.com',
    });
    next.set(currentWorkspaceSlugAtom, 'lody');
    next.set(runtimeAtom, {
      workspaceId,
      workspaceSlug: 'lody',
    } as never);
    next.set(
      agentConfigMetaCacheAtom,
      Object.fromEntries(configs.map((config) => [getAgentConfigRoomId(config.id), config]))
    );
    return next;
  }, []);

  if (completed) {
    return <div data-testid="first-task-skipped" />;
  }

  return (
    <PlatformContext.Provider value={storyPlatform}>
      <Provider store={store}>
        <FirstTaskScreen
          agentConfigId={selectedAgentConfigId}
          project={project}
          onBack={() => {}}
          onAgentConfigChange={(config) => setSelectedAgentConfigId(config.id)}
          onSkip={() => setCompleted(true)}
          onContinue={async () => {
            setCompleted(true);
            return true;
          }}
        />
      </Provider>
    </PlatformContext.Provider>
  );
}

const meta = {
  title: 'Onboarding/FirstTaskScreen',
  component: MultipleProvidersStory,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof MultipleProvidersStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const MultipleProviders: Story = {
  render: () => <MultipleProvidersStory />,
};
