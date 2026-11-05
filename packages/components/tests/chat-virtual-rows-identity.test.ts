// @vitest-environment jsdom

// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { MessageContent, SessionHistoryParsed, SessionId } from '@lody/shared';
import { getMessageItemPrefix } from '../src/lib/session-chat-search';
import { buildChatVirtualRows, type ChatStreamItem } from '../src/components/ai-gui/view';

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

describe('DSH thought visibility', () => {
  const thought: MessageContent = { type: 'thought', text: 'Synthetic reasoning.' };
  const nextThought: MessageContent = { type: 'thought', text: 'Continue after the command.' };
  const fixture = (id: string, content: MessageContent[], finished = false) => ({
    items: [wrap(makeMessage(id, 'assistant', content, finished))],
    lastAssistantMessageId: id,
    expansionVersion: 0,
    showThoughts: true,
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

  it('keeps visible thought rows and keys when commands stream into the turn', () => {
    const id = 'dsh-streaming';
    const before = buildChatVirtualRows(fixture(id, [thought]));
    const tool = toolCall();
    const after = buildChatVirtualRows(fixture(id, [thought, tool, nextThought]));
    expect(visibleContents(after)).toEqual([thought, nextThought]);
    expect(headers(after).map((header) => header.expanded)).toEqual([true, false, true]);
    expect(after.slice(0, before.length).map((row) => row.key)).toEqual(
      before.map((row) => row.key)
    );
    expect(headers(after).map((header) => header.isThinking)).toEqual([false, false, true]);
  });

  it('folds the process on completion and restores ordered prose when expanded', () => {
    const id = 'dsh-prose';
    const tool = toolCall();
    const progress = text('I will inspect the result.');
    const answer = text('Answer');
    const contents = [thought, tool, progress, nextThought, answer];
    const live = buildChatVirtualRows(fixture(id, contents));
    expect(visibleContents(live)).toEqual([thought, progress, nextThought, answer]);
    expect(headers(live).map((header) => header.expanded)).toEqual([true, false, true]);

    const args = fixture(id, contents, true);
    const rows = buildChatVirtualRows(args);
    // Prose never folds: only the thought and tool steps collapse.
    expect(visibleContents(rows)).toEqual([progress, answer]);
    const header = rows.find(
      (row) => row.type === 'assistant' && row.content.kind === 'worked_group_header'
    );
    expect(header).toMatchObject({ content: { expanded: false } });
    expect(buildChatVirtualRows(args).every((row, index) => row === rows[index])).toBe(true);

    const expanded = buildChatVirtualRows({
      ...args,
      selectionLayouts: expansion(id, {}, { [`segment:${id}:0`]: true }),
    });
    expect(visibleContents(expanded)).toEqual([thought, progress, nextThought, answer]);
    expect(headers(expanded).map((group) => group.expanded)).toEqual([true, false, true]);
    expect(
      visibleContents(
        buildChatVirtualRows({
          ...args,
          selectionLayouts: expansion(id, {}, { [`segment:${id}:0`]: false }),
        })
      )
    ).toEqual([progress, answer]);

    // Search opens both the outer process and a manually collapsed thought group.
    const firstThoughtKey = headers(live)[0]!.block.key;
    const selected = expansion(id, { [firstThoughtKey]: false });
    const searched = new Map([
      [id, { ...selected.get(id)!, activeSearchBlockId: getMessageItemPrefix(id, 0) }],
    ]);
    expect(visibleContents(buildChatVirtualRows({ ...args, selectionLayouts: searched }))).toEqual([
      thought,
      progress,
      nextThought,
      answer,
    ]);
  });

  it('preserves explicit independent toggles and reveals a collapsed thought for search', () => {
    const id = 'dsh-toggles';
    const tool = toolCall();
    const args = fixture(id, [thought, tool, nextThought], true);
    const defaults = buildChatVirtualRows(args);
    const [first, command, last] = headers(defaults);
    const selected = expansion(id, { [first!.block.key]: false, [command!.block.key]: true });
    const changed = buildChatVirtualRows({ ...args, selectionLayouts: selected });
    expect(visibleContents(changed)).toEqual([tool, nextThought]);
    expect(headers(changed).map((header) => header.expanded)).toEqual([false, true, true]);
    const reopened = expansion(id, {
      [first!.block.key]: true,
      [command!.block.key]: false,
      [last!.block.key]: false,
    });
    expect(visibleContents(buildChatVirtualRows({ ...args, selectionLayouts: reopened }))).toEqual([
      thought,
    ]);
    // Search IDs use the original item index, independent of the new group boundaries.
    const search = new Map([
      [id, { ...selected.get(id)!, activeSearchBlockId: getMessageItemPrefix(id, 0) }],
    ]);
    expect(visibleContents(buildChatVirtualRows({ ...args, selectionLayouts: search }))).toEqual([
      thought,
      tool,
      nextThought,
    ]);
  });

  it('invalidates both caches on provider changes and preserves other providers folding', () => {
    const args = fixture(
      'dsh-provider-switch',
      [thought, toolCall(), text('progress'), toolCall(), text('answer')],
      true
    );
    const expandedArgs = {
      ...args,
      selectionLayouts: expansion(
        'dsh-provider-switch',
        {},
        { 'segment:dsh-provider-switch:0': true }
      ),
    };
    const dsh = buildChatVirtualRows(expandedArgs);
    expect(visibleContents(dsh)).toEqual([thought, text('progress'), text('answer')]);
    const other = buildChatVirtualRows({ ...expandedArgs, showThoughts: false });
    expect(visibleContents(other)).toEqual([text('progress'), text('answer')]);
    expect(
      other.some((row) => row.type === 'assistant' && row.content.kind === 'worked_group_header')
    ).toBe(true);
    expect(buildChatVirtualRows(expandedArgs)).toEqual(dsh);
  });

  it('keeps interrupted thoughts readable without exposing them for other providers', () => {
    const args = fixture('dsh-interrupted', [thought, toolCall(), nextThought], true);
    expect(visibleContents(buildChatVirtualRows(args))).toEqual([thought, nextThought]);
    const other = buildChatVirtualRows({ ...args, showThoughts: false });
    expect(visibleContents(other)).toEqual([]);
    expect(headers(other)).toHaveLength(1);
    expect(
      other.some((row) => row.type === 'assistant' && row.content.kind === 'worked_group_header')
    ).toBe(false);
  });
});
