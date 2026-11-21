import { describe, expect, it } from 'vitest';
import type { MessageContent, SessionHistory, SessionHistoryParsed, SessionId } from '@lody/shared';
import {
  extractSessionSearchBlocks,
  getCoordinatorMessageSearchBlockId,
  getMessageItemPrefix,
} from '../src/lib/session-chat-search';
import {
  buildChatVirtualRows,
  resolveActiveCoordinatorStatus,
  type ChatStreamItem,
} from '../src/components/ai-gui/view';

// Guards the per-turn row cache behind view.tsx `buildChatVirtualRows`: rows for
// unchanged turns must be reference-stable across rebuilds, or the shallow-compare
// memo on AssistantChatItem fails for every mounted row on every streaming delta
// and long sessions saturate the renderer event loop (the v0.70–v0.72 macOS
// "Lody is not responding" regression).

const sessionId = 'session-identity' as SessionId;

const text = (value: string): MessageContent => ({ type: 'text', text: value }) as MessageContent;

let toolSeq = 0;
const toolCall = (): MessageContent =>
  ({
    type: 'tool_call',
    toolCallId: `tool-${(toolSeq += 1)}`,
    status: 'completed',
    title: 'ran a tool',
  }) as unknown as MessageContent;

const makeMessage = (
  id: string,
  role: 'user' | 'assistant' | 'system',
  items: MessageContent[],
  finished?: boolean
): SessionHistoryParsed =>
  ({
    id,
    items,
    role,
    read: true,
    timestamp: 1,
    finished,
  }) as unknown as SessionHistoryParsed;

let nextTurnIndex = 0;
const wrap = (message: SessionHistoryParsed): ChatStreamItem => ({
  type: 'message',
  sessionId,
  message,
  turnIndex: (nextTurnIndex += 1),
});

const build = (
  items: ChatStreamItem[],
  overrides?: { expansionVersion?: number; copyContextAvailable?: boolean }
) =>
  buildChatVirtualRows({
    items,
    lastAssistantMessageId:
      [...items]
        .reverse()
        .find(
          (item): item is ChatStreamItem & { type: 'message' } =>
            item.type === 'message' && item.message.role === 'assistant'
        )?.message.id ?? null,
    expansionVersion: overrides?.expansionVersion ?? 0,
    ...(overrides?.copyContextAvailable === undefined
      ? {}
      : { copyContextAvailable: overrides.copyContextAvailable }),
  });

const makeConversation = () => {
  const finishedTurn = wrap(
    makeMessage('turn-a', 'assistant', [toolCall(), toolCall(), text('done')], true)
  );
  const streamingTurn = wrap(
    makeMessage('turn-b', 'assistant', [toolCall(), text('streaming…')], false)
  );
  return { finishedTurn, streamingTurn, items: [finishedTurn, streamingTurn] };
};

describe('Thought visibility', () => {
  const thought: MessageContent = { type: 'thought', text: 'Synthetic reasoning.' };
  const nextThought: MessageContent = { type: 'thought', text: 'Continue after the command.' };
  const fixture = (id: string, content: MessageContent[], finished = false) => ({
    items: [wrap(makeMessage(id, 'assistant', content, finished))],
    lastAssistantMessageId: id,
    expansionVersion: 0,
  });
  const visibleContents = (rows: ReturnType<typeof buildChatVirtualRows>) =>
    rows.flatMap((row) => {
      if (row.type !== 'assistant') return [];
      if (row.content.kind === 'activity_detail') return [row.content.entry.content];
      if (row.content.kind === 'content') return [row.content.block.entry.content];
      return [];
    });
  const headers = (rows: ReturnType<typeof buildChatVirtualRows>) =>
    rows.flatMap((row) =>
      row.type === 'assistant' && row.content.kind === 'activity_group_header' ? [row.content] : []
    );
  const expansion = (
    id: string,
    expandedGroups: Record<string, boolean>,
    expandedWorkedGroups: Record<string, boolean> = {}
  ) =>
    new Map([
      [
        id,
        {
          finished: true,
          activeSearchBlockId: null,
          expandState: {
            expandedWorkedGroups,
            expandedGroups,
            expandedByIndex: {},
            planOpen: false,
          },
        },
      ],
    ]);

  it('keeps one collapsed group and its key when tools and thoughts stream into the turn', () => {
    const id = 'dsh-streaming';
    const before = buildChatVirtualRows(fixture(id, [thought]));
    const tool = toolCall();
    const after = buildChatVirtualRows(fixture(id, [thought, tool, nextThought]));
    expect(visibleContents(after)).toEqual([]);
    expect(headers(after).map((header) => header.expanded)).toEqual([false]);
    expect(after.slice(0, before.length).map((row) => row.key)).toEqual(
      before.map((row) => row.key)
    );
    expect(headers(after).map((header) => header.isThinking)).toEqual([true]);
  });

  it('folds the process on completion and restores ordered prose when expanded', () => {
    const id = 'dsh-prose';
    const tool = toolCall();
    const progress = text('I will inspect the result.');
    const answer = text('Answer');
    const contents = [thought, tool, progress, nextThought, answer];
    const live = buildChatVirtualRows(fixture(id, contents));
    expect(visibleContents(live)).toEqual([progress, answer]);
    expect(headers(live).map((header) => header.expanded)).toEqual([false, false]);

    const args = fixture(id, contents, true);
    const rows = buildChatVirtualRows(args);
    // Completion folds progress with the thought and tool steps, leaving the answer.
    expect(visibleContents(rows)).toEqual([answer]);
    const header = rows.find(
      (row) => row.type === 'assistant' && row.content.kind === 'worked_group_header'
    );
    expect(header).toMatchObject({ content: { expanded: false } });
    expect(buildChatVirtualRows(args).every((row, index) => row === rows[index])).toBe(true);

    const expanded = buildChatVirtualRows({
      ...args,
      selectionLayouts: expansion(id, {}, { [`segment:${id}:0`]: true }),
    });
    expect(visibleContents(expanded)).toEqual([progress, answer]);
    expect(headers(expanded).map((group) => group.expanded)).toEqual([false, false]);
    expect(
      visibleContents(
        buildChatVirtualRows({
          ...args,
          selectionLayouts: expansion(id, {}, { [`segment:${id}:0`]: false }),
        })
      )
    ).toEqual([answer]);

    // Search opens both the outer process and a manually collapsed thought group.
    const firstThoughtKey = headers(live)[0]!.block.key;
    const selected = expansion(id, { [firstThoughtKey]: false });
    const searched = new Map([
      [id, { ...selected.get(id)!, activeSearchBlockId: getMessageItemPrefix(id, 0) }],
    ]);
    expect(visibleContents(buildChatVirtualRows({ ...args, selectionLayouts: searched }))).toEqual([
      thought,
      tool,
      progress,
      answer,
    ]);
  });

  it('toggles adjacent thoughts and tools together and reveals the whole group for search', () => {
    const id = 'mixed-toggles';
    const tool = toolCall();
    const contents = [thought, tool, nextThought];
    const args = fixture(id, contents, true);
    const defaults = buildChatVirtualRows(args);
    expect(headers(defaults)).toHaveLength(1);
    const key = headers(defaults)[0]!.block.key;
    const selected = expansion(id, { [key]: true });
    expect(visibleContents(buildChatVirtualRows({ ...args, selectionLayouts: selected }))).toEqual(
      contents
    );
    const collapsed = expansion(id, { [key]: false });
    expect(visibleContents(buildChatVirtualRows({ ...args, selectionLayouts: collapsed }))).toEqual([]);
    // Search retains original item indexes, including thoughts after a tool call.
    const search = new Map([
      [id, { ...collapsed.get(id)!, activeSearchBlockId: getMessageItemPrefix(id, 2) }],
    ]);
    expect(visibleContents(buildChatVirtualRows({ ...args, selectionLayouts: search }))).toEqual(
      contents
    );
  });

  it('preserves an expanded group when another tool and thought arrive', () => {
    const id = 'mixed-streaming-toggle';
    const before = buildChatVirtualRows(fixture(id, [thought]));
    const key = headers(before)[0]!.block.key;
    const contents = [thought, toolCall(), nextThought, toolCall()];
    const selected = expansion(id, { [key]: true });
    const after = buildChatVirtualRows({ ...fixture(id, contents), selectionLayouts: selected });
    expect(headers(after)).toHaveLength(1);
    expect(headers(after)[0]).toMatchObject({
      expanded: true,
      isThinking: false,
      block: { key },
    });
    expect(visibleContents(after)).toEqual(contents);
  });

  it('keeps interrupted thoughts and tools in one closed group', () => {
    const args = fixture('interrupted', [thought, toolCall(), nextThought], true);
    expect(visibleContents(buildChatVirtualRows(args))).toEqual([]);
    expect(headers(buildChatVirtualRows(args))).toHaveLength(1);
  });
});

describe('coordinator conversation bubbles and search', () => {
  it('renders one virtual row per coordinator_message while hiding raw text, thoughts, and tool calls', () => {
    const turnWithBubbles = wrap(
      makeMessage(
        'coord-turn-1',
        'assistant',
        [
          { type: 'thought', text: 'Internal reasoning' },
          text('Internal plain text that must never show'),
          toolCall(),
          { type: 'coordinator_status', status: '正在查看可用 Role…' },
          { type: 'coordinator_message', id: 'b1', body: '我先查一下合适的 Role，马上派发。' },
          toolCall(),
          { type: 'coordinator_message', id: 'b2', body: '已经交给 **天才程序员** 处理。' },
          {
            type: 'coordinator_message',
            id: 'b3',
            body: '',
            images: [
              {
                imageId: 'img-1',
                mimeType: 'image/png',
                fileName: 'shot.png',
                sizeBytes: 512,
                uploadedAt: 1000,
                storageSessionId: 'child-s1' as SessionId,
              },
            ],
          },
        ],
        true
      )
    );
    const turnWithoutBubbles = wrap(
      makeMessage(
        'coord-turn-2',
        'assistant',
        [{ type: 'thought', text: 'Working silently' }, text('Hidden text'), toolCall()],
        false
      )
    );

    const rows = buildChatVirtualRows({
      items: [turnWithBubbles, turnWithoutBubbles],
      lastAssistantMessageId: 'coord-turn-2',
      expansionVersion: 0,
      coordinatorBubbles: true,
    });

    // Turn without coordinator_message emits zero rows so Virtua never receives a null DOM row.
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.key)).toEqual([
      'assistant:coord-turn-1:bubble:b1',
      'assistant:coord-turn-1:bubble:b2',
      'assistant:coord-turn-1:bubble:b3',
    ]);
    expect(
      rows.map((row) =>
        row.type === 'assistant' && row.content.kind === 'coordinator_bubble'
          ? row.content.entry.body
          : null
      )
    ).toEqual(['我先查一下合适的 Role，马上派发。', '已经交给 **天才程序员** 处理。', '']);

    const searchBlocks = extractSessionSearchBlocks(
      [
        makeMessage('user-1', 'user', [text('帮我修一下这个问题')]) as unknown as SessionHistory,
        turnWithBubbles.message as unknown as SessionHistory,
      ],
      { coordinator: true }
    );
    expect(searchBlocks.map((block) => block.blockId)).toEqual([
      `${getMessageItemPrefix('user-1', 0)}:text`,
      getCoordinatorMessageSearchBlockId('coord-turn-1', 4),
      getCoordinatorMessageSearchBlockId('coord-turn-1', 6),
    ]);
  });

  it('shows instant fallback status before the first coordinator output, switches to explicit status, and avoids end-of-turn or stale-daemon flashes', () => {
    const defaultWorkingLabel = '正在看…';
    const userTurn = wrap(makeMessage('u-1', 'user', [text('帮我看看 PR 状态')], true));

    // 1. Optimistic send / empty history / trailing user turn -> immediate fallback pill
    expect(
      resolveActiveCoordinatorStatus({
        items: [],
        localUserMessagesCount: 1,
        agentActivityLabel: defaultWorkingLabel,
        defaultWorkingLabel,
      })
    ).toEqual({ label: '正在看…', tone: 'primary' });
    expect(
      resolveActiveCoordinatorStatus({
        items: [userTurn],
        agentActivityLabel: defaultWorkingLabel,
        defaultWorkingLabel,
      })
    ).toEqual({ label: '正在看…', tone: 'primary' });

    // 2. Assistant turn started (thinking / lookup tools) before first bubble or status -> fallback pill
    const thinkingTurn = wrap(
      makeMessage('a-1', 'assistant', [{ type: 'thought', text: 'Planning' }, toolCall()], false)
    );
    expect(
      resolveActiveCoordinatorStatus({
        items: [userTurn, thinkingTurn],
        agentActivityLabel: defaultWorkingLabel,
        defaultWorkingLabel,
      })
    ).toEqual({ label: '正在看…', tone: 'primary' });

    // 3. Explicit status + opening bubble, even with a trailing `operation_progress` system row -> explicit phrase
    const dispatchingTurn = wrap(
      makeMessage(
        'a-1',
        'assistant',
        [
          { type: 'coordinator_message', id: 'b-open', body: '收到，我去查一下并派发任务。' },
          { type: 'coordinator_status', status: '正在派发子对话…' },
        ],
        false
      )
    );
    const progressSystemRow = wrap(
      makeMessage(
        'sys-progress',
        'system',
        [
          {
            type: 'operation_progress',
            operationId: 'op-1',
            operationKind: 'session_create',
            items: [
              {
                target: { sessionId: 'child-1' as SessionId, userTurnId: 'cu-1' },
                status: 'running',
              },
            ],
          } as unknown as MessageContent,
        ],
        true
      )
    );
    expect(
      resolveActiveCoordinatorStatus({
        items: [userTurn, dispatchingTurn, progressSystemRow],
        agentActivityLabel: defaultWorkingLabel,
        defaultWorkingLabel,
      })
    ).toEqual({ label: '正在派发子对话…', tone: 'primary' });

    // 4. Direct bubble reply with no explicit status -> hides pill while turn wraps up
    const directReplyTurn = wrap(
      makeMessage(
        'a-1',
        'assistant',
        [{ type: 'coordinator_message', id: 'b-ans', body: '目前没有未合并的 PR。' }],
        false
      )
    );
    expect(
      resolveActiveCoordinatorStatus({
        items: [userTurn, directReplyTurn],
        agentActivityLabel: defaultWorkingLabel,
        defaultWorkingLabel,
      })
    ).toBeNull();

    // 5. Finished assistant turn + trailing passive `operation_progress` while presence drains -> no flash
    const finishedTurn = wrap(
      makeMessage(
        'a-1',
        'assistant',
        [
          { type: 'coordinator_status', status: '正在派发子对话…' },
          { type: 'coordinator_message', id: 'b-done', body: '已交给天才程序员处理。' },
        ],
        true
      )
    );
    expect(
      resolveActiveCoordinatorStatus({
        items: [userTurn, finishedTurn, progressSystemRow],
        agentActivityLabel: defaultWorkingLabel,
        defaultWorkingLabel,
      })
    ).toBeNull();

    // 6. Async completion receipt wakes coordinator before new assistant row arrives -> fallback pill
    const completionReceiptRow = wrap(
      makeMessage(
        'sys-complete',
        'system',
        [
          {
            type: 'operation_completion',
            deliveryId: 'del-1',
            operationId: 'op-1',
            operationKind: 'session_create',
            completion: {},
          } as unknown as MessageContent,
        ],
        true
      )
    );
    expect(
      resolveActiveCoordinatorStatus({
        items: [userTurn, finishedTurn, progressSystemRow, completionReceiptRow],
        agentActivityLabel: defaultWorkingLabel,
        defaultWorkingLabel,
      })
    ).toEqual({ label: '正在看…', tone: 'primary' });

    // 7. Crashed/idle daemon (`agentActivityLabel: null`) with unfinished turn in history -> never sticks
    expect(
      resolveActiveCoordinatorStatus({
        items: [userTurn, dispatchingTurn],
        agentActivityLabel: null,
        defaultWorkingLabel,
      })
    ).toBeNull();

    // 8. Permission / question warnings always surface with warning tone
    expect(
      resolveActiveCoordinatorStatus({
        items: [userTurn, directReplyTurn],
        agentActivityLabel: '等待授权',
        agentActivityTone: 'warning',
        defaultWorkingLabel,
      })
    ).toEqual({ label: '等待授权', tone: 'warning' });
  });
});
