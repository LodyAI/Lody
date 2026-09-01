import {
  isSensitiveAcpConfigOptionId,
  type AcpConfigOptionValue,
  type AcpSessionNotification,
  type ACPSessionId,
  type SessionAcpRuntimeConfigPatch,
} from '@lody/shared';
import { filterAcpConfigOptions } from '@/agent/acp-config-option-filter';

const readConfigOption = (
  value: unknown
): { id: string; category?: string; currentValue: AcpConfigOptionValue } | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const option = value as Record<string, unknown>;
  if (typeof option.id !== 'string' || isSensitiveAcpConfigOptionId(option.id)) {
    return null;
  }
  if (
    (option.type !== 'select' || typeof option.currentValue !== 'string') &&
    (option.type !== 'boolean' || typeof option.currentValue !== 'boolean')
  ) {
    return null;
  }
  return {
    id: option.id,
    ...(typeof option.category === 'string' ? { category: option.category } : {}),
    currentValue: option.currentValue,
  };
};

export const getAcpRuntimeConfigPatchFromOptions = (
  acpSessionId: ACPSessionId,
  configOptions: readonly unknown[]
): SessionAcpRuntimeConfigPatch => {
  const options = filterAcpConfigOptions(
    configOptions.map(readConfigOption).filter((option) => option !== null)
  );
  const configOptionValues = Object.fromEntries(
    options.map((option) => [option.id, option.currentValue])
  );
  const mode = options.find((option) => option.category === 'mode');
  const model = options.find((option) => option.category === 'model');
  return {
    acpSessionId,
    configOptionValues,
    ...(typeof mode?.currentValue === 'string' ? { modeId: mode.currentValue } : {}),
    ...(typeof model?.currentValue === 'string' ? { modelId: model.currentValue } : {}),
  };
};

export const getAcpRuntimeConfigPatch = (
  notification: AcpSessionNotification
): SessionAcpRuntimeConfigPatch | null => {
  const update = notification.update;
  if (update.sessionUpdate === 'current_mode_update') {
    return {
      acpSessionId: notification.sessionId as ACPSessionId,
      modeId: update.currentModeId,
    };
  }
  if (update.sessionUpdate !== 'config_option_update') {
    return null;
  }

  return getAcpRuntimeConfigPatchFromOptions(
    notification.sessionId as ACPSessionId,
    update.configOptions
  );
};

export const mergeAcpRuntimeConfigUpdates = (
  notifications: readonly AcpSessionNotification[]
): SessionAcpRuntimeConfigPatch | null => {
  let merged: SessionAcpRuntimeConfigPatch | null = null;
  for (const notification of notifications) {
    const patch = getAcpRuntimeConfigPatch(notification);
    if (!patch) continue;
    if (merged && merged.acpSessionId === patch.acpSessionId) {
      const previous = merged as SessionAcpRuntimeConfigPatch;
      merged = { ...previous, ...patch };
    } else {
      merged = patch;
    }
  }
  return merged;
};
