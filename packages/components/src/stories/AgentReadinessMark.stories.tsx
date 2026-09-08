import type { Meta, StoryObj } from '@storybook/react';

import { AgentReadinessMark } from '@/components/shared/agent-readiness-mark';

const meta = {
  title: 'Shared/AgentReadinessMark',
  component: AgentReadinessMark,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof AgentReadinessMark>;

export default meta;
type Story = StoryObj<typeof meta>;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex w-72 items-center justify-between gap-6 rounded-lg border border-border/60 px-4 py-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

/**
 * The whole vocabulary in one frame: saturation carries readiness, and the ring
 * carries the wait — filling when there is a denominator, orbiting when there
 * is not.
 */
export const Vocabulary: Story = {
  args: { cliType: 'builtin', agentType: 'codex', readiness: 'ready' },
  render: () => (
    <div className="flex flex-col gap-3">
      <Row label="cold — nothing prepared yet">
        <AgentReadinessMark cliType="builtin" agentType="codex" readiness="cold" />
      </Row>
      <Row label="arriving · 8% (ring fills)">
        <AgentReadinessMark cliType="builtin" agentType="codex" readiness="arriving" percent={8} />
      </Row>
      <Row label="arriving · 62% (ring fills)">
        <AgentReadinessMark cliType="builtin" agentType="codex" readiness="arriving" percent={62} />
      </Row>
      <Row label="arriving · no denominator (arc orbits)">
        <AgentReadinessMark
          cliType="builtin"
          agentType="codex"
          readiness="arriving"
          percent={null}
        />
      </Row>
      <Row label="ready — says nothing at all">
        <AgentReadinessMark cliType="builtin" agentType="codex" readiness="ready" />
      </Row>
    </div>
  ),
};

/** The logo wall lighting up: an inventory filling in, not a queue of waits. */
export const InventoryFillingIn: Story = {
  args: { cliType: 'builtin', agentType: 'kimi', readiness: 'ready' },
  render: () => (
    <div className="flex items-center gap-4">
      <AgentReadinessMark cliType="builtin" agentType="kimi" readiness="ready" size="sm" />
      <AgentReadinessMark
        cliType="builtin"
        agentType="codex"
        readiness="arriving"
        percent={47}
        size="sm"
      />
      <AgentReadinessMark cliType="builtin" agentType="claude" readiness="cold" size="sm" />
    </div>
  ),
};

export const Sizes: Story = {
  args: { cliType: 'builtin', agentType: 'claude', readiness: 'arriving', percent: 40 },
  render: () => (
    <div className="flex items-center gap-4">
      <AgentReadinessMark
        cliType="builtin"
        agentType="claude"
        readiness="arriving"
        percent={40}
        size="sm"
      />
      <AgentReadinessMark
        cliType="builtin"
        agentType="claude"
        readiness="arriving"
        percent={40}
        size="md"
      />
      <AgentReadinessMark
        cliType="builtin"
        agentType="claude"
        readiness="arriving"
        percent={40}
        size="lg"
      />
    </div>
  ),
};
