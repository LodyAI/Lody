const LODY_SUPERVISOR_PID_ENV = 'LODY_SUPERVISOR_PID';
const LODY_SUPERVISOR_INSTANCE_ID_ENV = 'LODY_SUPERVISOR_INSTANCE_ID';
const LODY_SUPERVISOR_TOKEN_ENV = 'LODY_SUPERVISOR_TOKEN';
const LODY_SUPERVISOR_CONTRACT_ENV = 'LODY_SUPERVISOR_CONTRACT';

const LOCAL_CLI_SUPERVISOR_CONTRACT_VERSION = '3';

const CLI_EXIT_CODE_RETRYABLE_STARTUP = 2;
const CLI_EXIT_CODE_REMOTE_RESTART = 42;
const CLI_EXIT_CODE_REMOTE_UPGRADE = 43;
const CLI_EXIT_CODE_AUTH_FAILURE = 44;
const CLI_EXIT_CODE_SUPERVISOR_CONTRACT_MISMATCH = 45;

function isLocalCliSupervisorShutdownMessage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return (
    value.type === 'lody/supervisor-shutdown' &&
    typeof value.instanceId === 'string' &&
    value.instanceId.length > 0 &&
    typeof value.token === 'string' &&
    value.token.length > 0
  );
}

module.exports = {
  LODY_SUPERVISOR_PID_ENV,
  LODY_SUPERVISOR_INSTANCE_ID_ENV,
  LODY_SUPERVISOR_TOKEN_ENV,
  LODY_SUPERVISOR_CONTRACT_ENV,
  LOCAL_CLI_SUPERVISOR_CONTRACT_VERSION,
  CLI_EXIT_CODE_RETRYABLE_STARTUP,
  CLI_EXIT_CODE_REMOTE_RESTART,
  CLI_EXIT_CODE_REMOTE_UPGRADE,
  CLI_EXIT_CODE_AUTH_FAILURE,
  CLI_EXIT_CODE_SUPERVISOR_CONTRACT_MISMATCH,
  isLocalCliSupervisorShutdownMessage,
};
