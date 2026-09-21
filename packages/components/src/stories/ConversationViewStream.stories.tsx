/**
 * The conversation stream over a real doc-backed `ConversationView`: 3,000
 * turns written into a `LoroDoc` through `HistoryWriter`, read back through
 * the windowed view, so only the viewport (plus two screens each side) is
 * hydrated. Scroll far and fast to watch placeholders swap into real rows;
 * click outline ticks to jump into never-measured territory; expand a
 * "Worked for …" group to check that expansion still lands rows under the
 * same rail.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import type { SessionHistory, SessionId, WorkspaceId } from '@lody/shared';
import { LoroDoc } from 'loro-crdt';
import { MessageRowView, SessionChatStreamView } from '@/components/ai-gui/view';
import type { SessionChatStreamViewProps } from '@/components/ai-gui/view';
import type { SessionChatStreamHandle } from '@/components/ai-gui/view';
import { useConversationStreamItems } from '@/hooks/use-conversation-stream-items';
import {
  createProjectedConversationView,
  createConversationSession,
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
/** Distinct ids: the scroll-position and stream-item caches are per session. */
const SWITCH_SESSION_IDS = [
  'session-conversation-view-switch-a',
  'session-conversation-view-switch-b',
] as unknown as readonly SessionId[];

/** Deterministic — no `Math.random`, no clock. */
const LOREM =
  'Only the viewport is hydrated; every other turn is a placeholder sized from its index row until the reader gets there. ';
const CJK = '只有视口附近的轮次会被加载；其余轮次先用索引行估算高度，等滚动到达时再换成真实内容。';

const paragraphs = (count: number, seed: number): string =>
  Array.from({ length: count }, (_unused, index) =>
    (index + seed) % 3 === 2
      ? CJK.repeat(2 + ((index + seed) % 3))
      : LOREM.repeat(2 + ((index + seed) % 4))
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
        {
          type: 'text',
          text: `Answer for round ${round + 1}.\n\n${paragraphs(paragraphCount, round)}`,
        },
      ],
    } as unknown as SessionHistory);
  }
  return history;
}

/** One doc per story load; the writer is the production write path. */
function openWindowedView(entries: SessionHistory[], id: SessionId = sessionId): ConversationView {
  const doc = new LoroDoc();
  doc.getMap('session').set('id', id);
  const session = createConversationSession(doc, { sessionId: id });
  const view = session.history;
  const dispose = view.dispose;
  view.dispose = () => {
    view.dispose = dispose;
    session.dispose();
    doc.free();
  };
  const writer = session.historyWriter;
  for (const entry of entries) writer.append(entry);
  return view;
}

const renderMessageRow: SessionChatStreamViewProps['renderMessageRow'] = ({
  message,
  sessionId: rowSessionId,
}) => <MessageRowView message={message} sessionId={rowSessionId} />;

function WindowedStream({
  rounds,
  streamSessionId = sessionId,
  history,
}: {
  rounds?: number;
  streamSessionId?: SessionId;
  history?: SessionHistory[];
}) {
  const [view, setView] = useState<ConversationView | null>(null);
  useEffect(() => {
    const next = openWindowedView(history ?? buildHistory(rounds ?? ROUNDS), streamSessionId);
    setView(next);
    return () => next.dispose();
  }, [rounds, history, streamSessionId]);
  const {
    initialWindowReady,
    items,
    lastAssistantMessageId,
    lastCompletedAssistantMessageId,
    onVisibleTurnRangeChange,
    onOutlinePreviewRound,
  } = useConversationStreamItems(view, streamSessionId);
  return (
    <div className="h-[720px] w-full bg-background">
      <SessionChatStreamView
        conversationView={view}
        initialWindowReady={initialWindowReady}
        items={items}
        sessionId={streamSessionId}
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

/**
 * Open-flicker lab. The doc, the `ConversationView` and the history writes all
 * happen while the stream is UNMOUNTED, so pressing "Open" costs exactly what
 * switching to an already-loaded session costs: one mount of
 * `SessionChatStreamView` over a warm view. Frame-by-frame capture of that
 * mount is what reproduces the flash reported after #376.
 */
function OpenFlickerStory({ rounds }: { rounds: number }) {
  const [view, setView] = useState<ConversationView | null>(null);
  const [openId, setOpenId] = useState(0);
  useEffect(() => {
    const next = openWindowedView(buildHistory(rounds));
    setView(next);
    return () => next.dispose();
  }, [rounds]);
  return (
    <div className="flex h-screen flex-col bg-background">
      <div className="flex shrink-0 items-center gap-2 p-2">
        <button
          type="button"
          data-testid="open-conversation"
          disabled={!view}
          className="rounded border px-3 py-1 text-sm"
          onClick={() => setOpenId((n) => n + 1)}
        >
          Open conversation
        </button>
        <button
          type="button"
          data-testid="close-conversation"
          className="rounded border px-3 py-1 text-sm"
          onClick={() => setOpenId(0)}
        >
          Close
        </button>
        <span data-testid="view-ready">{view ? 'view-ready' : 'building'}</span>
      </div>
      <div className="min-h-0 flex-1" data-testid="conversation-slot">
        {view && openId > 0 && <OpenedStream key={openId} view={view} />}
      </div>
    </div>
  );
}

/**
 * `view` is nullable on purpose: the session page mounts this surface while
 * `useSessionDoc` is still acquiring the document, so the first render of a
 * newly opened session has no turns and takes the empty-state branch. Anything
 * that reads per-session state at mount has to survive that render.
 */
function OpenedStream({
  view,
  streamSessionId = sessionId,
}: {
  view: ConversationView | null;
  streamSessionId?: SessionId;
}) {
  const {
    initialWindowReady,
    items,
    lastAssistantMessageId,
    lastCompletedAssistantMessageId,
    onVisibleTurnRangeChange,
    onOutlinePreviewRound,
  } = useConversationStreamItems(view, streamSessionId);
  return (
    <SessionChatStreamView
      conversationView={view}
      initialWindowReady={initialWindowReady}
      items={items}
      sessionId={streamSessionId}
      className="h-full"
      // The session page always supplies a non-null fragment here, even when it
      // renders no DOM, so it counts as a Virtua row. Anything deriving "is
      // there anything to virtualize" from the item count must survive that.
      leadingContent={<></>}
      renderMessageRow={renderMessageRow}
      showScrollToLatest={false}
      lastAssistantMessageId={lastAssistantMessageId}
      lastCompletedAssistantMessageId={lastCompletedAssistantMessageId}
      onVisibleTurnRangeChange={onVisibleTurnRangeChange}
      onOutlinePreviewRound={onOutlinePreviewRound}
    />
  );
}

/** Mount the stream over a warm 3,000-turn view — the reported open flicker. */
export const OpenLongConversation: Story = {
  render: () => <OpenFlickerStory rounds={ROUNDS} />,
};

/** The same mount over 12 turns, as the contrast case. */
export const OpenShortConversation: Story = {
  render: () => <OpenFlickerStory rounds={6} />,
};

/**
 * The reported flicker as the reader meets it: two long conversations already
 * loaded, switching between them the way the sidebar does. Both views are
 * built while nothing is mounted, so a switch costs one unmount plus one
 * mount — and the incoming conversation holds a blank rectangle until its
 * initial scroll settles, which is what reads as a flash.
 */
function SwitchFlickerStory({ rounds }: { rounds: number }) {
  const [views, setViews] = useState<readonly ConversationView[] | null>(null);
  const [current, setCurrent] = useState(0);
  // The incoming session's document is not there on the first render, exactly
  // as the session page sees it. Clearing this a commit later reproduces the
  // empty-state render every real session switch goes through.
  const [documentPending, setDocumentPending] = useState(false);
  useEffect(() => {
    const built = SWITCH_SESSION_IDS.map((id) => openWindowedView(buildHistory(rounds), id));
    setViews(built);
    return () => built.forEach((view) => view.dispose());
  }, [rounds]);
  useEffect(() => {
    if (documentPending) setDocumentPending(false);
  }, [documentPending]);
  return (
    <div className="flex h-screen flex-col bg-background">
      <div className="flex shrink-0 items-center gap-2 p-2">
        {[0, 1].map((index) => (
          <button
            key={index}
            type="button"
            data-testid={`select-conversation-${index}`}
            disabled={!views}
            className="rounded border px-3 py-1 text-sm"
            onClick={() => {
              setDocumentPending(true);
              setCurrent(index);
            }}
          >
            Conversation {index + 1}
          </button>
        ))}
        <span data-testid="view-ready">{views ? 'view-ready' : 'building'}</span>
      </div>
      <div className="min-h-0 flex-1" data-testid="conversation-slot">
        {views && (
          <OpenedStream
            key={current}
            view={documentPending ? null : views[current]!}
            streamSessionId={SWITCH_SESSION_IDS[current]!}
          />
        )}
      </div>
    </div>
  );
}

/** Switch between two warm 3,000-turn conversations. */
export const SwitchBetweenLongConversations: Story = {
  render: () => <SwitchFlickerStory rounds={ROUNDS} />,
};

/** Reconcile a display projection without changing the underlying conversation. */
function ProjectionRefreshStory() {
  const [base, setBase] = useState<ConversationView | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const view = openWindowedView(buildHistory(ROUNDS));
    setBase(view);
    return () => view.dispose();
  }, []);
  const view = useMemo(() => {
    if (!base || revision === 0) return base;
    const entry = base.turn(base.turnCount - 1);
    if (!entry) return base;
    // An accepted entry can already be authoritative while its projection is
    // still retained. Rewrapping must not hide otherwise identical content.
    return createProjectedConversationView(base, [
      {
        workspaceId: 'projection-refresh-story' as WorkspaceId,
        sessionId,
        entry,
      },
    ]);
  }, [base, revision]);
  return (
    <div className="flex h-screen flex-col bg-background">
      <button
        type="button"
        data-testid="refresh-projection"
        disabled={!base}
        className="shrink-0 rounded border px-3 py-1 text-sm"
        onClick={() => setRevision((value) => value + 1)}
      >
        Refresh projection {revision}
      </button>
      <div className="min-h-0 flex-1" data-testid="conversation-slot">
        {base && <OpenedStream view={view} />}
      </div>
    </div>
  );
}

export const RefreshAcceptedHistory: Story = { render: () => <ProjectionRefreshStory /> };

const JUMP_SESSION_ID = 'session-worked-group-expand-jump' as SessionId;

/**
 * Short turns whose last "Worked for …" header rests within a viewport of
 * the bottom — the shape in which expanding it cannot put the header at the
 * viewport top because there is not enough content left below.
 */
function buildWorkedGroupJumpHistory(): SessionHistory[] {
  const history: SessionHistory[] = [];
  for (let round = 0; round < 10; round += 1) {
    history.push({
      id: `j-user-${round}`,
      role: 'user',
      timestamp: at(round * 2),
      read: true,
      finished: true,
      status: 'handled',
      fileDiff: [],
      items: [{ type: 'text', text: `Round ${round + 1}: apply the fix and re-run the suite` }],
      inputConfig: {
        prompt: `Round ${round + 1}`,
        cliType: 'builtin',
        agentType: 'claude',
        modeId: 'default',
        modelId: 'sonnet',
      },
    } as unknown as SessionHistory);
    history.push({
      id: `j-assistant-${round}`,
      role: 'assistant',
      timestamp: at(round * 2 + 1),
      userTurnId: `j-user-${round}`,
      endedAt: Date.UTC(2026, 7, 19, 9, 0, 0) + (round * 2 + 1) * 60_000 + 28_000,
      finished: true,
      fileDiff: [],
      items: [
        { type: 'thought', text: `Thinking about round ${round + 1}.` },
        {
          type: 'tool_call',
          toolCallId: `j-tool-${round}-1`,
          status: 'completed',
          title: `Read src/module-${round}.ts`,
          kind: 'read',
          rawInput: { path: `src/module-${round}.ts` },
        },
        {
          type: 'tool_call',
          toolCallId: `j-tool-${round}-2`,
          status: 'completed',
          title: `Edit src/module-${round}.ts`,
          kind: 'edit',
          rawInput: { path: `src/module-${round}.ts` },
        },
        { type: 'text', text: `Answer for round ${round + 1}.\n\n${paragraphs(2, round)}` },
      ],
    } as unknown as SessionHistory);
  }
  return history;
}

/**
 * Regression check for the worked-group expand scroll jump. With
 * follow-output released (wheel-scroll up a few hundred pixels), clicking the
 * last turn's "Worked for …" header must toggle in place: the header keeps
 * its viewport position, the revealed rows open beneath it, and the scroll
 * offset does not move — expanding used to `scrollToIndex` the header to the
 * top, which clamped at max scroll and yanked the reader to the session end.
 */
export const WorkedGroupExpandJump: Story = {
  render: () => (
    <WindowedStream history={buildWorkedGroupJumpHistory()} streamSessionId={JUMP_SESSION_ID} />
  ),
};

const SELECTION_SESSION_ID = 'native-text-selection-story' as SessionId;
const selectionHistory = Array.from({ length: 120 }, (_, index) => ({
  id: `selection-${index}`,
  role: 'assistant',
  finished: index !== 0,
  read: true,
  timestamp: at(index),
  items: [
    {
      type: 'text',
      text: `SELECT-${index}-START\n\n这是用于验证跨屏复制的固定文本。 This paragraph must survive virtual row recycling.\n\nSELECT-${index}-END`,
    },
    ...(index === 0
      ? [
          {
            type: 'tool_call',
            toolCallId: 'selection-tool',
            title: 'Selection tool running',
            kind: 'other',
            status: 'in_progress',
          },
          { type: 'text', text: 'UNSELECTED-FINAL-ANSWER' },
        ]
      : []),
  ],
})) as SessionHistory[];

function NativeTextSelectionStory() {
  const [session, setSession] = useState<ReturnType<typeof createConversationSession> | null>(null);
  const streamRef = useRef<SessionChatStreamHandle>(null);
  useEffect(() => {
    const doc = new LoroDoc();
    doc.getMap('session').set('id', SELECTION_SESSION_ID);
    const next = createConversationSession(doc, {
      sessionId: SELECTION_SESSION_ID,
      maxHydrated: 8,
      tailKeep: 2,
    });
    for (const entry of selectionHistory) next.historyWriter.append(entry);
    setSession(next);
    return () => {
      next.dispose();
      doc.free();
    };
  }, []);
  const stream = useConversationStreamItems(session?.history ?? null, SELECTION_SESSION_ID);
  return (
    <div className="flex h-screen flex-col bg-background">
      <div className="flex gap-3 p-2">
        <button
          data-testid="selection-start"
          onClick={() => streamRef.current?.scrollToIndex(0, false)}
        >
          Start
        </button>
        <button
          data-testid="selection-clear"
          onClick={() => window.getSelection()?.removeAllRanges()}
        >
          Clear selection
        </button>
        <button
          data-testid="selection-finish"
          data-finished={
            session?.history.turn(session.history.indexOf('selection-0'))?.finished ?? false
          }
          onClick={() =>
            session?.historyWriter.replace('selection-0', {
              ...selectionHistory[0]!,
              finished: true,
              items: [
                { type: 'text', text: 'UPDATED-PROSE' },
                {
                  type: 'tool_call',
                  toolCallId: 'selection-tool',
                  title: 'Selection tool completed',
                  kind: 'other',
                  status: 'completed',
                },
                { type: 'text', text: 'UNSELECTED-FINAL-ANSWER' },
              ],
            } as SessionHistory)
          }
        >
          Finish first turn
        </button>
        <textarea data-testid="selection-paste" aria-label="Paste copied text" className="border" />
      </div>
      <div className="min-h-0 flex-1" data-testid="native-selection-story">
        <SessionChatStreamView
          ref={streamRef}
          conversationView={session?.history}
          sessionId={SELECTION_SESSION_ID}
          initialWindowReady={stream.initialWindowReady}
          items={stream.items}
          lastAssistantMessageId={stream.lastAssistantMessageId}
          lastCompletedAssistantMessageId={stream.lastCompletedAssistantMessageId}
          onVisibleTurnRangeChange={stream.onVisibleTurnRangeChange}
          onOutlinePreviewRound={stream.onOutlinePreviewRound}
          leadingContent={<div>Selection regression fixture</div>}
          renderMessageRow={renderMessageRow}
          className="h-full"
        />
      </div>
    </div>
  );
}

export const NativeTextSelection: Story = { render: () => <NativeTextSelectionStory /> };

const at2 = (n: number) => new Date(Date.UTC(2026, 8, 20, 14, 0, 0) + n * 60_000).toISOString();

const noticeUser = (n: number, text: string): SessionHistory =>
  ({
    id: `n-user-${n}`,
    role: 'user',
    timestamp: at2(n * 2),
    read: true,
    finished: true,
    status: 'handled',
    fileDiff: [],
    items: [{ type: 'text', text }],
    inputConfig: {
      prompt: text,
      cliType: 'builtin',
      agentType: 'claude',
      modeId: 'default',
      modelId: 'sonnet',
    },
  }) as unknown as SessionHistory;

const noticeAssistant = (n: number, items: unknown[]): SessionHistory =>
  ({
    id: `n-assistant-${n}`,
    role: 'assistant',
    timestamp: at2(n * 2 + 1),
    userTurnId: `n-user-${n}`,
    endedAt: Date.UTC(2026, 8, 20, 14, 0, 0) + (n * 2 + 1) * 60_000 + 18_000,
    finished: true,
    fileDiff: [],
    items,
  }) as unknown as SessionHistory;

/** `meta` is schema-checked on write, so these carry real codes, not prose. */
const noticeSystem = (id: string, n: number, name: string, noticeMeta: unknown): SessionHistory =>
  ({
    id,
    role: 'system',
    timestamp: at2(n * 2 + 1),
    read: true,
    items: [{ type: 'system_notice', name, meta: noticeMeta }],
  }) as unknown as SessionHistory;

function buildNoticeHistory(): SessionHistory[] {
  return [
    noticeUser(0, 'Have a look at the avatar cache and tell me why it keeps refetching.'),
    noticeAssistant(0, [
      { type: 'thought', text: 'Checking how the blob cache is keyed and when it is revoked.' },
      {
        type: 'tool_call',
        toolCallId: 'n-tool-0-1',
        status: 'completed',
        title: 'Read packages/components/src/lib/avatar-cache.ts',
        kind: 'read',
        rawInput: { path: 'packages/components/src/lib/avatar-cache.ts' },
      },
      {
        type: 'text',
        text: 'The cache itself is fine — it keeps a durable copy in CacheStorage and revalidates in the background.\n\nWhat breaks is ownership: the blob URL is handed out as a plain string and copied into component state, so a revalidation swap revokes a URL another component is still rendering.',
      },
    ]),
    noticeSystem('n-warning-0', 1, 'agent_warning', {
      message:
        'The configured model is unavailable for this account, so the request fell back to the default model. Billing and rate limits follow the fallback, not the model you selected.',
      source: 'acp',
    }),
    noticeUser(1, '那就把所有权收敛到缓存里，别让组件各存一份。'),
    noticeAssistant(1, [
      { type: 'thought', text: 'Switching readers to a subscription so the cache owns the URL.' },
      {
        type: 'tool_call',
        toolCallId: 'n-tool-1-1',
        status: 'completed',
        title: 'Edit packages/components/src/lib/avatar-cache.ts',
        kind: 'edit',
        rawInput: { path: 'packages/components/src/lib/avatar-cache.ts' },
      },
      {
        type: 'text',
        text: 'Readers now subscribe per cache key, and a superseded URL is only revoked once the last reader is gone — so no component can be left pointing at a dead `blob:`.',
      },
    ]),
    noticeUser(2, 'Now run the full suite.'),
    noticeAssistant(2, [
      {
        type: 'tool_call',
        toolCallId: 'n-tool-2-1',
        status: 'completed',
        title: 'pnpm --filter @lody/components test',
        kind: 'execute',
        rawInput: { command: 'pnpm --filter @lody/components test' },
      },
    ]),
    noticeSystem('n-failed-0', 3, 'chat_failed', {
      reason: 'agent_disconnected',
      message: 'The agent process exited before the turn completed.',
    }),
  ];
}

/**
 * A whole conversation with both notice tones in place: user turns, agent prose
 * and tool work, a mid-conversation `agent_warning` the turn survived, and a
 * terminal `chat_failed`. Here to judge the notices against the rows they sit
 * between — in isolation it is easy to make one louder than the conversation.
 */
export const ConversationWithNotices: Story = {
  render: () => (
    <WindowedStream
      history={buildNoticeHistory()}
      streamSessionId={'session-conversation-notices' as SessionId}
    />
  ),
};
