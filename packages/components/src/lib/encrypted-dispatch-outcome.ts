/** The host verified that the target machine's owner withdrew this member's access. */
export const E2EE_MACHINE_NOT_SHARED = 'e2ee_machine_not_shared';

export const isKnownMachineWithdrawal = (error: unknown) =>
  error instanceof Error && error.message === E2EE_MACHINE_NOT_SHARED;

/**
 * Preparation outlived the caller's deadline with no withdrawal known for the target.
 * `late` settles with the host's eventual answer and is already observed.
 */
export class EncryptedPrepareTimeout extends Error {
  constructor(readonly late: Promise<unknown>) {
    super('e2ee_rpc_prepare_timeout');
  }
}
