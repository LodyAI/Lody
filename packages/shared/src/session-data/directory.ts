import { normalizeSessionTurnInputConfig } from '../message-schemas';
import { SESSION_DIRECTORY_INPUT_CONFIG_KEYS, type SessionDirectoryScalars } from './domain';

// # Shallow directory projection
//
// A directory row carries enough to render the turn's index entry and to send
// with the correct sticky Role, without materializing the turn body. The scalar
// list and the send-config key list live in `domain.ts`; this module turns a
// shallow record (a Loro map's `getShallowValue()`, or a stored domain turn)
// into those fields so every adapter projects the same shape.

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Shallow scalars from a record-shaped turn, or `undefined` when it has no id/role. */
export function pickDirectoryScalars(source: unknown): SessionDirectoryScalars | undefined {
  if (!record(source)) return undefined;
  const { id, role } = source;
  if (typeof id !== 'string' || typeof role !== 'string') return undefined;
  const scalars: Record<string, unknown> = {
    id,
    role,
    timestamp: typeof source.timestamp === 'string' ? source.timestamp : '',
  };
  if (typeof source.status === 'string') scalars.status = source.status;
  if (typeof source.finished === 'boolean') scalars.finished = source.finished;
  if (typeof source.endedAt === 'number') scalars.endedAt = source.endedAt;
  if (source.sendStatus === 'timeout') scalars.sendStatus = 'timeout';
  if (typeof source.userTurnId === 'string') scalars.userTurnId = source.userTurnId;
  if (typeof source.acpTurnId === 'string') scalars.acpTurnId = source.acpTurnId;
  if (typeof source.startedAt === 'number') scalars.startedAt = source.startedAt;
  if (typeof source.permissionWaitMs === 'number') scalars.permissionWaitMs = source.permissionWaitMs;
  return scalars as SessionDirectoryScalars;
}

/**
 * The body-independent send configuration: the declared subset only, with the
 * selection/option collections normalized. Never the prompt or input blocks.
 */
export function pickDirectoryInputConfig(source: unknown): unknown {
  if (!record(source)) return undefined;
  const picked: Record<string, unknown> = {};
  for (const key of SESSION_DIRECTORY_INPUT_CONFIG_KEYS) {
    if (source[key] !== undefined) picked[key] = source[key];
  }
  const normalized = normalizeSessionTurnInputConfig({
    mcpServerIds: picked.mcpServerIds,
    configOptionValues: picked.configOptionValues,
    taskToolsEnabled: picked.taskToolsEnabled,
    cliType: picked.cliType,
    agentType: picked.agentType,
  });
  return { ...picked, ...normalized };
}
