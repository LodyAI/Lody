import { describe, expect, it, vi } from 'vitest';

import type { SessionNotification } from '@agentclientprotocol/sdk';
import type { ACPSessionId, SessionId } from '@lody/shared';

import { AgentClient } from '../src/agent/agent-client';
import { appendAutonomousACPNotifications } from '../src/lib/acp/history';
import { applyNotificationOnHistory } from '../src/lib/acp/history-apply';
import type { Logger } from '../src/utils/logger';
import { withHistoryPort } from './history-port-fixture';

const makeNotification = (update: SessionNotification['update']): SessionNotification => ({
  sessionId: 'session-1' as SessionId,
  update,
});

const context = (parentAgentId: string) => ({
  'cognition.ai/subagent_context': { parentAgentId },
});

// Devin lifecycle rows are in_progress tool_call_updates with no rawInput — the
// shape `filterNotificationsForHistory` compacts away. This test pins that the
// live pipeline (filter → enrich → apply) still persists them as task items.
describe('devin subagent updates through the ACP history pipeline', () => {
  it('persists the started row as a subagent_task and keeps internals out of items', async () => {
    let history: any[] = [];
    const doc = withHistoryPort({
      updateHistory: vi.fn(async (updateFn: (history: any[]) => any[]) => {
        history = updateFn(history);
      }),
      agentWrites: {
        applyAgentBatch: vi.fn(async (input: any) => {
          if (input.notifications?.length) {
            history = applyNotificationOnHistory(history, input.notifications, input.model, {
              ...(input.createId ? { createId: input.createId } : {}),
              ...(input.targetAssistantEntryId
                ? { targetAssistantEntryId: input.targetAssistantEntryId }
                : {}),
            });
          }
          return {
            status: 'accepted',
            receipt: { sessionId: 'session-1', kind: 'x', turnIds: [] },
          };
        }),
      },
      sessionData: {
        commands: {},
        history: {
          count: async () => 0,
          readAt: async () => ({ state: 'missing' as const }),
          readTurn: async () => ({ state: 'missing' as const }),
          readRange: async () => [],
          readDirectory: async () => [],
          observe: () => ({ initial: Promise.resolve([]), unsubscribe: () => {} }),
        },
      },
    }) as any;

    await appendAutonomousACPNotifications(
      doc,
      [
        makeNotification({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'agent-1',
          status: 'in_progress',
          _meta: {
            'cognition.ai/subagent_started': { agentId: 'agent-1', title: 'Explore' },
          },
        } as SessionNotification['update']),
        makeNotification({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'internal' },
          _meta: context('agent-1'),
        } as SessionNotification['update']),
        makeNotification({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'visible' },
        }),
      ],
      {} as any
    );

    const items = (history[0]?.items ?? []) as any[];
    expect(items).toEqual([
      expect.objectContaining({ type: 'subagent_task', taskId: 'agent-1' }),
      { type: 'text', text: 'visible' },
    ]);
  });
});

// The ingress drop is the only guard for usage/config/title consumers and the
// live UI — the applier cannot help them. These pin that classification: known
// subagent internals never reach onUpdateMessage or the usage meter, while
// unknown owners and unmaterializable lifecycle markers stay fail-open.
const createSilentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  setLevel: () => {},
  child: () => createSilentLogger(),
  close: async () => {},
});

function createDevinClient() {
  const onUpdateMessage = vi.fn();
  const onContextWindowUsageUpdate = vi.fn();
  const client = new AgentClient({
    sessionId: 'test-session' as SessionId,
    logger: createSilentLogger(),
    terminalManager: {} as never,
    agentConfig: { cliType: 'builtin', agentType: 'devin' },
    onUpdateMessage,
    onContextWindowUsageUpdate,
    onRequestPermission: vi.fn(async () => ({ outcome: { outcome: 'cancelled' as const } })),
  });
  // @ts-expect-error - accessing private field for test setup
  client.acpSessionId = 'acp-test' as ACPSessionId;
  return { client, onUpdateMessage, onContextWindowUsageUpdate };
}

const devinNotification = (update: Record<string, unknown>): SessionNotification =>
  ({ sessionId: 'acp-test', update }) as unknown as SessionNotification;

const devinStarted = (agentId: string, extra: Record<string, unknown> = {}) =>
  devinNotification({
    sessionUpdate: 'tool_call_update',
    toolCallId: agentId,
    status: 'in_progress',
    _meta: { 'cognition.ai/subagent_started': { agentId, title: 'Explore' } },
    ...extra,
  });

const devinChunk = (text: string, parentAgentId: string) =>
  devinNotification({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text },
    _meta: context(parentAgentId),
  });

describe('AgentClient Devin subagent ingress classification', () => {
  it('drops known subagent internals before usage and transcript consumers', async () => {
    const { client, onUpdateMessage, onContextWindowUsageUpdate } = createDevinClient();

    await client.sessionUpdate(devinStarted('agent-1'));
    await client.sessionUpdate(devinChunk('internal', 'agent-1'));
    await client.sessionUpdate(
      devinNotification({
        sessionUpdate: 'usage_update',
        size: 1000,
        used: 500,
        _meta: context('agent-1'),
      })
    );
    await client.sessionUpdate(
      devinNotification({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'root chunk' },
        _meta: context('root'),
      })
    );
    // Tagged tool updates must keep flowing — they carry permission-requested
    // rows and edit evidence that the applier still needs.
    await client.sessionUpdate(
      devinNotification({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'sub-tool-1',
        status: 'completed',
        _meta: context('agent-1'),
      })
    );

    // The lifecycle row, root chunk, and tagged tool update pass through.
    expect(onUpdateMessage).toHaveBeenCalledTimes(3);
    expect(onContextWindowUsageUpdate).not.toHaveBeenCalled();
  });

  it('keeps tagged internals visible when the owner never materialized', async () => {
    const { client, onUpdateMessage } = createDevinClient();

    // A lifecycle marker on a non-tool update cannot become a task row, so it
    // must not register — the agent's output stays visible (fail-open).
    await client.sessionUpdate(
      devinNotification({
        sessionUpdate: 'session_info_update',
        _meta: { 'cognition.ai/subagent_started': { agentId: 'agent-9' } },
      })
    );
    await client.sessionUpdate(devinChunk('drifted but visible', 'agent-9'));

    expect(onUpdateMessage).toHaveBeenCalledTimes(2);
  });
});
