import { describe, it, expect } from 'vitest';
import { buildReplayPromptFromHistory, type SessionHistoryInput } from '@lody/shared';

describe('buildReplayPromptFromHistory', () => {
  it('should exclude the specified history entry', () => {
    const history: SessionHistoryInput[] = [
      {
        id: '1',
        role: 'user',
        timestamp: '2024-01-01T00:00:00Z',
        fileDiff: [],
        items: [{ type: 'text', text: 'First message' }],
      },
      {
        id: '2',
        role: 'user',
        timestamp: '2024-01-01T00:01:00Z',
        fileDiff: [],
        items: [{ type: 'text', text: 'Second message - should be excluded' }],
      },
    ];

    const result = buildReplayPromptFromHistory({
      history,
      excludeTurnId: '2',
    });

    expect(result.promptText).toContain('First message');
    expect(result.promptText).not.toContain('Second message - should be excluded');
    expect(result.stats.messagesIncluded).toBe(1);
  });

  it('should preserve tool content text when terminal is omitted (Pass B)', () => {
    // Create history that exceeds budget to trigger Pass B
    const largeOutput = 'output '.repeat(10000);
    const history: SessionHistoryInput[] = [
      {
        id: '1',
        role: 'assistant',
        timestamp: '2024-01-01T00:00:00Z',
        fileDiff: [],
        items: [
          {
            type: 'tool_call',
            toolCallId: 'tc1',
            status: 'completed',
            kind: 'other',
            content: [
              { type: 'terminal_output', output: largeOutput },
              {
                type: 'content',
                content: { type: 'text', text: 'Important tool result text' },
              },
            ],
          },
        ],
      },
    ];

    const result = buildReplayPromptFromHistory({
      history,
      maxChars: 1000,
    });

    // Terminal should be omitted
    expect(result.stats.terminalOmitted).toBe(true);
    expect(result.promptText).not.toContain('[Terminal Output]');
    // But content text should still be preserved
    expect(result.promptText).toContain('Important tool result text');
  });

  it('should preserve both diff and content when terminal is omitted (Pass B)', () => {
    // Create history with multiple content types that exceeds budget
    const largeOutput = 'output '.repeat(10000);
    const history: SessionHistoryInput[] = [
      {
        id: '1',
        role: 'user',
        timestamp: '2024-01-01T00:00:00Z',
        fileDiff: [],
        items: [{ type: 'text', text: 'Make changes' }],
      },
      {
        id: '2',
        role: 'assistant',
        timestamp: '2024-01-01T00:01:00Z',
        fileDiff: [],
        items: [
          {
            type: 'tool_call',
            toolCallId: 'tc1',
            status: 'completed',
            kind: 'edit',
            title: 'Edit File',
            content: [
              { type: 'terminal_command', command: 'git', args: ['diff'] },
              { type: 'terminal_output', output: largeOutput },
              { type: 'diff', path: 'src/app.ts', newText: 'new code' },
            ],
          },
        ],
      },
    ];

    const result = buildReplayPromptFromHistory({
      history,
      maxChars: 1000,
    });

    // Terminal content should be omitted
    expect(result.stats.terminalOmitted).toBe(true);
    expect(result.promptText).not.toContain('[Terminal Output]');
    expect(result.promptText).not.toContain('[Command]');
    // But non-terminal content should be preserved
    expect(result.promptText).toContain('[Tool: Edit File]');
    expect(result.promptText).toContain('[Diff: src/app.ts]');
    // Files referenced should still work
    expect(result.promptText).toContain('Edit:');
    expect(result.promptText).toContain('src/app.ts');
  });

  it('should preserve diff content even in Pass C (thinking omitted)', () => {
    // Create history that exceeds budget even without terminal, triggering Pass C
    const largeThinking = 'thinking '.repeat(5000);
    const history: SessionHistoryInput[] = [
      {
        id: '1',
        role: 'user',
        timestamp: '2024-01-01T00:00:00Z',
        fileDiff: [],
        items: [{ type: 'text', text: 'Edit file' }],
      },
      {
        id: '2',
        role: 'assistant',
        timestamp: '2024-01-01T00:01:00Z',
        fileDiff: [],
        items: [
          { type: 'thought', text: largeThinking },
          {
            type: 'tool_call',
            toolCallId: 'tc1',
            status: 'completed',
            kind: 'edit',
            content: [{ type: 'diff', path: 'critical-file.ts', newText: 'changes' }],
          },
        ],
      },
    ];

    const result = buildReplayPromptFromHistory({
      history,
      maxChars: 1000,
    });

    // Both terminal and thinking should be omitted
    expect(result.stats.terminalOmitted).toBe(true);
    expect(result.stats.thinkingOmitted).toBe(true);
    expect(result.promptText).not.toContain('<thinking>');
    // But diff should still be preserved
    expect(result.promptText).toContain('[Diff: critical-file.ts]');
  });

  it('should truncate history when budget is still exceeded (Pass D)', () => {
    // Create history that exceeds budget even without terminal and thinking
    const history: SessionHistoryInput[] = [];
    for (let i = 0; i < 100; i++) {
      history.push({
        id: `${i}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        timestamp: new Date(Date.now() + i * 1000).toISOString(),
        fileDiff: [],
        items: [{ type: 'text', text: 'a'.repeat(500) }],
      });
    }

    const result = buildReplayPromptFromHistory({
      history,
      maxChars: 5000,
    });

    expect(result.stats.truncated).toBe(true);
    expect(result.promptText.length).toBeLessThanOrEqual(5000);
    expect(result.promptText).toContain('[Earlier context truncated]');
    expect(result.noticeMeta.truncated).toBe(true);
  });

  it('should skip system role messages in replay', () => {
    const history: SessionHistoryInput[] = [
      {
        id: '1',
        role: 'user',
        timestamp: '2024-01-01T00:00:00Z',
        fileDiff: [],
        items: [{ type: 'text', text: 'Hello' }],
      },
      {
        id: '2',
        role: 'system',
        timestamp: '2024-01-01T00:00:30Z',
        fileDiff: [],
        items: [
          {
            type: 'system_notice',
            name: 'resume_from_external_chat_history',
          },
        ],
      },
      {
        id: '3',
        role: 'assistant',
        timestamp: '2024-01-01T00:01:00Z',
        fileDiff: [],
        items: [{ type: 'text', text: 'Hi there!' }],
      },
    ];

    const result = buildReplayPromptFromHistory({ history });

    expect(result.promptText).not.toContain('system_notice');
    expect(result.promptText).not.toContain('resume_from_external_chat_history');
    expect(result.stats.messagesIncluded).toBe(2);
  });

  it('should redact sensitive tokens from terminal output', () => {
    const history: SessionHistoryInput[] = [
      {
        id: '1',
        role: 'assistant',
        timestamp: '2024-01-01T00:00:00Z',
        fileDiff: [],
        items: [
          {
            type: 'tool_call',
            toolCallId: 'tc1',
            status: 'completed',
            kind: 'execute',
            content: [
              {
                type: 'terminal_output',
                output:
                  'Using token ghp_1234567890abcdefghijklmnopqrst and Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
              },
            ],
          },
        ],
      },
    ];

    const result = buildReplayPromptFromHistory({ history });

    expect(result.promptText).not.toContain('ghp_1234567890abcdefghijklmnopqrst');
    expect(result.promptText).toContain('ghp_***');
    expect(result.promptText).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(result.promptText).toContain('Bearer ***');
  });

  it('should redact OpenAI API keys and URL auth', () => {
    const history: SessionHistoryInput[] = [
      {
        id: '1',
        role: 'assistant',
        timestamp: '2024-01-01T00:00:00Z',
        fileDiff: [],
        items: [
          {
            type: 'tool_call',
            toolCallId: 'tc1',
            status: 'completed',
            kind: 'execute',
            content: [
              {
                type: 'terminal_output',
                output:
                  'API key: sk-1234567890abcdefghijklmnop and url https://user:password@api.example.com',
              },
            ],
          },
        ],
      },
    ];

    const result = buildReplayPromptFromHistory({ history });

    expect(result.promptText).not.toContain('sk-1234567890abcdefghijklmnop');
    expect(result.promptText).toContain('sk-***');
    expect(result.promptText).not.toContain('user:password');
    expect(result.promptText).toContain('https://***@');
  });
});
