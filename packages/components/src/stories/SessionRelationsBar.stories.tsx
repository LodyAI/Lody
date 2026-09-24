import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import type { MachineId, SessionId, SessionMeta } from '@lody/shared';
import { SessionInfoBar } from '@/components/sessions/session-info-bar';
import {
  SessionRelationsBar,
  type SessionRelationsBarItem,
} from '@/components/sessions/session-relations-bar';

const ROOT_ID = 'session-root' as SessionId;

const makeItem = (
  id: string,
  title: string,
  agentType: string,
  parentSessionId?: SessionId
): SessionRelationsBarItem => {
  const sessionId = id as SessionId;
  const session = {
    id: sessionId,
    machineId: 'machine-1' as MachineId,
    createdAt: '2026-09-24T00:00:00.000Z',
    userId: 'user-1',
    cliType: 'builtin',
    agentType,
    title,
    ...(parentSessionId ? { parentSessionId } : {}),
  } as SessionMeta;
  return {
    sessionId,
    title,
    session,
    target: parentSessionId
      ? { sessionId: parentSessionId, tabSessionId: sessionId }
      : { sessionId },
  };
};

const PARENT = makeItem('session-parent', 'Plan the relations bar rollout', 'claude');
const CREATED = [
  makeItem('session-a', 'Review local project branch state fix', 'codex'),
  makeItem('tab-b', 'Write the relations bar unit tests', 'claude', ROOT_ID),
  makeItem('session-c', 'Audit MCP create Operation cards on mobile', 'claude'),
];

function StoryHarness({
  parent,
  created,
  defaultExpanded,
}: {
  parent: SessionRelationsBarItem | null;
  created: SessionRelationsBarItem[];
  defaultExpanded?: boolean;
}) {
  return (
    <div className="flex max-w-full flex-col" style={{ width: 720 }}>
      <div className="h-56" />
      <SessionRelationsBar
        parent={parent}
        created={created}
        onOpenSession={fn()}
        defaultExpanded={defaultExpanded}
      />
      <SessionInfoBar
        status={null}
        projectName="LodyAI/Lody"
        branch="session/1bc529fc"
        diffStat={{ add: 525, del: 102 }}
        onOpenAllChanges={fn()}
      />
      <div className="h-14 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        (composer placeholder)
      </div>
    </div>
  );
}

const meta = {
  title: 'Sessions/SessionRelationsBar',
  component: StoryHarness,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof StoryHarness>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CreatedCollapsed: Story = { args: { parent: null, created: CREATED } };

export const CreatedExpanded: Story = {
  args: { parent: null, created: CREATED, defaultExpanded: true },
};

export const ParentAndCreatedCollapsed: Story = { args: { parent: PARENT, created: CREATED } };

export const ParentAndCreatedExpanded: Story = {
  args: { parent: PARENT, created: CREATED, defaultExpanded: true },
};

export const ParentOnlyExpanded: Story = {
  args: { parent: PARENT, created: [], defaultExpanded: true },
};
