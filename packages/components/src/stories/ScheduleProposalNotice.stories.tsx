import type { Meta, StoryObj } from '@storybook/react';
import { useMemo } from 'react';
import { Provider, createStore } from 'jotai';
import { createLocalPlatformProvider, createStaticStore } from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import {
  getAgentConfigRoomId,
  getMachineRoomId,
  getSessionRoomId,
  type AgentConfigMeta,
  type MachineMeta,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import {
  agentConfigMetaCacheAtom,
  machineMetaCacheAtom,
  sessionMetaCacheAtom,
} from '@/atoms/doc-meta';
import { Tooltip } from '@lody/ui/tooltip';
import { ScheduleProposalNotice } from '@/components/schedules/schedule-proposal-notice';

/** Offline platform plus the three metas the card resolves its target from. */
const storyPlatform = createLocalPlatformProvider({
  session: createStaticStore({
    status: 'authenticated',
    user: { id: 'owner', name: 'Zixuan' },
  }),
  workspaces: createStaticStore({
    status: 'ready',
    workspaces: [{ id: 'workspace-storybook', name: 'Storybook', slug: null, role: 'owner' }],
    activeWorkspaceId: 'workspace-storybook',
  }),
});
const machine = { id: 'macbook', name: 'MacBook Pro', ownerUserId: 'owner' } as MachineMeta;
const agent = {
  id: 'a1',
  machineId: 'macbook',
  name: 'Code reviewer',
  cliType: 'builtin',
  agentType: 'claude',
} as AgentConfigMeta;
const conversation = {
  id: 'session-1',
  agentConfigId: 'a1',
  machineId: 'macbook',
  userId: 'owner',
  project: { kind: 'github', repoFullName: 'loro-dev/lody', branch: 'main' },
} as SessionMeta;

function StoryShell({ children }: { children: React.ReactNode }) {
  const store = useMemo(() => {
    const s = createStore();
    s.set(agentConfigMetaCacheAtom, { [getAgentConfigRoomId(agent.id)]: agent });
    s.set(machineMetaCacheAtom, { [getMachineRoomId(machine.id)]: machine });
    s.set(sessionMetaCacheAtom, { [getSessionRoomId(conversation.id)]: conversation });
    return s;
  }, []);
  return (
    <PlatformContext.Provider value={storyPlatform}>
      <Provider store={store}>{children}</Provider>
    </PlatformContext.Provider>
  );
}

/**
 * An agent's proposal to schedule a task, rendered in the conversation.
 *
 * Pressing Create IS the creation — no form follows — so the card shows the
 * rule in words, where runs go, and the Agent/mode/project it resolved from
 * the conversation. Storybook has no workspace runtime, so Create reports the
 * workspace as still loading rather than creating.
 */
const meta = {
  title: 'Workspace/ScheduleProposalNotice',
  component: ScheduleProposalNotice,
  parameters: { layout: 'centered' },
  decorators: [
    (Story) => (
      <StoryShell>
        <Tooltip.Provider>
          <div className="w-[640px] bg-background p-4">
            <Story />
          </div>
        </Tooltip.Provider>
      </StoryShell>
    ),
  ],
} satisfies Meta<typeof ScheduleProposalNotice>;

export default meta;
type Story = StoryObj<typeof meta>;

const base = { sessionId: 'session-1' as SessionId, entryId: 'entry-1', itemIndex: 0 };

export const Pending: Story = {
  args: {
    ...base,
    meta: {
      proposalId: 'p1',
      title: 'Nightly review',
      prompt:
        'Review the commits merged today on `main`. Summarise anything risky and open a task for each real bug.',
      rule: { kind: 'weekdays', hour: 21, minute: 0, timeZone: 'Asia/Shanghai' },
      proposedBy: { kind: 'agent', agentConfigId: 'a1', name: 'Code reviewer' },
    },
  },
};

export const IntoOneChat: Story = {
  args: {
    ...base,
    meta: {
      proposalId: 'p2',
      title: 'Daily journal',
      prompt: 'Ask me how the day went and write the answer down.',
      rule: { kind: 'daily', hour: 22, minute: 0 },
      destination: { kind: 'own_session' },
      proposedBy: { kind: 'agent', name: 'Writer' },
    },
  },
};

export const Manual: Story = {
  args: {
    ...base,
    meta: {
      proposalId: 'p3',
      title: 'Deploy checklist',
      prompt: 'Walk through the deploy checklist and report anything that fails.',
      rule: { kind: 'manual' },
      proposedBy: { kind: 'agent', name: 'Code reviewer' },
    },
  },
};

export const Created: Story = {
  args: {
    ...base,
    meta: { ...Pending.args!.meta!, outcome: 'created', scheduleId: 'p1' },
  },
};

export const Dismissed: Story = {
  args: { ...base, meta: { ...Pending.args!.meta!, outcome: 'dismissed' } },
};
