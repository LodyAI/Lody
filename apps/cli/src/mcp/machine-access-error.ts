import { MachineAccessVerificationError } from '@/session/session-access-retry';

export interface MachineAccessMcpError {
  readonly code: MachineAccessVerificationError['code'];
  readonly message: string;
  readonly retryable: boolean;
}

export const toMachineAccessMcpError = (error: unknown): MachineAccessMcpError | null =>
  error instanceof MachineAccessVerificationError
    ? { code: error.code, message: error.message, retryable: error.retryable }
    : null;
