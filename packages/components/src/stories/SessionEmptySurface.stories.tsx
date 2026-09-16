import type { Meta, StoryObj } from '@storybook/react';
import type { SessionMeta } from '@lody/shared';
import { SessionEmptySurface } from '@/components/sessions/session-empty-surface';

const meta = {
  title: 'Sessions/Empty Surface',
  component: SessionEmptySurface,
  args: { onNew: () => {}, onReopen: () => {} },
} satisfies Meta<typeof SessionEmptySurface>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ClosedMainAndLegacyChild: Story = {
  args: {
    closedSessions: [
      {
        id: 'main',
        title: 'Main conversation',
        machineId: 'machine',
        userId: 'user',
        createdAt: '2026-09-16T00:00:00Z',
        cliType: 'builtin',
        agentType: 'codex',
        isTabClosed: true,
      },
      {
        id: 'child',
        title: 'Previously archived child',
        machineId: 'machine',
        userId: 'user',
        createdAt: '2026-09-16T00:00:00Z',
        cliType: 'builtin',
        agentType: 'codex',
        isArchived: true,
      },
    ] as SessionMeta[],
  },
};
