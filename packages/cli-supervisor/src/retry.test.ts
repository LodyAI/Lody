import { describe, expect, it } from 'vitest';
import { isAlreadyRunningOutcome } from './retry';

describe('isAlreadyRunningOutcome', () => {
  it('returns true for exit code 3', () => {
    expect(isAlreadyRunningOutcome({ code: 3, stdout: '', stderr: '' })).toBe(true);
  });

  it('returns true for port in use message with exit code 1', () => {
    expect(isAlreadyRunningOutcome({ code: 1, stdout: '', stderr: 'port is in use' })).toBe(true);
  });

  it('returns true for already running message with exit code 1', () => {
    expect(
      isAlreadyRunningOutcome({ code: 1, stdout: 'service is already running', stderr: '' })
    ).toBe(true);
  });

  it('returns false for other exit codes', () => {
    expect(isAlreadyRunningOutcome({ code: 0, stdout: '', stderr: '' })).toBe(false);
    expect(isAlreadyRunningOutcome({ code: 2, stdout: '', stderr: '' })).toBe(false);
  });

  it('returns false for exit code 1 without matching message', () => {
    expect(isAlreadyRunningOutcome({ code: 1, stdout: 'some error', stderr: '' })).toBe(false);
  });
});
