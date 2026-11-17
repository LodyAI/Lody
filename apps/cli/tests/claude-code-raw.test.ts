import { describe, expect, it } from 'vitest';

import {
  parseClaudeCodeTerminalCommand,
  parseClaudeCodeTerminalOutput,
  isClaudeCodeTool,
  getClaudeCodeToolName,
} from '../src/lib/acp/claude-code-raw';
import {
  applyNotificationOnHistory,
  buildMessageContentFromNotification,
} from '../src/lib/acp/history-apply';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import type { MessageContent, SessionHistoryInput } from '@lody/shared';

describe('claude-code-raw', () => {
  describe('parseClaudeCodeTerminalCommand', () => {
    it('parses command from rawInput', () => {
      const rawInput = {
        command: 'echo "Hello from terminal"',
        description: 'Print greeting message',
        timeout: 5000,
      };
      const result = parseClaudeCodeTerminalCommand(rawInput);
      expect(result).toEqual({
        command: 'echo "Hello from terminal"',
        args: [],
        cwd: undefined,
      });
    });

    it('returns null for empty command', () => {
      const rawInput = {
        command: '',
        description: 'Empty command',
      };
      const result = parseClaudeCodeTerminalCommand(rawInput);
      expect(result).toBeNull();
    });

    it('returns null for missing command', () => {
      const rawInput = {
        description: 'No command',
      };
      const result = parseClaudeCodeTerminalCommand(rawInput);
      expect(result).toBeNull();
    });

    it('returns null for invalid input', () => {
      expect(parseClaudeCodeTerminalCommand(null)).toBeNull();
      expect(parseClaudeCodeTerminalCommand(undefined)).toBeNull();
      expect(parseClaudeCodeTerminalCommand('string')).toBeNull();
    });
  });

  describe('parseClaudeCodeTerminalOutput', () => {
    it('parses output with exit code from _meta', () => {
      const meta = {
        claudeCode: {
          toolName: 'mcp__acp__Bash',
          toolResponse: [
            {
              type: 'text',
              text: 'Exited with code 0.Final output:\n\nHello from terminal\n',
            },
          ],
        },
      };
      const result = parseClaudeCodeTerminalOutput(meta);
      expect(result).toEqual({
        output: 'Hello from terminal\n',
        exitCode: 0,
        truncated: false,
      });
    });

    it('parses output with non-zero exit code', () => {
      const meta = {
        claudeCode: {
          toolName: 'mcp__acp__Bash',
          toolResponse: [
            {
              type: 'text',
              text: 'Exited with code 1.Final output:\n\nError: command not found\n',
            },
          ],
        },
      };
      const result = parseClaudeCodeTerminalOutput(meta);
      expect(result).toEqual({
        output: 'Error: command not found\n',
        exitCode: 1,
        truncated: false,
      });
    });

    it('parses multiline output', () => {
      const meta = {
        claudeCode: {
          toolName: 'mcp__acp__Bash',
          toolResponse: [
            {
              type: 'text',
              text: 'Exited with code 0.Final output:\n\nLine 1\nLine 2\nLine 3\n',
            },
          ],
        },
      };
      const result = parseClaudeCodeTerminalOutput(meta);
      expect(result).toEqual({
        output: 'Line 1\nLine 2\nLine 3\n',
        exitCode: 0,
        truncated: false,
      });
    });

    it('handles empty output after exit code', () => {
      const meta = {
        claudeCode: {
          toolName: 'mcp__acp__Bash',
          toolResponse: [
            {
              type: 'text',
              text: 'Exited with code 0.Final output:\n\n',
            },
          ],
        },
      };
      const result = parseClaudeCodeTerminalOutput(meta);
      expect(result).toEqual({
        output: '',
        exitCode: 0,
        truncated: false,
      });
    });

    it('returns null for missing toolResponse', () => {
      const meta = {
        claudeCode: {
          toolName: 'mcp__acp__Bash',
        },
      };
      const result = parseClaudeCodeTerminalOutput(meta);
      expect(result).toBeNull();
    });

    it('returns null for empty toolResponse', () => {
      const meta = {
        claudeCode: {
          toolName: 'mcp__acp__Bash',
          toolResponse: [],
        },
      };
      const result = parseClaudeCodeTerminalOutput(meta);
      expect(result).toBeNull();
    });

    it('returns null for invalid meta', () => {
      expect(parseClaudeCodeTerminalOutput(null)).toBeNull();
      expect(parseClaudeCodeTerminalOutput(undefined)).toBeNull();
      expect(parseClaudeCodeTerminalOutput({})).toBeNull();
    });

    it('falls back to raw text when exit code format not matched', () => {
      const meta = {
        claudeCode: {
          toolName: 'mcp__acp__Bash',
          toolResponse: [
            {
              type: 'text',
              text: 'Some raw output without exit code format',
            },
          ],
        },
      };
      const result = parseClaudeCodeTerminalOutput(meta);
      expect(result).toEqual({
        output: 'Some raw output without exit code format',
        exitCode: undefined,
        truncated: false,
      });
    });

    // v0.19+ format tests: toolResponse is {stdout, stderr, interrupted, ...}
    it('parses v0.19+ Bash toolResponse with stdout/stderr', () => {
      const meta = {
        claudeCode: {
          toolName: 'Bash',
          toolResponse: {
            stdout: 'Hello from terminal\n',
            stderr: '',
            interrupted: false,
            isImage: false,
            noOutputExpected: false,
          },
        },
      };
      const result = parseClaudeCodeTerminalOutput(meta);
      expect(result).toEqual({
        stdout: 'Hello from terminal\n',
        stderr: '',
        exitCode: undefined,
        truncated: undefined,
      });
    });

    it('parses v0.19+ Bash toolResponse with stderr only', () => {
      const meta = {
        claudeCode: {
          toolName: 'Bash',
          toolResponse: {
            stdout: '',
            stderr: 'Error: not found\n',
            interrupted: false,
          },
        },
      };
      const result = parseClaudeCodeTerminalOutput(meta);
      expect(result).toEqual({
        stdout: '',
        stderr: 'Error: not found\n',
        exitCode: undefined,
        truncated: undefined,
      });
    });

    it('parses v0.19+ Bash toolResponse with extra fields', () => {
      const meta = {
        claudeCode: {
          toolName: 'Bash',
          toolResponse: {
            stdout: 'output\n',
            stderr: '',
            interrupted: false,
            isImage: false,
            noOutputExpected: false,
            backgroundTaskId: 'bg-123',
            returnCodeInterpretation: 'success',
          },
        },
      };
      const result = parseClaudeCodeTerminalOutput(meta);
      expect(result).toEqual({
        stdout: 'output\n',
        stderr: '',
        exitCode: undefined,
        truncated: undefined,
      });
    });

    it('returns null for v0.19+ non-Bash toolResponse (no stdout/stderr)', () => {
      // Read tool has {type, file: {filePath, content, ...}} format
      const meta = {
        claudeCode: {
          toolName: 'Read',
          toolResponse: {
            type: 'text',
            file: { filePath: '/path/to/file.ts', content: 'code', numLines: 10 },
          },
        },
      };
      const result = parseClaudeCodeTerminalOutput(meta);
      expect(result).toBeNull();
    });
  });

  describe('isClaudeCodeTool', () => {
    it('returns true for Claude Code meta', () => {
      const meta = {
        claudeCode: {
          toolName: 'mcp__acp__Bash',
        },
      };
      expect(isClaudeCodeTool(meta)).toBe(true);
    });

    it('returns false for missing claudeCode', () => {
      expect(isClaudeCodeTool({})).toBe(false);
      expect(isClaudeCodeTool({ other: 'value' })).toBe(false);
    });

    it('returns false for invalid input', () => {
      expect(isClaudeCodeTool(null)).toBe(false);
      expect(isClaudeCodeTool(undefined)).toBe(false);
      expect(isClaudeCodeTool('string')).toBe(false);
    });
  });

  describe('getClaudeCodeToolName', () => {
    it('returns tool name from meta', () => {
      const meta = {
        claudeCode: {
          toolName: 'mcp__acp__Read',
        },
      };
      expect(getClaudeCodeToolName(meta)).toBe('mcp__acp__Read');
    });

    it('returns undefined for missing toolName', () => {
      const meta = {
        claudeCode: {},
      };
      expect(getClaudeCodeToolName(meta)).toBeUndefined();
    });

    it('returns undefined for invalid input', () => {
      expect(getClaudeCodeToolName(null)).toBeUndefined();
      expect(getClaudeCodeToolName(undefined)).toBeUndefined();
    });
  });

  describe('buildMessageContentFromNotification with Claude Code', () => {
    it('extracts terminal output from _meta.claudeCode.toolResponse', () => {
      // This is the actual notification format from Claude Code
      const notification = {
        sessionId: 'session-test',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'toolu_test',
          _meta: {
            claudeCode: {
              toolResponse: [
                {
                  type: 'text',
                  text: 'Exited with code 0.Final output:\n\nHello from terminal\n',
                },
              ],
              toolName: 'mcp__acp__Bash',
            },
          },
        },
      } as unknown as SessionNotification;

      const contents = buildMessageContentFromNotification(notification);
      expect(contents).toHaveLength(1);

      const toolCall = contents[0];
      expect(toolCall).toBeDefined();
      expect(toolCall?.type).toBe('tool_call');

      if (toolCall?.type === 'tool_call') {
        expect(toolCall.content).toBeDefined();
        const terminalOutput = toolCall.content?.find((c) => c.type === 'terminal_output');
        expect(terminalOutput).toBeDefined();
        if (terminalOutput?.type === 'terminal_output') {
          expect(terminalOutput.output).toBe('Hello from terminal\n');
          expect(terminalOutput.exitStatus?.exitCode).toBe(0);
        }
      }
    });

    it('does not extract terminal output for read kind', () => {
      const notification = {
        sessionId: 'session-test',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'toolu_test',
          kind: 'read',
          _meta: {
            claudeCode: {
              toolResponse: [
                {
                  type: 'text',
                  text: 'File contents here',
                },
              ],
              toolName: 'mcp__acp__Read',
            },
          },
        },
      } as unknown as SessionNotification;

      const contents = buildMessageContentFromNotification(notification);
      expect(contents).toHaveLength(1);

      const toolCall = contents[0];
      if (toolCall?.type === 'tool_call') {
        const terminalOutput = toolCall.content?.find((c) => c.type === 'terminal_output');
        expect(terminalOutput).toBeUndefined();
      }
    });

    it('merges terminal output from Claude Code into existing tool call in history', () => {
      // Simulate the actual flow of Claude Code notifications (legacy format)
      const notifications: SessionNotification[] = [
        // First: tool_call with command
        {
          sessionId: 'session-test',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'toolu_bash',
            kind: 'execute',
            status: 'pending',
            title: '`echo "Hello"`',
            rawInput: {
              command: 'echo "Hello"',
              description: 'Print Hello',
              timeout: 5000,
            },
            content: [
              {
                type: 'content',
                content: { type: 'text', text: 'Print Hello' },
              },
            ],
            _meta: {
              claudeCode: {
                toolName: 'mcp__acp__Bash',
              },
            },
          },
        } as unknown as SessionNotification,
        // Second: tool_call_update with terminal id (in_progress)
        {
          sessionId: 'session-test',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'toolu_bash',
            status: 'in_progress',
            title: 'Print Hello',
            content: [
              {
                type: 'terminal',
                terminalId: 'term-123',
              },
            ],
          },
        } as unknown as SessionNotification,
        // Third: tool_call_update with output in _meta
        {
          sessionId: 'session-test',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'toolu_bash',
            _meta: {
              claudeCode: {
                toolResponse: [
                  {
                    type: 'text',
                    text: 'Exited with code 0.Final output:\n\nHello\n',
                  },
                ],
                toolName: 'mcp__acp__Bash',
              },
            },
          },
        } as unknown as SessionNotification,
        // Fourth: tool_call_update marking completed
        {
          sessionId: 'session-test',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'toolu_bash',
            status: 'completed',
            _meta: {
              claudeCode: {
                toolName: 'mcp__acp__Bash',
              },
            },
          },
        } as unknown as SessionNotification,
      ];

      const history: SessionHistoryInput[] = [];
      const result = applyNotificationOnHistory(history, notifications);

      expect(result).toHaveLength(1);
      const entry = result[0];
      expect(entry?.role).toBe('assistant');

      const items = entry?.items as MessageContent[];
      const toolCall = items.find((i) => i.type === 'tool_call') as Extract<
        MessageContent,
        { type: 'tool_call' }
      >;

      expect(toolCall).toBeDefined();
      expect(toolCall.status).toBe('completed');
      expect(toolCall.content).toBeDefined();

      // Check for terminal_command
      const terminalCommand = toolCall.content?.find((c) => c.type === 'terminal_command');
      expect(terminalCommand).toBeDefined();
      if (terminalCommand?.type === 'terminal_command') {
        expect(terminalCommand.command).toBe('echo "Hello"');
      }

      // Check for terminal_output
      const terminalOutput = toolCall.content?.find((c) => c.type === 'terminal_output');
      expect(terminalOutput).toBeDefined();
      if (terminalOutput?.type === 'terminal_output') {
        expect(terminalOutput.output).toBe('Hello\n');
        expect(terminalOutput.exitStatus?.exitCode).toBe(0);
      }
    });

    it('handles v0.19+ Claude Code notification flow with {stdout, stderr} toolResponse', () => {
      // Simulate the v0.19+ 3-notification pattern from real ACP logs
      const notifications: SessionNotification[] = [
        // 1. tool_call with command in rawInput
        {
          sessionId: 'session-test',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'toolu_v19',
            kind: 'execute',
            status: 'pending',
            title: 'wc -l file.ts',
            rawInput: {
              command: 'wc -l file.ts',
              description: 'Count lines',
            },
            content: [{ type: 'content', content: { type: 'text', text: 'Count lines' } }],
            _meta: { claudeCode: { toolName: 'Bash' } },
          },
        } as unknown as SessionNotification,
        // 2. tool_call_update with toolResponse in _meta (stdout/stderr)
        {
          sessionId: 'session-test',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'toolu_v19',
            _meta: {
              claudeCode: {
                toolName: 'Bash',
                toolResponse: {
                  stdout: '  42 file.ts\n',
                  stderr: '',
                  interrupted: false,
                  isImage: false,
                  noOutputExpected: false,
                },
              },
            },
          },
        } as unknown as SessionNotification,
        // 3. tool_call_update completed with rawOutput (plain string)
        {
          sessionId: 'session-test',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'toolu_v19',
            status: 'completed',
            rawOutput: '  42 file.ts\n',
            _meta: { claudeCode: { toolName: 'Bash' } },
            content: [
              {
                type: 'content',
                content: { type: 'text', text: '```console\n  42 file.ts\n```' },
              },
            ],
          },
        } as unknown as SessionNotification,
      ];

      const history: SessionHistoryInput[] = [];
      const result = applyNotificationOnHistory(history, notifications);

      expect(result).toHaveLength(1);
      const items = result[0]?.items as MessageContent[];
      const toolCall = items.find((i) => i.type === 'tool_call') as Extract<
        MessageContent,
        { type: 'tool_call' }
      >;

      expect(toolCall).toBeDefined();
      expect(toolCall.status).toBe('completed');

      // terminal_command from rawInput
      const cmd = toolCall.content?.find((c) => c.type === 'terminal_command');
      expect(cmd).toBeDefined();
      if (cmd?.type === 'terminal_command') {
        expect(cmd.command).toBe('wc -l file.ts');
      }

      // terminal_output from _meta.claudeCode.toolResponse.stdout
      const output = toolCall.content?.find((c) => c.type === 'terminal_output');
      expect(output).toBeDefined();
      if (output?.type === 'terminal_output') {
        expect(output.output).toBe('  42 file.ts\n');
      }
    });

    it('handles v0.19+ rawInput arriving in tool_call_update (not initial tool_call)', () => {
      // ~14% of Bash calls and ALL Edit calls have rawInput only in tool_call_update
      const notifications: SessionNotification[] = [
        // 1. tool_call with empty rawInput
        {
          sessionId: 'session-test',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'toolu_late_input',
            kind: 'execute',
            status: 'pending',
            title: 'git status',
            rawInput: {},
            _meta: { claudeCode: { toolName: 'Bash' } },
          },
        } as unknown as SessionNotification,
        // 2. tool_call_update with rawInput (late arrival)
        {
          sessionId: 'session-test',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'toolu_late_input',
            rawInput: {
              command: 'git status',
              description: 'Show working tree status',
            },
            _meta: { claudeCode: { toolName: 'Bash' } },
          },
        } as unknown as SessionNotification,
        // 3. completion
        {
          sessionId: 'session-test',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'toolu_late_input',
            status: 'completed',
            rawOutput: 'On branch main\n',
            _meta: { claudeCode: { toolName: 'Bash' } },
          },
        } as unknown as SessionNotification,
      ];

      const history: SessionHistoryInput[] = [];
      const result = applyNotificationOnHistory(history, notifications);

      const items = result[0]?.items as MessageContent[];
      const toolCall = items.find((i) => i.type === 'tool_call') as Extract<
        MessageContent,
        { type: 'tool_call' }
      >;

      // terminal_command should be extracted from the late rawInput
      const cmd = toolCall.content?.find((c) => c.type === 'terminal_command');
      expect(cmd).toBeDefined();
      if (cmd?.type === 'terminal_command') {
        expect(cmd.command).toBe('git status');
      }

      // terminal_output from rawOutput (plain string fallback)
      const output = toolCall.content?.find((c) => c.type === 'terminal_output');
      expect(output).toBeDefined();
      if (output?.type === 'terminal_output') {
        expect(output.output).toBe('On branch main\n');
      }
    });
  });
});
