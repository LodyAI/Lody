/**
 * The conversation's left table of contents: one tick per round, the current
 * round highlighted, an opening-words card on hover.
 *
 * The rail is `position: absolute` inside the conversation pane and only
 * renders above an `@[860px]` container width, so every story wraps it in an
 * `@container` box wide enough to satisfy that query — a narrower frame renders
 * nothing, which is the production behaviour, not a broken story.
 */
import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import type { SessionHistoryParsed, SessionId } from '@lody/shared';
import { ConversationOutlineRail } from '@/components/ai-gui/conversation-outline-rail';
import type { ChatStreamItem, SessionChatStreamViewProps } from '@/components/ai-gui/view';
import { MessageRowView, SessionChatStreamView } from '@/components/ai-gui/view';
import type { ConversationOutlineEntry } from '@/lib/conversation-outline';

const meta = {
  title: 'Sessions/ConversationOutlineRail',
  component: ConversationOutlineRail,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof ConversationOutlineRail>;

export default meta;
type Story = StoryObj<typeof meta>;

const entry = (
  index: number,
  title: string,
  preview: string,
  weight: ConversationOutlineEntry['weight'] = 1
): ConversationOutlineEntry => ({
  key: `round-${index}`,
  messageIndex: index * 2,
  title,
  preview,
  startsWithAgent: false,
  weight,
});

const shortConversation: ConversationOutlineEntry[] = [
  entry(
    0,
    'Add a message navigator to the session view',
    'Here is what I found in the current virtual scroll implementation, and how the rail can hook into it.',
    2
  ),
  entry(1, 'Will there be performance problems?', 'Not with three constraints in place.', 3),
  entry(2, 'Ship it', 'Opened the pull request.', 0),
];

/**
 * Enough rounds to overflow the rail and exercise its internal scrolling. At
 * the 8px tick pitch a 520px pane fits ~63 rounds, and a full-height desktop
 * pane fits well over a hundred, so overflow needs a deliberately long session.
 */
const longConversation: ConversationOutlineEntry[] = Array.from({ length: 140 }, (_, index) =>
  entry(
    index,
    `Round ${index + 1}: ${index % 3 === 0 ? 'investigate the failing test' : 'apply the fix and re-run'}`,
    `Agent reply for round ${index + 1}. It opens with a sentence or two of prose before any tool work.`,
    (index % 4) as ConversationOutlineEntry['weight']
  )
);

/**
 * The rail alone is invisible on an empty canvas, so every story paints a
 * stand-in conversation column beside it — matching production's 46rem centered
 * measure — to show where the rail sits relative to message content.
 */
function RailFrame({
  entries,
  initialActiveIndex = 0,
  height = 520,
}: {
  entries: ConversationOutlineEntry[];
  initialActiveIndex?: number;
  height?: number;
}) {
  const [activeIndex, setActiveIndex] = useState(initialActiveIndex);
  return (
    <div className="@container relative w-full bg-background" style={{ height }}>
      <div className="mx-auto flex h-full w-full max-w-[46rem] flex-col gap-3 overflow-hidden px-4 py-6">
        {entries.slice(activeIndex, activeIndex + 4).map((item) => (
          <div key={item.key} className="rounded-md border border-border/60 p-3">
            <div className="text-[13px] font-medium text-foreground">{item.title}</div>
            <div className="mt-1 text-[12px] text-muted-foreground">{item.preview}</div>
          </div>
        ))}
      </div>
      <ConversationOutlineRail
        entries={entries}
        activeIndex={activeIndex}
        onJumpToRound={setActiveIndex}
      />
    </div>
  );
}

export const ShortConversation: Story = {
  args: { entries: shortConversation, activeIndex: 0, onJumpToRound: () => {} },
  render: () => <RailFrame entries={shortConversation} />,
};

export const ActiveRoundInTheMiddle: Story = {
  args: { entries: shortConversation, activeIndex: 1, onJumpToRound: () => {} },
  render: () => <RailFrame entries={shortConversation} initialActiveIndex={1} />,
};

/** 140 rounds in a 520px pane: the strip scrolls and keeps the active tick in view. */
export const OverflowingConversation: Story = {
  args: { entries: longConversation, activeIndex: 90, onJumpToRound: () => {} },
  render: () => <RailFrame entries={longConversation} initialActiveIndex={90} />,
};

/**
 * Mirrors a tall composer consuming the lower part of a conversation page.
 * The rail used to be mounted in the shrinking message area, so it centres
 * visibly too high here. This is retained as an explicit visual regression
 * state; production passes the full-page overlay root instead.
 */
function ComposerHeightFrame({ pageLevelOverlay }: { pageLevelOverlay: boolean }) {
  const [outlineOverlayRoot, setOutlineOverlayRoot] = useState<HTMLDivElement | null>(null);
  const activeIndex = 44;
  return (
    <div className="@container relative flex h-[720px] w-full flex-col overflow-hidden bg-background">
      {pageLevelOverlay ? (
        <div
          ref={setOutlineOverlayRoot}
          className="pointer-events-none absolute inset-0 @container"
        />
      ) : null}
      <div className="relative min-h-0 flex-1 overflow-hidden border-b border-border/70">
        <div className="mx-auto h-full max-w-[46rem] px-4 py-6 text-sm text-muted-foreground">
          The message viewport shrinks as the composer grows. The outline should remain centred in
          the page, not in this remaining area.
        </div>
        <ConversationOutlineRail
          entries={longConversation}
          activeIndex={activeIndex}
          onJumpToRound={() => {}}
          overlayRoot={outlineOverlayRoot}
        />
      </div>
      <div className="h-[260px] shrink-0 border-t border-border bg-muted/20 p-4">
        <div className="mx-auto h-full max-w-[46rem] rounded-xl border border-border bg-background p-4 text-sm text-muted-foreground">
          Tall composer
        </div>
      </div>
    </div>
  );
}

export const ComposerExpandedBefore: Story = {
  args: { entries: [], activeIndex: -1, onJumpToRound: () => {} },
  render: () => <ComposerHeightFrame pageLevelOverlay={false} />,
};

export const ComposerExpandedAfter: Story = {
  args: { entries: [], activeIndex: -1, onJumpToRound: () => {} },
  render: () => <ComposerHeightFrame pageLevelOverlay />,
};

/** A CJK title and a round the agent started, to check truncation and fallbacks. */
export const MixedContent: Story = {
  args: { entries: [], activeIndex: 0, onJumpToRound: () => {} },
  render: () => (
    <RailFrame
      entries={[
        {
          ...entry(
            0,
            '把会话左侧加上每轮对话的定位目录，方便快速跳转到不同的轮次',
            '已按文档方案实现完成。',
            2
          ),
        },
        { ...entry(1, 'Scheduled run', ''), startsWithAgent: true },
        { ...entry(2, 'Still working on it', ''), weight: 0 },
      ]}
    />
  ),
};

/** Fewer than two rounds: the rail does not render at all. */
export const HiddenBelowTwoRounds: Story = {
  args: { entries: [], activeIndex: -1, onJumpToRound: () => {} },
  render: () => <RailFrame entries={[entry(0, 'Only one round', 'Nothing to navigate.')]} />,
};

// ---------------------------------------------------------------------------
// Integration: the rail inside the REAL virtualized stream.
//
// The isolated stories above cannot catch the wiring that actually matters —
// deriving the outline from `items`, mapping rounds to Virtua rows, and
// tracking the reader from Virtua's offsets. This one renders the production
// `SessionChatStreamView` so scrolling and jumping exercise the real path.
// ---------------------------------------------------------------------------

const integrationSessionId = 'session-outline-rail-storybook' as SessionId;

const renderMessageRow: SessionChatStreamViewProps['renderMessageRow'] = ({
  message,
  sessionId,
}) => <MessageRowView message={message} sessionId={sessionId} />;

const historyMessage = (
  id: string,
  role: 'user' | 'assistant',
  text: string
): SessionHistoryParsed =>
  ({
    id,
    role,
    timestamp: '2026-08-19T09:00:00.000Z',
    read: true,
    finished: role === 'assistant',
    items: [{ type: 'text', text }],
  }) as unknown as SessionHistoryParsed;

const integrationItems: ChatStreamItem[] = Array.from({ length: 14 }, (_, round) => [
  {
    type: 'message' as const,
    sessionId: integrationSessionId,
    turnIndex: round * 2,
    message: historyMessage(
      `user-${round}`,
      'user',
      `Round ${round + 1}: ${
        round % 2 === 0
          ? 'why does the outline rail need Virtua index math instead of an observer?'
          : 'apply the fix and re-run the suite'
      }`
    ),
  },
  {
    type: 'message' as const,
    sessionId: integrationSessionId,
    turnIndex: round * 2 + 1,
    message: historyMessage(
      `assistant-${round}`,
      'assistant',
      `Answer for round ${round + 1}. Because the list is virtualized, most rounds have no DOM at all, so position has to come from the virtualizer's own offsets.\n\n${'Filler paragraph so the turn is tall enough to scroll through. '.repeat(6)}`
    ),
  },
]).flat();

/**
 * Scroll the conversation and the highlighted tick follows; click a tick and
 * the list jumps to that round.
 */
export const InsideTheConversationStream: Story = {
  args: { entries: [], activeIndex: -1, onJumpToRound: () => {} },
  render: () => (
    <div className="h-[640px] w-full bg-background">
      <SessionChatStreamView
        items={integrationItems}
        sessionId={integrationSessionId}
        className="h-full"
        renderMessageRow={renderMessageRow}
        showScrollToLatest={false}
      />
    </div>
  ),
};

// ---------------------------------------------------------------------------
// The extreme case, in the real stream.
//
// Everything above is comfortable. This is the shape that actually breaks
// things: a session long enough that the rail must scroll internally, turns
// long enough that Virtua is estimating most of the offsets a far jump lands
// on, and rounds whose titles and previews stress the summary extraction.
// ---------------------------------------------------------------------------

const extremeSessionId = 'session-outline-rail-extreme-storybook' as SessionId;

const EXTREME_ROUND_COUNT = 120;

/** Deterministic — a story that generates different content per run is useless
 *  for comparing before and after. No `Math.random`, no clock. */
const LOREM =
  'The rail derives its outline from the item list rather than the DOM, because a virtualized conversation only mounts the rows near the viewport. ';
const CJK_LOREM =
  '会话左侧的目录来自消息列表而不是 DOM，因为虚拟滚动只会挂载视口附近的行，屏幕外的轮次根本没有元素可以观察。';

const paragraphs = (count: number, seed: number): string =>
  Array.from({ length: count }, (_unused, index) =>
    (index + seed) % 3 === 2
      ? CJK_LOREM.repeat(2 + ((index + seed) % 3))
      : LOREM.repeat(2 + ((index + seed) % 4))
  ).join('\n\n');

const extremeUserText = (round: number): string => {
  if (round === 0) {
    // A user turn long enough that the title has to truncate hard.
    return `Round 1: ${LOREM.repeat(6)}`;
  }
  if (round === 7) {
    // CJK title — truncation counts code points, not UTF-16 units.
    return `第 8 轮：${CJK_LOREM.repeat(3)}`;
  }
  if (round === 13) return '?'; // Degenerate: almost nothing to title with.
  if (round % 5 === 0) return `Round ${round + 1}: investigate why the far jump lands short`;
  if (round % 5 === 1) return `第 ${round + 1} 轮：把修复应用上去，然后重跑整个测试套件`;
  return `Round ${round + 1}: apply the fix and re-run the suite`;
};

const extremeItems: ChatStreamItem[] = (() => {
  const items: ChatStreamItem[] = [];
  for (let round = 0; round < EXTREME_ROUND_COUNT; round += 1) {
    items.push({
      type: 'message',
      sessionId: extremeSessionId,
      turnIndex: items.length,
      message: historyMessage(`x-user-${round}`, 'user', extremeUserText(round)),
    });

    // Round 21 gets no reply at all: the preview must fall back rather than
    // borrow the next round's answer.
    if (round === 21) continue;

    // Round 42 is the monster — a single answer far past the summary read
    // window, proving the markdown cleanup never runs over a whole turn.
    const paragraphCount = round === 42 ? 220 : 1 + (round % 4) * 4;
    items.push({
      type: 'message',
      sessionId: extremeSessionId,
      turnIndex: items.length,
      message: historyMessage(
        `x-assistant-${round}`,
        'assistant',
        `Answer for round ${round + 1}.\n\n${paragraphs(paragraphCount, round)}`
      ),
    });
  }
  return items;
})();

/**
 * 120 rounds, turns from one paragraph to 220, mixed CJK, one round with no
 * reply, one degenerate title, and one enormous answer. The rail overflows and
 * scrolls internally, and jumps land in territory Virtua has never measured.
 */
export const ExtremeConversation: Story = {
  args: { entries: [], activeIndex: -1, onJumpToRound: () => {} },
  render: () => (
    <div className="h-[720px] w-full bg-background">
      <SessionChatStreamView
        items={extremeItems}
        sessionId={extremeSessionId}
        className="h-full"
        renderMessageRow={renderMessageRow}
        showScrollToLatest={false}
      />
    </div>
  ),
};
