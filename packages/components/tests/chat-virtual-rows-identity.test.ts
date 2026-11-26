import { describe, expect, it } from 'vitest';
import type { MessageContent, SessionHistoryParsed, SessionId } from '@lody/shared';
import { getMessageItemPrefix } from '../src/lib/session-chat-search';
import { buildChatVirtualRows, type ChatStreamItem } from '../src/components/ai-gui/view';
import {
  collectStickyWorkGroups,
  resolveActiveStickyWorkGroup,
  resolveStickyCollapseTargetScreenY,
} from '../src/components/ai-gui/sticky-work-group';

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
  role: 'user' | 'assistant',
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
    expect(visibleContents(buildChatVirtualRows({ ...args, selectionLayouts: collapsed }))).toEqual(
      []
    );
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

describe('Sticky work-group summary resolution', () => {
  const layoutGeometry = (heights: number[]) => {
    const offsets: number[] = [];
    let cursor = 0;
    for (const height of heights) {
      offsets.push(cursor);
      cursor += height;
    }
    return {
      getItemOffset: (index: number) => offsets[index] ?? cursor,
      getItemSize: (index: number) => heights[index] ?? 0,
    };
  };

  it('omits collapsed groups and bounds expanded worked groups before final answer prose', () => {
    const id = 'sticky-finished';
    const message = makeMessage(
      id,
      'assistant',
      [
        { type: 'thought', text: 'Inspecting files.' } as MessageContent,
        toolCall(),
        {
          type: 'text',
          text: 'Intermediate commentary',
          messagePhase: 'commentary',
        } as MessageContent,
        toolCall(),
        { type: 'text', text: 'Final answer body', messagePhase: 'final_answer' } as MessageContent,
        {
          type: 'subagent_task',
          taskId: 'sub-1',
          description: 'Done task',
          status: 'completed',
        } as unknown as MessageContent,
      ],
      true
    );
    const items = [wrap(message)];

    // Default finished turn is collapsed: zero sticky work groups.
    const collapsedRows = buildChatVirtualRows({
      items,
      lastAssistantMessageId: id,
      expansionVersion: 0,
    });
    expect(collectStickyWorkGroups(collapsedRows)).toEqual([]);

    // Expanding the worked group includes work rows only and stops before the final answer
    // (even though a finished subagent_tasks row trails after the final answer).
    const expandedRows = buildChatVirtualRows({
      items,
      lastAssistantMessageId: id,
      expansionVersion: 1,
      selectionLayouts: new Map([
        [
          id,
          {
            finished: true,
            activeSearchBlockId: null,
            expandState: {
              expandedWorkedGroups: { [`segment:${id}:0`]: true },
              expandedGroups: {},
              expandedByIndex: {},
              planOpen: false,
            },
          },
        ],
      ]),
    });
    const groups = collectStickyWorkGroups(expandedRows);
    expect(groups).toHaveLength(1);
    const worked = groups[0]!;
    expect(worked.depth).toBe(0);
    expect(worked.parentHeaderRowIndex).toBeNull();
    const finalAnswerRowIndex = expandedRows.findIndex(
      (row) =>
        row.type === 'assistant' && row.content.kind === 'content' && row.isWorkedDetail !== true
    );
    expect(finalAnswerRowIndex).toBeGreaterThan(worked.lastBodyRowIndex);
  });

  it('tracks nested expanded activity groups, push-up handover, exit, and collapse screenY', () => {
    const id = 'sticky-nested';
    const message = makeMessage(
      id,
      'assistant',
      [
        { type: 'text', text: 'Commentary 1', messagePhase: 'commentary' } as MessageContent,
        toolCall(),
        toolCall(),
        { type: 'text', text: 'Commentary 2', messagePhase: 'commentary' } as MessageContent,
        { type: 'text', text: 'Final answer', messagePhase: 'final_answer' } as MessageContent,
      ],
      false
    );
    const items = [wrap(message)];
    const initialRows = buildChatVirtualRows({
      items,
      lastAssistantMessageId: id,
      expansionVersion: 0,
    });
    const activityRow = initialRows.find(
      (row) => row.type === 'assistant' && row.content.kind === 'activity_group_header'
    );
    expect(activityRow).toBeDefined();
    const activityBlockKey =
      activityRow?.type === 'assistant' && activityRow.content.kind === 'activity_group_header'
        ? activityRow.content.block.key
        : '';

    const rows = buildChatVirtualRows({
      items,
      lastAssistantMessageId: id,
      expansionVersion: 1,
      selectionLayouts: new Map([
        [
          id,
          {
            finished: false,
            activeSearchBlockId: null,
            expandState: {
              expandedWorkedGroups: { [`segment:${id}:0`]: true },
              expandedGroups: { [activityBlockKey]: true },
              expandedByIndex: {},
              planOpen: false,
            },
          },
        ],
      ]),
    });

    const groups = collectStickyWorkGroups(rows);
    expect(groups).toHaveLength(2);
    const [workedGroup, activityGroup] = groups as [
      (typeof groups)[number],
      (typeof groups)[number],
    ];
    expect(workedGroup.depth).toBe(0);
    expect(activityGroup.depth).toBe(1);
    expect(activityGroup.parentHeaderRowIndex).toBe(workedGroup.headerRowIndex);

    // Row heights: workedHeader(32), commentary1(168), activityHeader(32), tool1(200), tool2(200), commentary2(200), finalAnswer(300), footer(40)
    const heights = rows.map((row) => {
      if (row.type !== 'assistant') return 40;
      if (
        row.content.kind === 'worked_group_header' ||
        row.content.kind === 'activity_group_header'
      )
        return 32;
      if (row.content.kind === 'activity_detail') return 200;
      if (row.content.kind === 'footer') return 40;
      return row.isWorkedDetail ? 168 : 300;
    });
    const geom = layoutGeometry(heights);
    const contentOffset = 24;
    const stickyBarHeight = 36;
    const at = (scrollOffset: number, topInsetPx = 0) =>
      resolveActiveStickyWorkGroup({
        groups,
        leadingRowCount: 0,
        scrollOffset,
        contentOffset,
        topInsetPx,
        stickyBarHeight,
        ...geom,
      });

    // At rest (scrollOffset <= contentOffset): nothing sticks.
    expect(at(0)).toBeNull();
    expect(at(24)).toBeNull();

    // Scrolled past workedGroup header (top=0), before activityGroup header (top=200): workedGroup sticks.
    expect(at(24 + 50)).toEqual({ group: workedGroup, pushOffsetPx: 0 });

    // Approaching nested activityGroup header (top=200): workedGroup pushes upward smoothly.
    expect(at(24 + 180)).toEqual({ group: workedGroup, pushOffsetPx: -16 });

    // Scrolled past nested activityGroup header (top=200): nested activityGroup takes over.
    expect(at(24 + 300)).toEqual({ group: activityGroup, pushOffsetPx: 0 });

    // Approaching end of activityGroup (bottom=200+32+400=632): pushes up before returning to outer workedGroup.
    expect(at(24 + 612)).toEqual({ group: activityGroup, pushOffsetPx: -16 });

    // Inside commentary 2 (632..800), still within workedGroup: outer workedGroup resumes.
    expect(at(24 + 660)).toEqual({ group: workedGroup, pushOffsetPx: 0 });

    // Approaching final answer (workedGroup bottom=800): workedGroup pushes out before final answer.
    expect(at(24 + 780)).toEqual({ group: workedGroup, pushOffsetPx: -16 });

    // In final answer (>= 800): nothing sticks, prose is unobstructed.
    expect(at(24 + 800)).toBeNull();
    expect(at(24 + 920)).toBeNull();

    // Top inset (e.g. mobile frosted header of 48px, contentOffset = 72) shifts activation cleanly.
    expect(
      resolveActiveStickyWorkGroup({
        groups,
        leadingRowCount: 0,
        scrollOffset: 24,
        contentOffset: 72,
        topInsetPx: 48,
        stickyBarHeight,
        ...geom,
      })
    ).toBeNull();
    expect(
      resolveActiveStickyWorkGroup({
        groups,
        leadingRowCount: 0,
        scrollOffset: 24 + 50,
        contentOffset: 72,
        topInsetPx: 48,
        stickyBarHeight,
        ...geom,
      })
    ).toEqual({ group: workedGroup, pushOffsetPx: 0 });

    // Collapse target screenY: top-level lands at topInsetPx; nested lands below parent sticky bar.
    expect(
      resolveStickyCollapseTargetScreenY({
        group: workedGroup,
        leadingRowCount: 0,
        topInsetPx: 0,
        stickyBarHeight,
        getItemOffset: geom.getItemOffset,
      })
    ).toBe(0);
    expect(
      resolveStickyCollapseTargetScreenY({
        group: activityGroup,
        leadingRowCount: 0,
        topInsetPx: 0,
        stickyBarHeight,
        getItemOffset: geom.getItemOffset,
      })
    ).toBe(36);
  });
});
