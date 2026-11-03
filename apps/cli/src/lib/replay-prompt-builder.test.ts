import { describe, it, expect } from 'vitest';
import {
  buildReplayPromptFromHistory,
  createReplayPromptBuilder,
  hasRecentResumeNotice,
  type SessionHistoryInput,
} from '@lody/shared';

describe('buildReplayPromptFromHistory', () => {
  /**
   * This test demonstrates the exact output format of the replay prompt.
   * The format is designed for easy parsing by LLMs with clear section markers.
   */
  it('should generate exact expected output format (snapshot test)', () => {
    const history: SessionHistoryInput[] = [
      {
        id: '1',
        role: 'user',
        timestamp: '2024-01-01T00:00:00Z',
        fileDiff: [],
        items: [{ type: 'text', text: 'Please read config.json and update it' }],
      },
      {
        id: '2',
        role: 'assistant',
        timestamp: '2024-01-01T00:01:00Z',
        fileDiff: [],
        items: [
          { type: 'thought', text: 'I need to read the config first' },
          { type: 'text', text: 'I will read the config file.' },
          {
            type: 'tool_call',
            toolCallId: 'tc1',
            status: 'completed',
            kind: 'read',
            title: 'Read File',
            locations: [{ path: 'config.json' }],
          },
          {
            type: 'tool_call',
            toolCallId: 'tc2',
            status: 'completed',
            kind: 'edit',
            title: 'Edit File',
            content: [{ type: 'diff', path: 'config.json', newText: '{"updated": true}' }],
          },
          {
            type: 'plan',
            entries: [
              { content: 'Read config', status: 'completed' },
              { content: 'Update config', status: 'in_progress' },
            ],
          },
        ],
      },
    ];

    const result = buildReplayPromptFromHistory({ history });

    // The exact expected output format
    const expectedOutput = `=== Previous Conversation Context ===

[User]
Please read config.json and update it

[Assistant]
<thinking>
I need to read the config first
</thinking>

I will read the config file.

[Tool: Read File]

[Tool: Edit File]
[Diff: config.json]

[Plan]
- [completed] Read config
- [in_progress] Update config

=== Files Referenced ===
Edit: config.json

=== End of Previous Context ===
`;

    expect(result.promptText).toBe(expectedOutput);
  });

  /**
   * Test with terminal command and output showing the exact format
   */
  it('should generate exact format for terminal output', () => {
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
            title: 'Run Command',
            content: [
              { type: 'terminal_command', command: 'npm', args: ['test'] },
              { type: 'terminal_output', output: 'All tests passed!' },
            ],
          },
        ],
      },
    ];

    const result = buildReplayPromptFromHistory({ history });

    const expectedOutput = `=== Previous Conversation Context ===

[Assistant]
[Tool: Run Command]
[Command] npm test
[Terminal Output]
All tests passed!

=== End of Previous Context ===
`;

    expect(result.promptText).toBe(expectedOutput);
  });

  /**
   * Test terminal output truncation with '...' prefix
   */
  it('should truncate long terminal output with ... prefix', () => {
    const longOutput = 'x'.repeat(2000);
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
            content: [{ type: 'terminal_output', output: longOutput }],
          },
        ],
      },
    ];

    const result = buildReplayPromptFromHistory({ history });

    // Should contain '...' prefix followed by last 1024 chars
    expect(result.promptText).toContain('[Terminal Output]\n...' + 'x'.repeat(1024));
    expect(result.promptText).not.toContain('x'.repeat(2000));
  });

  /**
   * Test Files Referenced section format with multiple file types
   */
  it('should generate correct Files Referenced section format', () => {
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
            kind: 'read',
            locations: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }],
          },
          {
            type: 'tool_call',
            toolCallId: 'tc2',
            status: 'completed',
            kind: 'edit',
            locations: [{ path: 'src/c.ts' }],
          },
          {
            type: 'tool_call',
            toolCallId: 'tc3',
            status: 'completed',
            kind: 'other',
            locations: [{ path: 'package.json' }],
          },
        ],
      },
    ];

    const result = buildReplayPromptFromHistory({ history });

    // Files should be grouped by kind
    expect(result.promptText).toContain('=== Files Referenced ===');
    expect(result.promptText).toContain('Read: src/a.ts, src/b.ts');
    expect(result.promptText).toContain('Edit: src/c.ts');
    expect(result.promptText).toContain('Other: package.json');
  });

  /**
   * Test truncated history format with prefix marker
   */
  it('should add truncation marker when history is truncated', () => {
    // Create very long history to trigger truncation
    const history: SessionHistoryInput[] = [];
    for (let i = 0; i < 50; i++) {
      history.push({
        id: `${i}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        timestamp: new Date(Date.now() + i * 1000).toISOString(),
        fileDiff: [],
        items: [{ type: 'text', text: 'Message content here '.repeat(50) }],
      });
    }

    const result = buildReplayPromptFromHistory({ history, maxChars: 2000 });

    expect(result.stats.truncated).toBe(true);
    expect(result.promptText).toContain('... [Earlier context truncated] ...');
    expect(result.promptText).toContain('=== End of Previous Context ===');
  });

  it('should generate a prompt with user and assistant text messages', () => {
    const history: SessionHistoryInput[] = [
      {
        id: '1',
        role: 'user',
        timestamp: '2024-01-01T00:00:00Z',
        fileDiff: [],
        items: [{ type: 'text', text: 'Hello, can you help me?' }],
      },
      {
        id: '2',
        role: 'assistant',
        timestamp: '2024-01-01T00:01:00Z',
        fileDiff: [],
        items: [{ type: 'text', text: 'Of course! How can I help?' }],
      },
    ];

    const result = buildReplayPromptFromHistory({ history });

    expect(result.promptText).toContain('[User]');
    expect(result.promptText).toContain('Hello, can you help me?');
    expect(result.promptText).toContain('[Assistant]');
    expect(result.promptText).toContain('Of course! How can I help?');
    expect(result.stats.messagesIncluded).toBe(2);
    expect(result.stats.truncated).toBe(false);
    expect(result.stats.terminalOmitted).toBe(false);
    expect(result.stats.thinkingOmitted).toBe(false);
  });

  it('should include thinking content by default', () => {
    const history: SessionHistoryInput[] = [
      {
        id: '1',
        role: 'assistant',
        timestamp: '2024-01-01T00:00:00Z',
        fileDiff: [],
        items: [{ type: 'thought', text: 'Let me think about this...' }],
      },
    ];

    const result = buildReplayPromptFromHistory({ history });

    expect(result.promptText).toContain('<thinking>');
    expect(result.promptText).toContain('</thinking>');
    expect(result.promptText).toContain('Let me think about this...');
  });

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

  it('should collect file paths from tool_call locations', () => {
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
            kind: 'read',
            locations: [{ path: 'src/index.ts' }],
          },
          {
            type: 'tool_call',
            toolCallId: 'tc2',
            status: 'completed',
            kind: 'edit',
            locations: [{ path: 'src/utils.ts' }],
          },
        ],
      },
    ];

    const result = buildReplayPromptFromHistory({ history });

    expect(result.promptText).toContain('Files Referenced');
    expect(result.promptText).toContain('Read:');
    expect(result.promptText).toContain('src/index.ts');
    expect(result.promptText).toContain('Edit:');
    expect(result.promptText).toContain('src/utils.ts');
    expect(result.stats.pathsCount).toBe(2);
  });

  it('should apply terminal output tail truncation', () => {
    const longOutput = 'a'.repeat(2000);
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
                output: longOutput,
              },
            ],
          },
        ],
      },
    ];

    const result = buildReplayPromptFromHistory({
      history,
      terminalTailChars: 100,
    });

    // The output should be truncated to 100 chars + '...' prefix
    expect(result.promptText).toContain('...');
    expect(result.promptText).not.toContain(longOutput);
    expect(result.stats.terminalTailApplied).toBe(true);
  });

  it('should omit terminal output when budget is exceeded (Pass B)', () => {
    // Create history that exceeds budget with terminal output
    const largeOutput = 'x'.repeat(50000);
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
        role: 'assistant',
        timestamp: '2024-01-01T00:01:00Z',
        fileDiff: [],
        items: [
          {
            type: 'tool_call',
            toolCallId: 'tc1',
            status: 'completed',
            kind: 'execute',
            content: [{ type: 'terminal_output', output: largeOutput }],
          },
        ],
      },
    ];

    const result = buildReplayPromptFromHistory({
      history,
      maxChars: 1000,
    });

    expect(result.stats.terminalOmitted).toBe(true);
    expect(result.promptText).not.toContain('[Terminal Output]');
    expect(result.noticeMeta.terminalOmitted).toBe(true);
  });

  it('should preserve diff content when terminal is omitted (Pass B)', () => {
    // Create history that exceeds budget to trigger Pass B
    const largeOutput = 'output '.repeat(10000);
    const history: SessionHistoryInput[] = [
      {
        id: '1',
        role: 'user',
        timestamp: '2024-01-01T00:00:00Z',
        fileDiff: [],
        items: [{ type: 'text', text: 'Edit the file' }],
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
            content: [
              { type: 'terminal_output', output: largeOutput },
              { type: 'diff', path: 'src/important.ts', newText: 'new content' },
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
    // But diff should still be preserved
    expect(result.promptText).toContain('[Diff: src/important.ts]');
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

  it('should omit thinking when budget is still exceeded after removing terminal (Pass C)', () => {
    // Create history that exceeds budget even without terminal
    const largeThinking = 'thinking '.repeat(5000);
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
        role: 'assistant',
        timestamp: '2024-01-01T00:01:00Z',
        fileDiff: [],
        items: [{ type: 'thought', text: largeThinking }],
      },
    ];

    const result = buildReplayPromptFromHistory({
      history,
      maxChars: 1000,
    });

    expect(result.stats.thinkingOmitted).toBe(true);
    expect(result.promptText).not.toContain('[Thinking]');
    expect(result.noticeMeta.thinkingOmitted).toBe(true);
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

  it('should handle empty history', () => {
    const result = buildReplayPromptFromHistory({ history: [] });

    expect(result.promptText).toContain('Previous Conversation Context');
    expect(result.promptText).toContain('End of Previous Context');
    expect(result.stats.messagesIncluded).toBe(0);
    expect(result.stats.pathsCount).toBe(0);
  });

  it('should include plan entries', () => {
    const history: SessionHistoryInput[] = [
      {
        id: '1',
        role: 'assistant',
        timestamp: '2024-01-01T00:00:00Z',
        fileDiff: [],
        items: [
          {
            type: 'plan',
            entries: [
              { content: 'First task', status: 'completed' },
              { content: 'Second task', status: 'in_progress' },
            ],
          },
        ],
      },
    ];

    const result = buildReplayPromptFromHistory({ history });

    expect(result.promptText).toContain('[Plan]');
    expect(result.promptText).toContain('First task');
    expect(result.promptText).toContain('Second task');
    expect(result.promptText).toContain('[completed]');
    expect(result.promptText).toContain('[in_progress]');
  });

  it('should generate prompt with correct structure and delimiters', () => {
    const history: SessionHistoryInput[] = [
      {
        id: '1',
        role: 'user',
        timestamp: '2024-01-01T00:00:00Z',
        fileDiff: [],
        items: [{ type: 'text', text: 'Please read the config file' }],
      },
      {
        id: '2',
        role: 'assistant',
        timestamp: '2024-01-01T00:01:00Z',
        fileDiff: [],
        items: [
          { type: 'thought', text: 'I need to read the config' },
          { type: 'text', text: 'I will read the config file for you.' },
          {
            type: 'tool_call',
            toolCallId: 'tc1',
            status: 'completed',
            kind: 'read',
            title: 'Read File',
            locations: [{ path: 'config.json' }],
          },
        ],
      },
    ];

    const result = buildReplayPromptFromHistory({ history });

    // Verify main structure delimiters
    expect(result.promptText).toContain('=== Previous Conversation Context ===');
    expect(result.promptText).toContain('=== Files Referenced ===');
    expect(result.promptText).toContain('=== End of Previous Context ===');

    // Verify role labels
    expect(result.promptText).toContain('[User]');
    expect(result.promptText).toContain('[Assistant]');

    // Verify thinking tags (XML-style for Claude compatibility)
    expect(result.promptText).toContain('<thinking>');
    expect(result.promptText).toContain('</thinking>');
    expect(result.promptText).toContain('I need to read the config');

    // Verify tool label
    expect(result.promptText).toContain('[Tool: Read File]');

    // Verify files referenced section
    expect(result.promptText).toContain('Read:');
    expect(result.promptText).toContain('config.json');

    // Verify order: context header comes before content, end marker comes last
    const headerIndex = result.promptText.indexOf('=== Previous Conversation Context ===');
    const userIndex = result.promptText.indexOf('[User]');
    const filesIndex = result.promptText.indexOf('=== Files Referenced ===');
    const endIndex = result.promptText.indexOf('=== End of Previous Context ===');

    expect(headerIndex).toBeLessThan(userIndex);
    expect(userIndex).toBeLessThan(filesIndex);
    expect(filesIndex).toBeLessThan(endIndex);
  });

  it('should include terminal command and output with correct labels', () => {
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
                type: 'terminal_command',
                command: 'npm',
                args: ['install'],
              },
              {
                type: 'terminal_output',
                output: 'added 100 packages',
              },
            ],
          },
        ],
      },
    ];

    const result = buildReplayPromptFromHistory({ history });

    expect(result.promptText).toContain('[Command] npm install');
    expect(result.promptText).toContain('[Terminal Output]');
    expect(result.promptText).toContain('added 100 packages');
  });

  it('should include diff paths with correct label', () => {
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
            kind: 'edit',
            content: [
              {
                type: 'diff',
                path: 'src/main.ts',
                newText: 'console.log("hello")',
              },
            ],
          },
        ],
      },
    ];

    const result = buildReplayPromptFromHistory({ history });

    expect(result.promptText).toContain('[Diff: src/main.ts]');
    // Diff path should also be collected in files referenced
    expect(result.promptText).toContain('Edit:');
    expect(result.promptText).toContain('src/main.ts');
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

describe('hasRecentResumeNotice', () => {
  it('should return true when resume notice is immediately before the last user message', () => {
    const history: SessionHistoryInput[] = [
      {
        id: '1',
        role: 'assistant',
        timestamp: '2024-01-01T00:00:00Z',
        fileDiff: [],
        items: [{ type: 'text', text: 'Previous response' }],
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
        role: 'user',
        timestamp: '2024-01-01T00:01:00Z',
        fileDiff: [],
        items: [{ type: 'text', text: 'Hello' }],
      },
    ];

    expect(hasRecentResumeNotice(history)).toBe(true);
  });

  it('should return false when no resume notice exists', () => {
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
        role: 'assistant',
        timestamp: '2024-01-01T00:01:00Z',
        fileDiff: [],
        items: [{ type: 'text', text: 'Hi!' }],
      },
    ];

    expect(hasRecentResumeNotice(history)).toBe(false);
  });

  it('should return false when resume notice is not immediately before the last user message', () => {
    const history: SessionHistoryInput[] = [
      {
        id: '1',
        role: 'system',
        timestamp: '2024-01-01T00:00:00Z',
        fileDiff: [],
        items: [
          {
            type: 'system_notice',
            name: 'resume_from_external_chat_history',
          },
        ],
      },
      {
        id: '2',
        role: 'user',
        timestamp: '2024-01-01T00:00:30Z',
        fileDiff: [],
        items: [{ type: 'text', text: 'First message' }],
      },
      {
        id: '3',
        role: 'assistant',
        timestamp: '2024-01-01T00:01:00Z',
        fileDiff: [],
        items: [{ type: 'text', text: 'Response' }],
      },
      {
        id: '4',
        role: 'user',
        timestamp: '2024-01-01T00:02:00Z',
        fileDiff: [],
        items: [{ type: 'text', text: 'Second message' }],
      },
    ];

    // The notice is before the first user message, not the last one
    expect(hasRecentResumeNotice(history)).toBe(false);
  });

  it('should allow new notice on second resume (different conversation)', () => {
    // Simulate: first resume, conversation, then second resume
    const history: SessionHistoryInput[] = [
      // First resume notice
      {
        id: '1',
        role: 'system',
        timestamp: '2024-01-01T00:00:00Z',
        fileDiff: [],
        items: [
          {
            type: 'system_notice',
            name: 'resume_from_external_chat_history',
          },
        ],
      },
      {
        id: '2',
        role: 'user',
        timestamp: '2024-01-01T00:00:30Z',
        fileDiff: [],
        items: [{ type: 'text', text: 'First resumed message' }],
      },
      {
        id: '3',
        role: 'assistant',
        timestamp: '2024-01-01T00:01:00Z',
        fileDiff: [],
        items: [{ type: 'text', text: 'Response' }],
      },
      // Now user sends another message (second resume scenario)
      {
        id: '4',
        role: 'user',
        timestamp: '2024-01-01T00:02:00Z',
        fileDiff: [],
        items: [{ type: 'text', text: 'Second resumed message' }],
      },
    ];

    // Should return false - there's no notice before the LAST user message
    // This allows adding a new notice for the second resume
    expect(hasRecentResumeNotice(history)).toBe(false);
  });
});

describe('streamed replay equivalence', () => {
  it('preserves every pass, exact budget boundary, path order and omission statistic', () => {
    const history: SessionHistoryInput[] = Array.from({ length: 18 }, (_, index) => ({
      id: `entry-${index}`,
      role: index % 5 === 0 ? 'system' : index % 3 === 0 ? 'user' : 'assistant',
      timestamp: 'synthetic',
      items: [
        { type: 'thought', text: '思考🙂'.repeat(index * 9) },
        { type: 'text', text: 'answer\n'.repeat(index * 11) },
        {
          type: 'tool_call',
          toolCallId: `tool-${index}`,
          status: 'completed',
          kind: index % 2 ? 'edit' : 'read',
          locations: [{ path: `file-${index % 4}.ts` }],
          content: [
            {
              type: 'terminal_output',
              output: 'stdout ghp_abcdefghijklmnopqrstuvwxyz1234567890 '.repeat(90),
            },
            { type: 'diff', path: `file-${index % 3}.ts`, newText: 'changed' },
            { type: 'text', text: 'tool text' },
          ],
        },
      ],
    }));
    for (const excludeTurnId of [undefined, 'entry-3'])
      for (const maxChars of [
        0,
        1,
        80,
        81,
        100,
        299.5,
        300,
        999,
        1500,
        3000,
        6000,
        10000,
        100000,
        Infinity,
        NaN,
      ]) {
        const options = { maxChars, excludeTurnId, terminalTailChars: 109 };
        const builder = createReplayPromptBuilder(options);
        for (const entry of history) builder.add(entry);
        expect(builder.finish()).toEqual(buildReplayPromptFromHistory({ history, ...options }));
      }
    for (const terminalTailChars of [0, 1, 1024]) {
      const result = buildReplayPromptFromHistory({ history, terminalTailChars });
      for (const maxChars of [
        result.stats.usedChars - 1,
        result.stats.usedChars,
        result.stats.usedChars + 1,
      ]) {
        const builder = createReplayPromptBuilder({ maxChars, terminalTailChars });
        for (const entry of history) builder.add(entry);
        expect(builder.finish()).toEqual(
          buildReplayPromptFromHistory({ history, maxChars, terminalTailChars })
        );
      }
    }
  });
});
