import {
  queryLocalAcpRateLimits,
  withLocalAgentProcess,
  type StartLocalAcpAgentOptions,
} from './acp-runner';
import { copilotQuotaArgs, isCopilotQuotaAgent, readCopilotQuota } from './copilot-quota';

export function queryProviderRateLimits(options: StartLocalAcpAgentOptions) {
  if (isCopilotQuotaAgent(options)) {
    return withLocalAgentProcess(
      options,
      { prepareArgs: copilotQuotaArgs, sensitiveOutput: true, sessionLabel: 'copilot-quota' },
      readCopilotQuota
    );
  }
  return queryLocalAcpRateLimits(options);
}
