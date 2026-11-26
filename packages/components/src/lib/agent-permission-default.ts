import { ACP_PLAN_PERMISSION_MODE_ID, type AgentSessionDefaults } from '@lody/shared';
import type { PermissionModeFace } from '@/lib/permission-mode-face';

/** Where an agent keeps its permission, as `resolvePermissionModeFace` reports it. */
export type PermissionDefaultSource = NonNullable<PermissionModeFace['source']>;

/**
 * Whether a permission value may be a new conversation's default. Plan is
 * chosen per Turn, so a conversation never starts in it by default.
 */
export const canBePermissionDefault = (value: string): boolean =>
  value !== ACP_PLAN_PERMISSION_MODE_ID;

/** The Provider's synced default permission for new conversations, if any. */
export function readAgentPermissionDefault(
  defaults: AgentSessionDefaults | undefined,
  source: PermissionDefaultSource
): string | null {
  const value =
    source.kind === 'modeId' ? defaults?.modeId : defaults?.configOptionValues?.[source.configId];
  return typeof value === 'string' ? value : null;
}

/** Sets (or, with `null`, clears) the Provider's default permission. */
export function writeAgentPermissionDefault(
  defaults: AgentSessionDefaults | undefined,
  source: PermissionDefaultSource,
  value: string | null
): AgentSessionDefaults {
  const next: AgentSessionDefaults = {
    ...defaults,
    configOptionValues: { ...defaults?.configOptionValues },
  };
  if (source.kind === 'modeId') {
    if (value === null) delete next.modeId;
    else next.modeId = value;
  } else if (value === null) {
    delete next.configOptionValues[source.configId];
  } else {
    next.configOptionValues[source.configId] = value;
  }
  return next;
}
