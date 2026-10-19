export const LODY_SUPERVISOR_PID_ENV = 'LODY_SUPERVISOR_PID';
export const LODY_SUPERVISOR_INSTANCE_ID_ENV = 'LODY_SUPERVISOR_INSTANCE_ID';
export const LODY_SUPERVISOR_TOKEN_ENV = 'LODY_SUPERVISOR_TOKEN';
export const LODY_SUPERVISOR_CONTRACT_ENV = 'LODY_SUPERVISOR_CONTRACT';

/**
 * Version of the Supervisor<->Worker launch contract: the identity env values,
 * the private IPC shutdown message, and the reserved exit codes below. A Worker
 * launched with a supervision marker but a different contract version must exit
 * with `CLI_EXIT_CODE_SUPERVISOR_CONTRACT_MISMATCH` instead of guessing.
 */
// v3 requires Inbox v2 without Delivery storage; earlier worker contracts are incompatible.
export const LOCAL_CLI_SUPERVISOR_CONTRACT_VERSION = '3';

/** Startup dependency is temporarily unavailable; retry without counting as a crash. */
export const CLI_EXIT_CODE_RETRYABLE_STARTUP = 2;
/** Worker exits with this after the RPC handler acknowledges a remote restart. */
export const CLI_EXIT_CODE_REMOTE_RESTART = 42;
/** Worker exits with this after the RPC handler acknowledges a remote upgrade. */
export const CLI_EXIT_CODE_REMOTE_UPGRADE = 43;
/** Credentials are missing/invalid; supervising hosts must go fatal, not crash-loop. */
export const CLI_EXIT_CODE_AUTH_FAILURE = 44;
/** The launch identity/contract failed validation; the host and worker releases are incompatible. */
export const CLI_EXIT_CODE_SUPERVISOR_CONTRACT_MISMATCH = 45;

export type LocalCliSupervisorShutdownMessage = {
  type: 'lody/supervisor-shutdown';
  instanceId: string;
  token: string;
};

export function isLocalCliSupervisorShutdownMessage(
  value: unknown
): value is LocalCliSupervisorShutdownMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === 'lody/supervisor-shutdown' &&
    typeof record.instanceId === 'string' &&
    record.instanceId.length > 0 &&
    typeof record.token === 'string' &&
    record.token.length > 0
  );
}
