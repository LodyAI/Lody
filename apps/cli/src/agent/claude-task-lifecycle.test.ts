import { describe, expect, it } from 'vitest';

import { convertClaudeTaskLifecycleNotification } from './claude-task-lifecycle';

describe('convertClaudeTaskLifecycleNotification', () => {
  it('converts task_started into a bounded synthetic tool call', () => {
    const result = convertClaudeTaskLifecycleNotification({
      sessionId: 'acp-session-1',
      acpSessionId: 'sdk-session-1',
      message: {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-1',
        tool_use_id: 'tool-1',
        description: 'Find CLI startup behavior',
        subagent_type: 'Explore',
        task_type: 'local_agent',
        prompt: 'full prompt that must not be persisted',
        output_file: '/tmp/ignored',
        skip_transcript: true,
        uuid: 'event-1',
        session_id: 'sdk-message-session',
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.notification).toMatchObject({
      sessionId: 'acp-session-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'task:task-1',
        title: 'Explore: Find CLI startup behavior',
        kind: 'think',
        status: 'in_progress',
        content: [
          {
            type: 'content',
            content: { type: 'text', text: 'Find CLI startup behavior' },
          },
        ],
      },
    });

    expect(result.notification.update._meta?.lody?.task).toMatchObject({
      version: 1,
      taskId: 'task-1',
      kind: 'subagent',
      description: 'Find CLI startup behavior',
      status: 'in_progress',
      actor: 'Explore',
      parentToolCallId: 'tool-1',
      skipTranscript: true,
    });
    expect(JSON.stringify(result.notification.update._meta)).not.toContain('full prompt');
    expect(JSON.stringify(result.notification.update._meta)).not.toContain('/tmp/ignored');
  });

  it('converts task_notification into a terminal update with filtered metadata', () => {
    const result = convertClaudeTaskLifecycleNotification({
      sessionId: 'acp-session-1',
      acpSessionId: 'sdk-session-1',
      message: {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task-1',
        tool_use_id: 'tool-1',
        status: 'completed',
        output_file: '/tmp/task-1.output',
        summary: 'Agent finished',
        usage: { total_tokens: 123, tool_uses: 3, duration_ms: 700 },
        uuid: 'event-2',
        session_id: 'sdk-message-session',
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.notification).toMatchObject({
      sessionId: 'acp-session-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'task:task-1',
        title: 'Claude task: Agent finished',
        kind: 'think',
        status: 'completed',
      },
    });

    expect(result.notification.update._meta?.lody?.task).toMatchObject({
      version: 1,
      taskId: 'task-1',
      kind: 'subagent',
      status: 'completed',
      summary: 'Agent finished',
      usage: { totalTokens: 123, toolUses: 3, durationMs: 700 },
      parentToolCallId: 'tool-1',
    });
    expect(result.notification.update._meta?.lody?.task).not.toHaveProperty('actor');
    expect(JSON.stringify(result.notification.update._meta)).not.toContain('/tmp/task-1.output');
  });
});
