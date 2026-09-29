import { describe, expect, it } from 'vitest';
import {
  buildChatFailedErrorReport,
  extractReadableChatFailedMessage,
} from '../src/components/ai-gui/chat-failed-error-report';

describe('extractReadableChatFailedMessage', () => {
  it('pulls the message out of a nested ACP error payload', () => {
    expect(
      extractReadableChatFailedMessage(
        'Internal error: API Error: 500 {"error":{"message":"Overloaded","type":"overloaded_error"}}'
      )
    ).toBe('Overloaded');
  });

  it('handles escaped quotes inside the message value', () => {
    expect(
      extractReadableChatFailedMessage(
        'API Error: 400 {"message":"Missing required parameter \\"messages\\""}'
      )
    ).toBe('Missing required parameter "messages"');
  });

  it('strips known prefixes when there is no JSON payload', () => {
    expect(extractReadableChatFailedMessage('Internal error: spawn git ENOENT')).toBe(
      'spawn git ENOENT'
    );
  });

  it('returns the original text when nothing can be extracted', () => {
    expect(extractReadableChatFailedMessage('agent exited with code 1')).toBe(
      'agent exited with code 1'
    );
  });
});

describe('buildChatFailedErrorReport', () => {
  it('lists identifying fields before the raw message', () => {
    expect(
      buildChatFailedErrorReport({
        title: 'Agent internal error',
        reason: 'acp_internal_error',
        code: 'git_executable_not_found',
        message: 'Internal error: spawn git ENOENT',
        sessionId: 'session-1',
        agentType: 'claude',
        machineId: 'machine-1',
        action: 'Install Git and try again.',
      })
    ).toBe(
      [
        'Error details: Agent internal error',
        'Reason: acp_internal_error',
        'Code: git_executable_not_found',
        'Session: session-1',
        'Agent: claude',
        'Machine: machine-1',
        'Suggested action: Install Git and try again.',
        '',
        'Internal error: spawn git ENOENT',
      ].join('\n')
    );
  });

  it('omits missing and blank fields', () => {
    expect(
      buildChatFailedErrorReport({
        title: 'Agent error',
        reason: 'acp_unknown_error',
        code: undefined,
        machineId: '   ',
        message: 'boom',
      })
    ).toBe('Error details: Agent error\nReason: acp_unknown_error\n\nboom');
  });

  it('keeps the raw message verbatim, including newlines', () => {
    const message = 'line one\nline two\n\nline four';
    expect(buildChatFailedErrorReport({ title: 'Agent error', message })).toBe(
      `Error details: Agent error\n\n${message}`
    );
  });

  it('returns only the header when there is no raw message', () => {
    expect(buildChatFailedErrorReport({ title: 'Session not found' })).toBe(
      'Error details: Session not found'
    );
  });

  it('keeps localized reports as text rather than a custom-scheme URL', () => {
    const message = '无法读取仓库\nhttps://example.com/team/repo.git\nprogress: 50%';
    const report = buildChatFailedErrorReport({
      title: '启动失败',
      reason: 'turn_pre_prompt_failed',
      sessionId: 'session-test',
      message,
    });

    expect(report).toBe(
      `Error details: 启动失败\nReason: turn_pre_prompt_failed\nSession: session-test\n\n${message}`
    );
    expect(() => new URL(report)).toThrow(TypeError);
  });
});
