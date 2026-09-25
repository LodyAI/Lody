import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import type { MachineId, SessionId, SessionMeta } from '@lody/shared';
import { SessionInfoBar } from '@/components/sessions/session-info-bar';
import {
  SessionRelationsChip,
  type SessionRelationsItem,
} from '@/components/sessions/session-relations-chip';

const ROOT_ID = 'session-root' as SessionId;

const makeItem = (
  id: string,
  title: string,
  agentType: string,
  parentSessionId?: SessionId
): SessionRelationsItem => {
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
  defaultOpen,
}: {
  parent: SessionRelationsItem | null;
  created: SessionRelationsItem[];
  defaultOpen?: boolean;
}) {
  return (
    <div className="flex max-w-full flex-col" style={{ width: 720 }}>
      {/* Room above the bar so the popover (side=top) stays visible. */}
      <div className="h-56" />
      <SessionInfoBar
        status={null}
        projectName="LodyAI/Lody"
        branch="session/1bc529fc"
        diffStat={{ add: 525, del: 102 }}
        onOpenAllChanges={fn()}
        relations={
          <SessionRelationsChip
            parent={parent}
            created={created}
            onOpenSession={fn()}
            defaultOpen={defaultOpen}
          />
        }
      />
      <div className="h-14 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        (composer placeholder)
      </div>
    </div>
  );
}

const meta = {
  title: 'Sessions/SessionRelationsChip',
  component: StoryHarness,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof StoryHarness>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Closed: Story = { args: { parent: PARENT, created: CREATED } };

export const ParentAndCreatedOpen: Story = {
  args: { parent: PARENT, created: CREATED, defaultOpen: true },
};

export const CreatedOnlyOpen: Story = {
  args: { parent: null, created: CREATED, defaultOpen: true },
};

export const ParentOnlyOpen: Story = {
  args: { parent: PARENT, created: [], defaultOpen: true },
};
