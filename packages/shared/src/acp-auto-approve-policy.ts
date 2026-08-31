import type { PermissionRequestKind } from './schema';

/** Minimal ACP config option shape for permission policy evaluation. */
export type AcpPermissionPolicyConfigOption = {
  id: string;
  category?: string | null;
  type: string;
  currentValue?: string | boolean;
};

const AUTO_APPROVE_PERMISSION_MODE_VALUES = new Set([
  'always-approve',
  'yolo',
  'dontAsk',
  'agent-full-access',
  'danger-full-access',
]);

const AUTO_APPROVE_LEGACY_MODE_VALUES = new Set(['dontAsk', 'yolo', 'agent-full-access', 'danger-full-access']);

const readSelectCurrentValue = (
  options: readonly AcpPermissionPolicyConfigOption[],
  predicate: (option: AcpPermissionPolicyConfigOption) => boolean
): string | undefined => {
  const option = options.find(predicate);
  if (!option || option.type !== 'select') return undefined;
  return typeof option.currentValue === 'string' ? option.currentValue : undefined;
};

export const readAcpPermissionModeValue = (
  configOptions: readonly AcpPermissionPolicyConfigOption[]
): string | undefined =>
  readSelectCurrentValue(
    configOptions,
    (option) => option.category === '_permission' || option.id === 'permission_mode'
  ) ??
  readSelectCurrentValue(
    configOptions,
    (option) => option.category === 'mode' || option.id === 'mode'
  );

export const readAcpApprovalPolicyValue = (
  configOptions: readonly AcpPermissionPolicyConfigOption[]
): string | undefined =>
  readSelectCurrentValue(configOptions, (option) => option.id === 'approval_policy');

const isAutoApprovePermissionMode = (mode: string | undefined): boolean =>
  mode !== undefined && AUTO_APPROVE_PERMISSION_MODE_VALUES.has(mode);

const isAutoApproveLegacyMode = (mode: string | undefined): boolean =>
  mode !== undefined && AUTO_APPROVE_LEGACY_MODE_VALUES.has(mode);

/**
 * Returns true when the session run config opts the user out of manual tool
 * approval. Grok/Kimi publish `_permission`; Codex/Claude publish `mode`.
 * Codex may also expose `approval_policy=never`.
 *
 * Deliberately excludes classifier-driven modes (`auto`, `agent-auto-review`)
 * and AskUserQuestion prompts, which remain interactive even under permissive
 * session modes.
 */
export const shouldAutoApproveAcpToolPermission = (args: {
  configOptions: readonly AcpPermissionPolicyConfigOption[];
  requestKind: PermissionRequestKind;
}): boolean => {
  if (args.requestKind === 'ask_user_question') {
    return false;
  }

  const permissionMode = readSelectCurrentValue(
    args.configOptions,
    (option) => option.category === '_permission' || option.id === 'permission_mode'
  );
  if (permissionMode === 'auto') {
    return false;
  }
  if (isAutoApprovePermissionMode(permissionMode)) {
    return true;
  }

  const legacyMode = readSelectCurrentValue(
    args.configOptions,
    (option) => option.category === 'mode' || option.id === 'mode'
  );
  if (legacyMode === 'auto' || legacyMode === 'agent-auto-review') {
    return false;
  }
  if (isAutoApproveLegacyMode(legacyMode)) {
    return true;
  }

  const approvalPolicy = readAcpApprovalPolicyValue(args.configOptions);
  return approvalPolicy === 'never';
};
