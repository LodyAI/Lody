import type { NewSessionResponse } from '@agentclientprotocol/sdk';
import { readLegacySessionModelState } from '@/agent/acp-capability-normalization';

/**
 * A `NewSessionResponse` carries the agent's whole catalog: every mode, every
 * model with its description, every config option and whatever an extension put
 * under `_meta`. Pretty-printed it runs to well over a hundred lines, and the
 * daemon starts a session often enough that those dumps were the single largest
 * consumer of the log rotation window.
 *
 * The summary keeps what a session-startup investigation actually reads — which
 * session id the agent returned, and the shape of the catalog it advertised —
 * on one line. The full response stays available at `trace`.
 */

/** Keep an unusually large catalog from re-expanding the summary. */
const MAX_LISTED_IDS = 12;

const listIds = (ids: readonly string[]): string => {
  if (ids.length <= MAX_LISTED_IDS) {
    return ids.join(',');
  }
  return `${ids.slice(0, MAX_LISTED_IDS).join(',')},+${ids.length - MAX_LISTED_IDS}`;
};

export function summarizeNewSessionResponse(sessionResponse: NewSessionResponse): string {
  const modes = sessionResponse.modes;
  const configOptions = sessionResponse.configOptions ?? [];
  const legacyModels = readLegacySessionModelState(sessionResponse);
  const metaKeys = Object.keys(sessionResponse._meta ?? {});

  const parts = [
    `acpSessionId=${sessionResponse.sessionId}`,
    `modes=${modes?.availableModes.length ?? 0}`,
    `currentMode=${modes?.currentModeId ?? 'none'}`,
    `models=${legacyModels?.availableModels.length ?? 0}`,
    `currentModel=${legacyModels?.currentModelId ?? 'none'}`,
    `configOptions=${configOptions.length}`,
  ];
  if (configOptions.length > 0) {
    parts.push(`configOptionIds=${listIds(configOptions.map((option) => option.id))}`);
  }
  if (metaKeys.length > 0) {
    parts.push(`metaKeys=${listIds(metaKeys)}`);
  }
  return parts.join(' ');
}
