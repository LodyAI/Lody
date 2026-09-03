import { describe, expect, it } from 'vitest';

import {
  parseSessionNotification,
  type AcpSessionNotification,
  type MessageContent,
} from '@lody/shared';

import { buildHistoryReplayImport } from '../src/replay-import';

function makeNotification(update: unknown): AcpSessionNotification {
  return parseSessionNotification({ sessionId: 'codex-session-1', update });
}

function contentsOf(entry: { items?: unknown }): MessageContent[] {
  return (Array.isArray(entry.items) ? entry.items : []) as MessageContent[];
}

const codexProvider = { cliType: 'builtin', agentType: 'codex' } as const;
const claudeProvider = { cliType: 'builtin', agentType: 'claude' } as const;

describe('buildHistoryReplayImport', () => {
  it('projects Codex user chunks into a single resumable user history entry', () => {
    const result = buildHistoryReplayImport(
      [
        makeNotification({
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'hello ' },
        }),
        makeNotification({
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'world' },
        }),
      ],
      {
        acpSessionId: 'codex-session-1',
        provider: codexProvider,
        userId: 'user-1',
        now: () => '2026-05-14T00:00:00.000Z',
        createId: () => 'turn-1',
      }
    );

    expect(result.droppedNotifications).toBe(0);
    expect(result.history).toHaveLength(1);
    expect(result.history[0]?.role).toBe('user');
    expect(contentsOf(result.history[0]!).map((item) => item.type)).toEqual(['text']);
    expect(
      (contentsOf(result.history[0]!)[0] as Extract<MessageContent, { type: 'text' }>).text
    ).toBe('hello world');
    expect(result.history[0]?.inputConfig).toMatchObject({
      prompt: 'hello world',
      cliType: 'builtin',
      agentType: 'codex',
      resume: 'codex-session-1',
    });
    expect(result.history[0]?.finished).toBe(true);
    expect(result.history[0]?.read).toBe(true);
    expect(result.history[0]?.status).toBe('seen');
  });

  it('can import Codex user chunks as handled snapshot history', () => {
    const result = buildHistoryReplayImport(
      [
        makeNotification({
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'already answered' },
        }),
      ],
      {
        acpSessionId: 'codex-session-1',
        provider: codexProvider,
        mode: 'imported_snapshot',
        now: () => '2026-05-14T00:00:00.000Z',
        createId: () => 'turn-1',
      }
    );

    expect(result.history).toHaveLength(1);
    expect(result.history[0]?.status).toBe('handled');
    expect(result.history[0]?.inputConfig).toMatchObject({
      prompt: 'already answered',
      cliType: 'builtin',
      agentType: 'codex',
    });
    expect(result.history[0]?.inputConfig?.resume).toBeUndefined();
  });

  it('can project Claude user chunks with Claude input config', () => {
    const result = buildHistoryReplayImport(
      [
        makeNotification({
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'hello claude' },
        }),
      ],
      {
        acpSessionId: 'claude-session-1',
        provider: claudeProvider,
        now: () => '2026-05-14T00:00:00.000Z',
        createId: () => 'turn-1',
      }
    );

    expect(result.history[0]?.inputConfig).toMatchObject({
      prompt: 'hello claude',
      cliType: 'builtin',
      agentType: 'claude',
      resume: 'claude-session-1',
    });
  });

  it('keeps user, thought, tool call, and assistant text order from replay notifications', () => {
    const result = buildHistoryReplayImport(
      [
        makeNotification({
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'inspect repo' },
        }),
        makeNotification({
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'Need context.' },
        }),
        makeNotification({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool-1',
          kind: 'read',
          title: 'Read package.json',
          status: 'completed',
          rawInput: { path: 'package.json' },
        }),
        makeNotification({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Done.' },
        }),
        makeNotification({
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'continue' },
        }),
      ],
      {
        acpSessionId: 'codex-session-1',
        provider: codexProvider,
        now: () => '2026-05-14T00:00:00.000Z',
        createId: (() => {
          let index = 0;
          return () => `turn-${index++}`;
        })(),
      }
    );

    expect(result.droppedNotifications).toBe(0);
    expect(result.history.map((entry) => entry.role)).toEqual(['user', 'assistant', 'user']);
    expect(contentsOf(result.history[0]!).map((item) => item.type)).toEqual(['text']);
    expect(contentsOf(result.history[1]!).map((item) => item.type)).toEqual([
      'thought',
      'tool_call',
      'text',
    ]);
    expect(result.history[1]?.finished).toBe(true);
    expect(contentsOf(result.history[2]!).map((item) => item.type)).toEqual(['text']);
  });

  it('imports recovered Codex tool calls with ACP 1.2 message ids without duplication', () => {
    const result = buildHistoryReplayImport(
      [
        makeNotification({
          sessionUpdate: 'user_message_chunk',
          messageId: 'item-user-1',
          content: { type: 'text', text: 'List the files' },
        }),
        makeNotification({
          sessionUpdate: 'tool_call',
          toolCallId: 'call-ls',
          title: 'List files',
          kind: 'read',
          status: 'in_progress',
        }),
        makeNotification({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-ls',
          status: 'completed',
          rawOutput: {
            output: 'Chunk ID: abc123\nProcess exited with code 0\nOutput:\nREADME.md\nsrc\n',
          },
        }),
        makeNotification({
          sessionUpdate: 'agent_message_chunk',
          messageId: 'item-agent-1',
          content: { type: 'text', text: 'The directory contains README.md and src.' },
        }),
      ],
      {
        acpSessionId: 'codex-session-1',
        provider: codexProvider,
        mode: 'imported_snapshot',
        now: () => '2026-07-10T00:00:00.000Z',
        createId: (() => {
          let index = 0;
          return () => `turn-${index++}`;
        })(),
      }
    );

    expect(result.droppedNotifications).toBe(0);
    expect(result.history.map((entry) => entry.role)).toEqual(['user', 'assistant']);
    const assistantItems = contentsOf(result.history[1]!);
    expect(assistantItems.map((item) => item.type)).toEqual(['tool_call', 'text']);
    expect(assistantItems.filter((item) => item.type === 'tool_call')).toHaveLength(1);
    expect(assistantItems[0]).toMatchObject({
      type: 'tool_call',
      toolCallId: 'call-ls',
      title: 'List files',
      kind: 'read',
      status: 'completed',
    });
  });

  it('drops non-text user chunks instead of importing unsupported content', () => {
    const result = buildHistoryReplayImport(
      [
        makeNotification({
          sessionUpdate: 'user_message_chunk',
          content: { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
        }),
      ],
      {
        acpSessionId: 'codex-session-1',
        provider: codexProvider,
      }
    );

    expect(result.history).toEqual([]);
    expect(result.droppedNotifications).toBe(1);
  });
});
