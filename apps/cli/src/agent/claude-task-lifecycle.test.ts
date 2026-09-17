import { describe, expect, it } from 'vitest';

import { convertClaudeTaskLifecycleNotification } from './claude-task-lifecycle';
import { convertKimiTaskLifecycleNotification } from './kimi-task-lifecycle';

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
      event: 'task_started',
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
      event: 'task_notification',
      status: 'completed',
      summary: 'Agent finished',
      usage: { totalTokens: 123, toolUses: 3, durationMs: 700 },
      parentToolCallId: 'tool-1',
    });
    expect(JSON.stringify(result.notification.update._meta)).not.toContain('/tmp/task-1.output');
  });

  it('keeps workflow_name, is_backgrounded and patch.error in the metadata', () => {
    const started = convertClaudeTaskLifecycleNotification({
      sessionId: 'acp-session-1',
      message: {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-2',
        description: 'Generate spec',
        task_type: 'local_workflow',
        workflow_name: 'spec',
      },
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.notification.update._meta?.lody?.task).toMatchObject({
      actor: 'spec',
      kind: 'subagent',
      event: 'task_started',
    });

    const updated = convertClaudeTaskLifecycleNotification({
      sessionId: 'acp-session-1',
      message: {
        type: 'system',
        subtype: 'task_updated',
        task_id: 'task-2',
        patch: { status: 'failed', error: 'boom', is_backgrounded: true },
      },
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.notification.update._meta?.lody?.task).toMatchObject({
      status: 'failed',
      error: 'boom',
      kind: 'background',
      event: 'task_updated',
    });
  });

  it('rejects malformed task lifecycle payloads', () => {
    const result = convertClaudeTaskLifecycleNotification({
      sessionId: 'acp-session-1',
      message: { subtype: 'task_progress', description: 'missing task_id' },
    });

    expect(result.ok).toBe(false);
  });
});

describe('convertKimiTaskLifecycleNotification', () => {
  it('uses the provider-neutral carrier and Kimi fallback actor', () => {
    const result = convertKimiTaskLifecycleNotification({
      sessionId: 'kimi-session-1',
      message: {
        subtype: 'task_started',
        task_id: 'agent-1',
        description: 'Explore the repository',
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.notification).toMatchObject({
      sessionId: 'kimi-session-1',
      update: { title: 'Kimi task: Explore the repository', status: 'in_progress' },
    });
    expect(result.notification.update._meta?.lody?.task).toMatchObject({
      version: 1,
      taskId: 'agent-1',
      kind: 'subagent',
      actor: 'Kimi task',
      event: 'task_started',
    });
  });
});
