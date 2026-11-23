import { describe, expect, it } from 'vitest';
import { MachineAccessVerificationError } from '@/session/session-access-retry';
import { toMachineAccessMcpError } from './machine-access-error';

describe('toMachineAccessMcpError', () => {
  it('preserves the retryable access error contract', () => {
    const error = new MachineAccessVerificationError(
      true,
      4,
      Object.assign(new Error('socket closed'), { code: 'ECONNRESET' })
    );

    expect(toMachineAccessMcpError(error)).toEqual({
      code: 'MACHINE_ACCESS_UNAVAILABLE',
      message: error.message,
      retryable: true,
    });
  });

  it('ignores unrelated errors', () => {
    expect(toMachineAccessMcpError(new Error('access denied'))).toBeNull();
  });
});
