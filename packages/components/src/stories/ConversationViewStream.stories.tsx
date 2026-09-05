/**
 * The conversation stream over a real doc-backed `ConversationView`: 3,000
 * turns written into a `LoroDoc` through `HistoryWriter`, read back through
 * the windowed view, so only the viewport (plus two screens each side) is
 * hydrated. Scroll far and fast to watch placeholders swap into real rows;
 * click outline ticks to jump into never-measured territory; expand a
 * "Worked for …" group to check that expansion still lands rows under the
 * same rail.
 */
import { useMemo } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import type { SessionHistory, SessionId } from '@lody/shared';
import { LoroDoc } from 'loro-crdt';
import { MessageRowView, SessionChatStreamView } from '@/components/ai-gui/view';
import type { SessionChatStreamViewProps } from '@/components/ai-gui/view';
import { useConversationStreamItems } from '@/hooks/use-conversation-stream-items';
import {
  createConversationViewFromDoc,
  createHistoryWriter,
  type ConversationView,
} from '@/lib/conversation-view';

const meta = {
  title: 'Sessions/ConversationView',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const sessionId = 'session-conversation-view-storybook' as SessionId;
const ROUNDS = 1500; // 3,000 turns

/** Deterministic — no `Math.random`, no clock. */
const LOREM =
  'Only the viewport is hydrated; every other turn is a placeholder sized from its index row until the reader gets there. ';
const CJK =
  '只有视口附近的轮次会被加载；其余轮次先用索引行估算高度，等滚动到达时再换成真实内容。';

const paragraphs = (count: number, seed: number): string =>
  Array.from({ length: count }, (_unused, index) =>
    (index + seed) % 3 === 2 ? CJK.repeat(2 + ((index + seed) % 3)) : LOREM.repeat(2 + ((index + seed) % 4))
  ).join('\n\n');

const at = (n: number) => new Date(Date.UTC(2026, 7, 19, 9, 0, 0) + n * 60_000).toISOString();

function buildHistory(rounds: number): SessionHistory[] {
  const history: SessionHistory[] = [];
  for (let round = 0; round < rounds; round += 1) {
    history.push({
      id: `v-user-${round}`,
      role: 'user',
      timestamp: at(round * 2),
      read: true,
      finished: true,
      status: 'handled',
      fileDiff: [],
      items: [
        {
          type: 'text',
          text:
            round % 5 === 0
              ? `Round ${round + 1}: investigate why the far jump lands short`
              : round % 5 === 1
                ? `第 ${round + 1} 轮：把修复应用上去，然后重跑整个测试套件`
                : `Round ${round + 1}: apply the fix and re-run the suite`,
        },
      ],
      inputConfig: {
        prompt: `Round ${round + 1}`,
        cliType: 'builtin',
        agentType: 'claude',
        modeId: round % 2 === 0 ? 'default' : 'plan',
        modelId: 'sonnet',
      },
    } as unknown as SessionHistory);
    const paragraphCount = round === 42 ? 120 : 1 + (round % 4) * 3;
    history.push({
      id: `v-assistant-${round}`,
      role: 'assistant',
      timestamp: at(round * 2 + 1),
      userTurnId: `v-user-${round}`,
      endedAt: Date.UTC(2026, 7, 19, 9, 0, 0) + (round * 2 + 1) * 60_000 + 42_000,
      finished: true,
      fileDiff: [],
      items: [
        { type: 'thought', text: `Thinking about round ${round + 1}.` },
        {
          type: 'tool_call',
          toolCallId: `v-tool-${round}-1`,
          status: 'completed',
          title: `Read src/module-${round}.ts`,
          kind: 'read',
          rawInput: { path: `src/module-${round}.ts` },
        },
        {
          type: 'tool_call',
          toolCallId: `v-tool-${round}-2`,
          status: 'completed',
          title: `Edit src/module-${round}.ts`,
          kind: 'edit',
          rawInput: { path: `src/module-${round}.ts` },
        },
        { type: 'text', text: `Answer for round ${round + 1}.\n\n${paragraphs(paragraphCount, round)}` },
      ],
    } as unknown as SessionHistory);
  }
  return history;
}

/** One doc per story load; the writer is the production write path. */
function openWindowedView(rounds: number): ConversationView {
  const doc = new LoroDoc();
  doc.getMap('session').set('id', sessionId);
  const view = createConversationViewFromDoc(doc, { sessionId });
  const writer = createHistoryWriter(doc, view);
  for (const entry of buildHistory(rounds)) writer.append(entry);
  return view;
}

const renderMessageRow: SessionChatStreamViewProps['renderMessageRow'] = ({
  message,
  sessionId: rowSessionId,
}) => <MessageRowView message={message} sessionId={rowSessionId} />;

function WindowedStream({ rounds }: { rounds: number }) {
  const view = useMemo(() => openWindowedView(rounds), [rounds]);
  const {
    items,
    lastAssistantMessageId,
    lastCompletedAssistantMessageId,
    onVisibleTurnRangeChange,
    onOutlinePreviewRound,
  } = useConversationStreamItems(view, sessionId);
  return (
    <div className="h-[720px] w-full bg-background">
      <SessionChatStreamView
        items={items}
        sessionId={sessionId}
        className="h-full"
        renderMessageRow={renderMessageRow}
        showScrollToLatest={false}
        lastAssistantMessageId={lastAssistantMessageId}
        lastCompletedAssistantMessageId={lastCompletedAssistantMessageId}
        onVisibleTurnRangeChange={onVisibleTurnRangeChange}
        onOutlinePreviewRound={onOutlinePreviewRound}
      />
    </div>
  );
}

/** 3,000 turns behind a windowed view: scroll, outline jumps, and group expansion. */
export const ExtremeConversationWindowed: Story = {
  render: () => <WindowedStream rounds={ROUNDS} />,
};

/** A short conversation on the same path, for quick visual checks. */
export const ShortConversationWindowed: Story = {
  render: () => <WindowedStream rounds={6} />,
};
