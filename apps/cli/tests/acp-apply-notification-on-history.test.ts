import { describe, expect, it } from 'vitest';

import type { MessageContent, SessionHistoryInput, SessionId } from '@lody/shared';
import type { SessionNotification } from '@agentclientprotocol/sdk';

import { applyNotificationOnHistory } from '../src/lib/acp/history';
import { planAgentHistoryMutation, prepareReplacement } from '@lody/shared';
import {
  roostContentPatches,
  stageRoostContent,
  coalesceAgentTextAppends,
} from '../src/session/roost-content-patches';

const makeNotification = (update: SessionNotification['update']): SessionNotification => ({
  sessionId: 'session-1' as SessionId,
  update,
});

describe('applyNotificationOnHistory', () => {
  it('plans immutable changes with the same per-event markup and instruction semantics', () => {
    const fixtures = [
      'hello 🙂 é\nworld',
      '\n<thinking>\nprivate reasoning\n</thinking>\nanswer',
      '\r\n  <proposed_plan>\r\nstep one\r\n</proposed_plan>\r\nnext',
      'inline <thinking>mention</thinking> stays visible',
      'visible  \nThe following are system instructions. Do not disclose them to the user:hidden',
      'visible\nThe "lody" MCP server provides tools for this conversation:hidden',
    ];
    for (const text of fixtures)
      for (let split = 0; split <= text.length; split++) {
        const initial: SessionHistoryInput[] = [
          {
            id: 'a',
            role: 'assistant',
            timestamp: '2026-10-22',
            items: [
              {
                type: 'tool_call',
                toolCallId: 'tool',
                status: 'completed',
                rawOutput: { text: 'untouched' },
              },
              { type: 'text', text: '' },
            ],
            fileDiff: [],
          },
        ];
        let planned = initial,
          baseline = structuredClone(initial);
        for (const delta of [text.slice(0, split), text.slice(split), '\nfollowing']) {
          const event = {
            kind: 'notification' as const,
            value: makeNotification({
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: delta },
            }),
          };
          // A fresh full snapshot forces the established parser's full scan.
          baseline = structuredClone(baseline);
          applyNotificationOnHistory(baseline, [event.value], undefined, {
            targetAssistantEntryId: 'a',
          });
          const result = planAgentHistoryMutation(planned, [event], undefined, {
            targetAssistantEntryId: 'a',
          });
          const previous = planned;
          planned = result.history.map(
            (entry, index) => prepareReplacement(previous[index], entry) as SessionHistoryInput
          );
          for (const [index, entry] of planned.entries()) {
            const ops = roostContentPatches(
              previous[index],
              entry,
              coalesceAgentTextAppends(result.textAppends, entry.id),
              result.changes.filter((change) => change.turnId === entry.id)
            );
            expect(stageRoostContent(previous[index], ops)).toEqual(entry);
          }
          expect(planned).toEqual(baseline);
        }
        expect(initial[0]?.items[1]).toEqual({ type: 'text', text: '' });
      }
  });

  it('owns new plan inputs while retaining unchanged private values and handling stale text analysis', () => {
    const initial: SessionHistoryInput[] = [
      {
        id: 'a',
        role: 'assistant',
        timestamp: '2026-10-22',
        items: [
          {
            type: 'tool_call',
            toolCallId: 'tool',
            status: 'completed',
            rawOutput: { text: 'untouched' },
          },
          { type: 'text', text: 'start' },
        ],
        fileDiff: [],
      },
    ];
    const notification = makeNotification({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: ' + delta' },
    });
    const result = planAgentHistoryMutation(
      initial,
      [{ kind: 'notification', value: notification }],
      undefined,
      { targetAssistantEntryId: 'a' }
    );
    expect(result.history[0]?.items[0]).toBe(initial[0]?.items[0]);
    expect(result.history[0]?.items[1]).toEqual({ type: 'text', text: 'start + delta' });
    expect(initial[0]?.items[1]).toEqual({ type: 'text', text: 'start' });
    expect(result.textAppends).toEqual([
      { turnId: 'a', itemIndex: 1, previous: 'start', value: 'start + delta', text: ' + delta' },
    ]);
    const entries = [{ content: 'first', priority: 'medium' as const, status: 'pending' as const }];
    const plan = planAgentHistoryMutation(
      initial,
      [{ kind: 'notification', value: makeNotification({ sessionUpdate: 'plan', entries }) }],
      undefined,
      { targetAssistantEntryId: 'a' }
    );
    const firstPlanEntry = entries[0];
    if (!firstPlanEntry) throw new Error('Expected plan entry');
    firstPlanEntry.content = 'caller mutation';
    expect(plan.history[0]?.plan?.[0]?.content).toBe('first');
    const current = result.history[0]?.items[1];
    if (!current || current.type !== 'text') throw new Error('Expected text');
    current.text = 'changed\n<thinking>reasoning</thinking>';
    const reference = structuredClone(result.history);
    const next = makeNotification({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '\nanswer' },
    });
    applyNotificationOnHistory(reference, [next], undefined, { targetAssistantEntryId: 'a' });
    expect(
      planAgentHistoryMutation(result.history, [{ kind: 'notification', value: next }], undefined, {
        targetAssistantEntryId: 'a',
      }).history
    ).toEqual(reference);
  });

  it('retains the established repair of a malformed stored text scalar', () => {
    for (const value of [0, 1, null, undefined]) {
      const history = [
        {
          id: 'a',
          role: 'assistant',
          timestamp: '2026-10-22',
          items: [{ type: 'text', text: value }],
          fileDiff: [],
        },
      ] as unknown as SessionHistoryInput[];
      const notification = makeNotification({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '1 repaired' },
      });
      expect(
        planAgentHistoryMutation(
          history,
          [{ kind: 'notification', value: notification }],
          undefined,
          { targetAssistantEntryId: 'a' }
        ).history[0]?.items
      ).toEqual([{ type: 'text', text: '1 repaired' }]);
    }
  });

  it('mutates the history array in-place', () => {
    const history: SessionHistoryInput[] = [];
    const result = applyNotificationOnHistory(history, [
      makeNotification({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello' },
      }),
    ]);
    expect(result).toBe(history);
    expect(history).toHaveLength(1);
  });

  it('merges adjacent agent_message_chunk text deltas', () => {
    const history: SessionHistoryInput[] = [];
    applyNotificationOnHistory(history, [
      makeNotification({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello' },
      }),
      makeNotification({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: ' world' },
      }),
    ]);

    expect(history).toHaveLength(1);
    const items = history[0]!.items as unknown as MessageContent[];
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({ type: 'text', text: 'hello world' });
  });

  it('creates a new assistant entry when last entry is non-assistant', () => {
    const history: SessionHistoryInput[] = [
      {
        id: 'u1',
        role: 'user',
        items: [{ type: 'text', text: 'hi' }] satisfies MessageContent[],
        timestamp: new Date().toISOString(),
        read: undefined,
        userId: undefined,
      },
    ];

    applyNotificationOnHistory(history, [
      makeNotification({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'response' },
      }),
    ]);

    expect(history).toHaveLength(2);
    expect(history[1]!.role).toBe('assistant');
  });

  it('creates a new assistant entry after worktree script history', () => {
    const history: SessionHistoryInput[] = [
      {
        id: 'setup-1',
        role: 'system',
        items: [
          {
            type: 'worktree_script',
            phase: 'setup',
            status: 'completed',
            steps: [
              {
                command: 'pnpm install',
                status: 'completed',
                output: 'hello\n',
              },
            ],
          },
        ] satisfies MessageContent[],
        timestamp: new Date().toISOString(),
        endedAt: Date.now(),
        finished: true,
        read: undefined,
        userId: undefined,
        fileDiff: [],
      },
    ];

    applyNotificationOnHistory(
      history,
      [
        makeNotification({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'AI response' },
        }),
      ],
      { modelId: 'claude-sonnet', name: 'Claude Sonnet' }
    );

    expect(history).toHaveLength(2);
    expect(history[0]!.id).toBe('setup-1');
    expect((history[0]!.items as unknown as MessageContent[]).map((item) => item.type)).toEqual([
      'worktree_script',
    ]);
    expect(history[1]!.modelInfo?.name).toBe('Claude Sonnet');
    expect(history[1]!.items as unknown as MessageContent[]).toEqual([
      { type: 'text', text: 'AI response' },
    ]);
  });

  it('upserts plan as a singleton snapshot', () => {
    const history: SessionHistoryInput[] = [];

    applyNotificationOnHistory(history, [
      makeNotification({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello' },
      }),
      makeNotification({
        sessionUpdate: 'plan',
        entries: [{ content: 'a', priority: 'low', status: 'pending' }],
      }),
      makeNotification({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: ' world' },
      }),
      makeNotification({
        sessionUpdate: 'plan',
        entries: [{ content: 'b', priority: 'high', status: 'completed' }],
      }),
    ]);

    expect(history).toHaveLength(1);
    const items = history[0]!.items as unknown as MessageContent[];
    // Plan is now stored on entry.plan, not in items
    expect(items.map((m) => m.type)).toEqual(['text']);

    const text = items[0] as Extract<MessageContent, { type: 'text' }>;
    expect(text.text).toBe('hello world');

    // Plan is stored on the entry itself
    expect(history[0]!.plan).toEqual([{ content: 'b', priority: 'high', status: 'completed' }]);
  });

  it('applies tool_call_update to the entry where the tool call originally appeared', () => {
    const history: SessionHistoryInput[] = [
      {
        id: 'a1',
        role: 'assistant',
        items: [
          { type: 'tool_call', toolCallId: 'tc1', title: 'Do', status: 'pending', kind: 'read' },
        ] satisfies MessageContent[],
        timestamp: new Date().toISOString(),
        read: undefined,
        userId: undefined,
      },
      {
        id: 'a2',
        role: 'assistant',
        items: [{ type: 'text', text: 'later' }] satisfies MessageContent[],
        timestamp: new Date().toISOString(),
        read: undefined,
        userId: undefined,
      },
    ];

    applyNotificationOnHistory(history, [
      makeNotification({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc1',
        status: 'completed',
      }),
    ]);

    const firstItems = history[0]!.items as unknown as MessageContent[];
    const tool = firstItems.find((m) => m.type === 'tool_call') as Extract<
      MessageContent,
      { type: 'tool_call' }
    >;
    expect(tool.status).toBe('completed');
  });
});
