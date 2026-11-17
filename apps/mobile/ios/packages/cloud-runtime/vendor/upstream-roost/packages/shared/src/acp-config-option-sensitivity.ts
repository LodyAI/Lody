const SENSITIVE_ACP_CONFIG_ID_PATTERN =
  /(?:api[_-]?key|auth|bearer|credential|password|passwd|secret|token)/i;

/**
 * Whether an ACP config option id looks like it carries a secret. Retained or
 * shared selections (Roles, schedules, RPC payloads) drop such options rather
 * than store or transmit their values.
 */
export function isSensitiveAcpConfigOptionId(configId: string): boolean {
  return SENSITIVE_ACP_CONFIG_ID_PATTERN.test(configId);
}
