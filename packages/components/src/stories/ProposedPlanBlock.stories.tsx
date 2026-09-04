import type { Meta, StoryObj } from '@storybook/react';

import { ProposedPlanBlock } from '@/components/ai-gui/view';

const meta = {
  title: 'AI GUI/ProposedPlanBlock',
  component: ProposedPlanBlock,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof ProposedPlanBlock>;

export default meta;
type Story = StoryObj<typeof meta>;

const sampleMarkdown = `## Goal

Add a copy button to the Proposed Plan block so users can copy the plan text.

## Steps

1. Add a \`didCopy\` state and a \`handleCopy\` callback that writes \`plan.markdown\` to the clipboard.
2. Render a ghost icon button in the header next to the status badge.
3. Toggle the icon between **Copy** and **Check** for 1.2s on success.

## Files

- \`packages/components/src/components/ai-gui/view.tsx\`
`;

export const Ready: Story = {
  args: {
    plan: {
      type: 'proposed_plan',
      turnId: 'turn-1',
      markdown: sampleMarkdown,
      status: 'completed',
      isLatest: true,
    },
    messageId: 'msg-1',
    itemIndex: 0,
  },
  render: (args) => (
    <div className="w-[520px] max-w-[calc(100vw-2rem)]">
      <ProposedPlanBlock {...args} />
    </div>
  ),
};

const longPlanMarkdown = `## Goal

Refactor the session persistence layer so history writes are batched and crash-safe.

## Background

The current implementation writes every turn increment to disk synchronously. On
large sessions this produces thousands of small writes per minute and, on crash,
can leave the last write half-flushed.

## Steps

1. Introduce a write-ahead buffer in \`apps/cli/src/session/history-store.ts\`
   that accumulates turn deltas and flushes on a 2s idle timer.
2. Add a checksum footer to each batch so a torn write is detected on load and
   truncated rather than corrupting the whole file.
3. Migrate the existing per-turn write call sites to enqueue into the buffer
   instead of writing directly.
4. On startup, replay any unflushed batches found in the WAL directory before
   opening the session for reads.
5. Add deterministic tests with an injected clock and a fault-injecting file
   system shim; no real sleeps, no wall-clock assertions.

## Files

- \`apps/cli/src/session/history-store.ts\` — new buffered writer
- \`apps/cli/src/session/history-wal.ts\` — WAL format and replay
- \`apps/cli/tests/session-history-wal.test.ts\` — torn-write and replay tests
- \`apps/cli/src/agent/agent-client.ts\` — enqueue call sites

## Risks

- A flush happening mid-turn could interleave with a concurrent session; the
  buffer must be keyed by session id and drained in order.
- Replay on startup must be idempotent: re-applying an already-applied batch is
  a no-op, detected by batch sequence number.
- The 2s idle timer must not keep the process alive past shutdown; use an
  unref'd timer and flush synchronously on exit.

## Rollback

Keep the old direct-write path behind a flag for one release. If the buffered
writer shows data loss in the wild, flip the flag back without a migration —
both formats read the same history file shape.

## Verification

- New unit tests for torn writes, out-of-order replay, and shutdown flush.
- Existing \`acp-history.test.ts\` and \`history-apply.test.ts\` must stay green.
- Manual smoke: start a session, kill -9 the CLI mid-turn, restart, confirm the
  turn history is intact up to the last flushed batch.
`;

export const LongPlanOverflow: Story = {
  args: {
    plan: {
      type: 'proposed_plan',
      turnId: 'turn-3',
      markdown: longPlanMarkdown,
      status: 'completed',
      isLatest: true,
    },
    messageId: 'msg-3',
    itemIndex: 0,
    awaitingDecision: true,
  },
  render: (args) => (
    <div className="w-[520px] max-w-[calc(100vw-2rem)]">
      <ProposedPlanBlock {...args} />
    </div>
  ),
};

export const Drafting: Story = {
  args: {
    plan: {
      type: 'proposed_plan',
      turnId: 'turn-1',
      markdown: sampleMarkdown,
      status: 'delta',
      isLatest: true,
    },
    messageId: 'msg-2',
    itemIndex: 0,
  },
  render: (args) => (
    <div className="w-[520px] max-w-[calc(100vw-2rem)]">
      <ProposedPlanBlock {...args} />
    </div>
  ),
};
