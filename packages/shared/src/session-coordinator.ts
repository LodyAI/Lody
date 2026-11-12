import type { AcpCapabilityCacheEntry } from './ai';
import { machineSupportsCoordinatorSessions } from './machine-protocol-capabilities';
import type { SessionCoordinatorMarker, SessionMeta } from './schema';

export const SESSION_COORDINATOR_MARKER: SessionCoordinatorMarker = { version: 1 };

/**
 * How a daemon must treat a conversation's coordinator marker.
 *
 * - `none`: an ordinary conversation; nothing about its prompts changes.
 * - `v1`: deliver the coordinator system prompt on every ACP session establishment.
 * - `unsupported`: a marker this build does not understand. Running it as an
 *   ordinary conversation would drop the coordinator's instructions, so execution
 *   must refuse instead.
 */
export type SessionCoordinatorKind = 'none' | 'v1' | 'unsupported';

export const readSessionCoordinatorKind = (
  meta: Pick<SessionMeta, 'coordinator'> | null | undefined
): SessionCoordinatorKind => {
  const marker: unknown = meta?.coordinator;
  if (marker === undefined || marker === null) return 'none';
  if (
    typeof marker === 'object' &&
    (marker as { version?: unknown }).version === SESSION_COORDINATOR_MARKER.version
  ) {
    return 'v1';
  }
  return 'unsupported';
};

export const isCoordinatorSession = (
  meta: Pick<SessionMeta, 'coordinator'> | null | undefined
): boolean => readSessionCoordinatorKind(meta) !== 'none';

/**
 * Whether an agent configuration may run a coordinator conversation: its runtime
 * probe must have reported standard ACP `sessionCapabilities.systemPrompt`.
 * Unknown (no probe yet, or a probe from a build that did not record the field)
 * counts as unsupported; there is no fallback that sends the prompt as user text.
 */
export const acpCapabilitySupportsCoordinator = (
  capability: Pick<AcpCapabilityCacheEntry, 'systemPrompt'> | null | undefined
): boolean => capability?.systemPrompt === true;

/** Both halves of the coordinator gate: the daemon understands the marker and the agent accepts a system prompt. */
export const canStartCoordinatorSession = (
  machine: Parameters<typeof machineSupportsCoordinatorSessions>[0],
  capability: Pick<AcpCapabilityCacheEntry, 'systemPrompt'> | null | undefined
): boolean =>
  machineSupportsCoordinatorSessions(machine) && acpCapabilitySupportsCoordinator(capability);
