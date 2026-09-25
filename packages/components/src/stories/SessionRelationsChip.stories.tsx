import type { Meta, StoryObj } from '@storybook/react';
import { Provider, createStore } from 'jotai';
import { useState } from 'react';
import { fn } from 'storybook/test';
import {
  getLodySessionPresenceKey,
  getServerNow,
  type LodyPresenceInstanceId,
  type MachineId,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import { lodyPresenceStatesAtom } from '@/atoms/presence';
import { SessionInfoBar } from '@/components/sessions/session-info-bar';
import { SessionRelationsChip } from '@/components/sessions/session-relations-chip';
import { buildSessionRelationTree } from '@/lib/session-relation-tree';

const machineId = 'machine-1' as MachineId;
const NOW = Date.parse('2026-09-25T08:00:00.000Z');
let clock = 0;
const session = (
  id: string,
  title: string,
  agentType: string,
  extra: Partial<SessionMeta> = {}
): SessionMeta => ({
  id: id as SessionId,
  machineId,
  createdAt: new Date(NOW + clock++ * 1000).toISOString(),
  userId: 'user-1',
  cliType: 'builtin',
  agentType,
  title,
  ...extra,
});

// Plan ─ Review            (a Session)
//      └ Relations[3 Tabs] (a Session with Tabs, opened from Plan)
//          └ Mobile audit  (opened from one of those Tabs)
const SESSIONS: SessionMeta[] = [
  session('plan', 'Plan the relations rollout', 'claude'),
  session('review', 'Review local project branch state fix', 'codex', {
    openedBySessionId: 'plan' as SessionId,
    lastMessageAt: NOW,
    lastReadAt: NOW - 60_000,
  }),
  session('relations', 'Build the relations tree', 'claude', {
    openedBySessionId: 'plan' as SessionId,
  }),
  session('relations-tests', 'Write tree unit tests', 'claude', {
    parentSessionId: 'relations' as SessionId,
  }),
  session('relations-story', 'Storybook fixtures', 'codex', {
    parentSessionId: 'relations' as SessionId,
  }),
  session('mobile', 'Audit MCP cards on mobile', 'claude', {
    openedBySessionId: 'relations-story' as SessionId,
    openedByRootSessionId: 'relations' as SessionId,
  }),
];

const PRESENCE: Record<string, 'running' | 'requestPermission'> = {
  'relations-tests': 'running',
  mobile: 'requestPermission',
};

function buildPresenceStates() {
  return Object.fromEntries(
    Object.entries(PRESENCE).map(([sessionId, type]) => {
      const instanceId = `storybook-${sessionId}` as LodyPresenceInstanceId;
      return [
        getLodySessionPresenceKey(sessionId as SessionId, instanceId),
        {
          kind: 'session' as const,
          sessionId: sessionId as SessionId,
          machineId,
          instanceId,
          status: { type },
          updatedAt: getServerNow(),
        },
      ];
    })
  );
}

function StoryHarness({
  currentSessionId,
  defaultOpen,
}: {
  currentSessionId: string;
  defaultOpen?: boolean;
}) {
  const [store] = useState(() => {
    const next = createStore();
    next.set(lodyPresenceStatesAtom, buildPresenceStates());
    return next;
  });
  const tree = buildSessionRelationTree(SESSIONS, currentSessionId as SessionId)!;
  return (
    <Provider store={store}>
      <div className="flex max-w-full flex-col" style={{ width: 720 }}>
        {/* Room above the bar so the popover (side=top) stays visible. */}
        <div className="h-60" />
        <SessionInfoBar
          status={null}
          projectName="LodyAI/Lody"
          branch="session/1bc529fc"
          diffStat={{ add: 525, del: 102 }}
          onOpenAllChanges={fn()}
          relations={
            <SessionRelationsChip
              tree={tree}
              currentSessionId={currentSessionId as SessionId}
              onOpenSession={fn()}
              defaultOpen={defaultOpen}
            />
          }
        />
        <div className="h-14 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          (composer placeholder)
        </div>
      </div>
    </Provider>
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

export const Closed: Story = { args: { currentSessionId: 'relations' } };

export const OpenFromMiddle: Story = {
  args: { currentSessionId: 'relations', defaultOpen: true },
};

export const OpenFromTab: Story = {
  args: { currentSessionId: 'relations-story', defaultOpen: true },
};

export const OpenFromLeaf: Story = {
  args: { currentSessionId: 'mobile', defaultOpen: true },
};
